// Everything heavy runs here, so the page stays responsive while tens of
// thousands of kilometres of lines are reconstructed.
//
// Messages in:   load | lines | stats | export | coverage | cancel
// Messages out:  progress | loaded | lines | stats | exported | coverage | error
import { parseTileName, inflate, readTile, countPixels, metresPerPx, pxToLat, pxToLon, TILE_PX, BLOCK_PX, BLOCKS, TILES } from './fog.js';
import { readZip, writeZip } from './zip.js';
import { traceTile, stitch } from './skeleton.js';
import { simplify } from './simplify.js';
import { writeGpx, lineMetres, timelineEnd, estimateBytes, Clock } from './gpx.js';

let tiles = new Map();      // id → decoded tile
let base = [];              // stitched polylines, global px, pre-simplified
let current = [];           // after the user's simplification + min length, in timeline order
let job = 0;                // bumped on every load, so a stale run stops

const post = (msg, transfer) => self.postMessage(msg, transfer || []);
const tileKey = (x, y) => y * TILES + x;
const yieldToEvents = () => new Promise((r) => setTimeout(r, 0));

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'load') await load(msg.files);
    else if (msg.type === 'lines') makeLines(msg);
    else if (msg.type === 'stats') post({ type: 'stats', id: msg.id, ...stats(msg) });
    else if (msg.type === 'export') exportGpx(msg);
    else if (msg.type === 'coverage') coverage(msg);
    else if (msg.type === 'cancel') job++;
  } catch (err) {
    post({ type: 'error', message: String(err && err.message || err) });
  }
};

// ── Loading ────────────────────────────────────────────────────────

async function load(files) {
  const my = ++job;
  tiles = new Map();
  base = [];
  current = [];

  // Expand ZIPs into their entries; everything else is a candidate tile file.
  const entries = [];
  let skipped = 0;
  for (const file of files) {
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 3 && head[3] === 4) {
      for (const entry of await readZip(file)) {
        if (entry.name.includes('__MACOSX/')) continue;
        entries.push(entry);
      }
    } else {
      entries.push({ name: file.name, read: async () => new Uint8Array(await file.arrayBuffer()) });
    }
  }

  let pixels = 0;
  let broken = 0;
  for (let i = 0; i < entries.length; i++) {
    if (my !== job) return;
    const entry = entries[i];
    const id = parseTileName(entry.name);
    if (!id) { skipped++; continue; }
    try {
      const tile = readTile(id.x, id.y, await inflate(await entry.read()));
      const blockList = [];
      for (let b = 0; b < tile.index.length; b++) if (tile.index[b] >= 0) blockList.push(b);
      tile.blockList = Uint16Array.from(blockList);
      tiles.set(id.id, tile);
      pixels += countPixels(tile);
    } catch {
      broken++;
    }
    if (i % 25 === 0) post({ type: 'progress', phase: 'decode', done: i + 1, total: entries.length });
  }
  if (!tiles.size) {
    post({ type: 'loaded', tiles: 0, skipped, broken });
    return;
  }

  const getTile = (x, y) => tiles.get(tileKey(x, y));
  const list = [...tiles.values()];
  const traced = [];
  for (let i = 0; i < list.length; i++) {
    if (my !== job) return;
    for (const line of traceTile(list[i], getTile)) traced.push(line);
    post({ type: 'progress', phase: 'trace', done: i + 1, total: list.length });
    if (i % 10 === 9) await yieldToEvents(); // let a cancel through
  }
  post({ type: 'progress', phase: 'stitch', done: 0, total: 1 });
  base = stitch(traced);

  // Area and extent, for the summary.
  let area = 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const t of list) {
    const m = metresPerPx((t.y + 0.5) * TILE_PX);
    area += countPixels(t) * m * m;
    for (const b of t.blockList) {
      const gx = (t.x * BLOCKS + (b % BLOCKS)) * BLOCK_PX, gy = (t.y * BLOCKS + ((b / BLOCKS) | 0)) * BLOCK_PX;
      if (gx < minX) minX = gx; if (gy < minY) minY = gy;
      if (gx + BLOCK_PX > maxX) maxX = gx + BLOCK_PX; if (gy + BLOCK_PX > maxY) maxY = gy + BLOCK_PX;
    }
  }
  post({
    type: 'loaded',
    tiles: tiles.size, skipped, broken, pixels,
    areaKm2: area / 1e6,
    bounds: [[pxToLat(maxY), pxToLon(minX)], [pxToLat(minY), pxToLon(maxX)]],
  });
}

// ── Lines for the current settings ─────────────────────────────────

/** Hilbert index on a 2^16 grid: neighbouring lines end up near each other in time. */
function hilbert(x, y) {
  let d = 0;
  for (let s = 1 << 15; s > 0; s >>= 1) {
    const rx = (x & s) > 0 ? 1 : 0;
    const ry = (y & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    if (ry === 0) {
      if (rx === 1) { x = s - 1 - x; y = s - 1 - y; }
      const t = x; x = y; y = t;
    }
  }
  return d;
}

function makeLines({ id, epsMetres, minMetres }) {
  const keep = [];
  for (const line of base) {
    const mpp = metresPerPx(line[1]);
    if (lineMetres(line) < minMetres) continue;
    const s = simplify(line, epsMetres / mpp);
    keep.push({ s, h: hilbert(s[0] >> 6, s[1] >> 6) });
  }
  keep.sort((a, b) => a.h - b.h);
  current = keep.map((k) => k.s);

  // Pack for the map: one coordinate array plus offsets, transferred not copied.
  let n = 0;
  for (const l of current) n += l.length;
  const coords = new Int32Array(n);
  const offsets = new Uint32Array(current.length + 1);
  let o = 0;
  current.forEach((l, i) => { coords.set(l, o); o += l.length; offsets[i + 1] = o; });
  post({ type: 'lines', id, coords, offsets }, [coords.buffer, offsets.buffer]);
}

// ── Scope: everything, or only the visible map area ────────────────

/** Liang–Barsky clip of a polyline to a rectangle; returns the inside pieces. */
function clipLine(pts, [x0, y0, x1, y1]) {
  const pieces = [];
  let piece = null;
  const end = () => { if (piece && piece.length >= 4) pieces.push(Float64Array.from(piece)); piece = null; };
  for (let i = 2; i < pts.length; i += 2) {
    const ax = pts[i - 2], ay = pts[i - 1], bx = pts[i], by = pts[i + 1];
    const dx = bx - ax, dy = by - ay;
    let t0 = 0, t1 = 1, ok = true;
    for (const [p, q] of [[-dx, ax - x0], [dx, x1 - ax], [-dy, ay - y0], [dy, y1 - ay]]) {
      if (p === 0) { if (q < 0) { ok = false; break; } continue; }
      const r = q / p;
      if (p < 0) { if (r > t1) { ok = false; break; } if (r > t0) t0 = r; }
      else { if (r < t0) { ok = false; break; } if (r < t1) t1 = r; }
    }
    if (!ok) { end(); continue; }
    const sx = ax + t0 * dx, sy = ay + t0 * dy, ex = ax + t1 * dx, ey = ay + t1 * dy;
    if (!piece) piece = [sx, sy];
    piece.push(ex, ey);
    if (t1 < 1) end();
  }
  end();
  return pieces;
}

function scoped(rect) {
  if (!rect) return current;
  const out = [];
  for (const l of current) for (const p of clipLine(l, rect)) out.push(p);
  return out;
}

function stats({ rect, time }) {
  const lines = scoped(rect);
  let points = 0, metres = 0;
  for (const l of lines) { points += l.length >> 1; metres += lineMetres(l); }
  return {
    lines: lines.length,
    points,
    km: metres / 1000,
    bytes: estimateBytes(lines.length, points, Boolean(time)),
    timeEnd: time && lines.length ? timelineEnd(lines, time) : null,
  };
}

// ── Export ─────────────────────────────────────────────────────────

const cellName = (lat, lon) => {
  const la = Math.floor(lat), lo = Math.floor(lon);
  return `${la < 0 ? 'S' : 'N'}${String(Math.abs(la)).padStart(2, '0')}${lo < 0 ? 'W' : 'E'}${String(Math.abs(lo)).padStart(3, '0')}`;
};

function exportGpx({ rect, time, split, name, stamp }) {
  const lines = scoped(rect);
  if (!lines.length) { post({ type: 'exported', empty: true }); return; }
  const clock = time ? new Clock(time) : null;
  if (split !== 'region') {
    const blob = new Blob(writeGpx(lines, { name, time, clock }), { type: 'application/gpx+xml' });
    post({ type: 'exported', blob, filename: `fogler-${stamp}.gpx` });
    return;
  }
  const groups = new Map();
  for (const l of lines) {
    const key = cellName(pxToLat(l[1]), pxToLon(l[0]));
    const g = groups.get(key);
    g ? g.push(l) : groups.set(key, [l]);
  }
  const files = [];
  for (const key of [...groups.keys()].sort()) {
    files.push({ name: `fogler-${key}.gpx`, parts: writeGpx(groups.get(key), { name: `${name} ${key}`, time, clock }) });
  }
  post({ type: 'exported', blob: writeZip(files), filename: `fogler-${stamp}.zip`, files: files.length });
}

// ── Original revealed pixels, rendered as map tiles on demand ──────

function coverage({ id, z, x, y }) {
  const SIZE = 256;
  const out = new Uint8Array(SIZE * SIZE);
  const shift = 14 - z;                   // global px per output px = 2^shift
  const scale = 2 ** shift;
  const gx0 = x * SIZE * scale, gy0 = y * SIZE * scale;
  const span = SIZE * scale;
  const tx0 = Math.max(0, Math.floor(gx0 / TILE_PX)), tx1 = Math.min(TILES - 1, Math.floor((gx0 + span - 1) / TILE_PX));
  const ty0 = Math.max(0, Math.floor(gy0 / TILE_PX)), ty1 = Math.min(TILES - 1, Math.floor((gy0 + span - 1) / TILE_PX));
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const tile = tiles.get(tileKey(tx, ty));
      if (!tile) continue;
      for (const b of tile.blockList) {
        const bx = (tx * BLOCKS + (b % BLOCKS)) * BLOCK_PX, by = (ty * BLOCKS + ((b / BLOCKS) | 0)) * BLOCK_PX;
        if (bx + BLOCK_PX <= gx0 || by + BLOCK_PX <= gy0 || bx >= gx0 + span || by >= gy0 + span) continue;
        if (scale >= BLOCK_PX) { // a whole block fits inside one output pixel
          out[Math.floor((by - gy0) / scale) * SIZE + Math.floor((bx - gx0) / scale)] = 255;
          continue;
        }
        const off = tile.index[b];
        for (let py = 0; py < BLOCK_PX; py++) {
          for (let px = 0; px < BLOCK_PX; px++) {
            if (!((tile.data[off + py * 8 + (px >> 3)] >> (7 - (px & 7))) & 1)) continue;
            const ox = (bx + px - gx0) / scale, oy = (by + py - gy0) / scale;
            if (scale >= 1) {
              if (ox >= 0 && oy >= 0 && ox < SIZE && oy < SIZE) out[(oy | 0) * SIZE + (ox | 0)] = 255;
            } else { // zoomed in past the data: one source pixel covers a square
              const w = 1 / scale;
              for (let qy = Math.max(0, oy); qy < Math.min(SIZE, oy + w); qy++) {
                for (let qx = Math.max(0, ox); qx < Math.min(SIZE, ox + w); qx++) out[qy * SIZE + qx] = 255;
              }
            }
          }
        }
      }
    }
  }
  post({ type: 'coverage', id, alpha: out }, [out.buffer]);
}
