// Turns Fog of World's revealed-pixel bitmaps back into lines.
//
// Per tile: rasterise the tile's blocks plus a one-block margin from its
// neighbours → morphological closing → Zhang–Suen thinning → pixel graph →
// prune spurs → chain edges into long polylines → clip to the tile's own area.
// Tiles are then stitched back together along their borders (stitch()).
//
// Only blocks that contain data (and their direct neighbours) are ever touched,
// so the cost follows the amount of data, not the tile's 8192² area.
import { BLOCKS, BLOCK_PX, TILE_PX } from './fog.js';
import { simplify } from './simplify.js';

const MARGIN_BLOCKS = 1;      // context from neighbour tiles, 64 px
const SPUR_PX = 8;            // dangling branches shorter than this (~50 m) are cut
const SPUR_ROUNDS = 3;
const STRAIGHT = -0.3;        // join edges at a junction only if they turn less than ~107°
const DIR_SAMPLE = 6;         // pixels along an edge used to estimate its direction
const BASE_EPS = 1;           // pre-simplification: the skeleton wobbles by ~0.9 px, the data's own resolution

// Scratch rasters, reused across tiles. Invariant: all zero between calls —
// only the blocks a call touched are cleared again, never the whole raster.
let bufA = new Uint8Array(0);
let bufB = new Uint8Array(0);

// Zhang–Suen deletion tables indexed by the 8-neighbourhood code:
// bit 0 = P2 (N), 1 = P3 (NE), 2 = P4 (E), 3 = P5 (SE), 4 = P6 (S), 5 = P7 (SW), 6 = P8 (W), 7 = P9 (NW).
const DEL = [new Uint8Array(256), new Uint8Array(256)];
for (let c = 0; c < 256; c++) {
  const p = (k) => (c >> k) & 1;
  let b = 0, a = 0;
  for (let k = 0; k < 8; k++) { b += p(k); if (!p(k) && p((k + 1) & 7)) a++; }
  if (b < 2 || b > 6 || a !== 1) continue;
  const [P2, P4, P6, P8] = [p(0), p(2), p(4), p(6)];
  if (!(P2 && P4 && P6) && !(P4 && P6 && P8)) DEL[0][c] = 1;
  if (!(P2 && P4 && P8) && !(P2 && P6 && P8)) DEL[1][c] = 1;
}

/**
 * @param tile      a decoded tile (fog.js readTile)
 * @param getTile   (tx, ty) → neighbouring decoded tile or undefined
 * @returns array of Int32Array polylines in global pixel coordinates [x0,y0,x1,y1,…]
 */
export function traceTile(tile, getTile) {
  // ── Grid covering the tile's occupied blocks plus margin ──
  let bx0 = BLOCKS, by0 = BLOCKS, bx1 = -1, by1 = -1;
  for (let i = 0; i < tile.index.length; i++) {
    if (tile.index[i] < 0) continue;
    const bx = i % BLOCKS, by = (i / BLOCKS) | 0;
    if (bx < bx0) bx0 = bx; if (bx > bx1) bx1 = bx;
    if (by < by0) by0 = by; if (by > by1) by1 = by;
  }
  if (bx1 < 0) return [];
  const gbx0 = tile.x * BLOCKS + bx0 - MARGIN_BLOCKS;
  const gby0 = tile.y * BLOCKS + by0 - MARGIN_BLOCKS;
  const BW = bx1 - bx0 + 1 + 2 * MARGIN_BLOCKS;
  const BH = by1 - by0 + 1 + 2 * MARGIN_BLOCKS;
  const W = BW * BLOCK_PX + 2;   // 1 px zero padding all round
  const H = BH * BLOCK_PX + 2;
  const ox = gbx0 * BLOCK_PX - 1; // global pixel of grid column 0
  const oy = gby0 * BLOCK_PX - 1;
  const size = W * H;
  if (bufA.length < size) { bufA = new Uint8Array(size); bufB = new Uint8Array(size); }
  const A = bufA, B = bufB;

  // ── Rasterise ──
  const occupied = new Uint8Array(BW * BH);
  for (let by = 0; by < BH; by++) {
    for (let bx = 0; bx < BW; bx++) {
      const gbx = gbx0 + bx, gby = gby0 + by;
      if (gbx < 0 || gby < 0) continue;
      const src = (gbx >> 7) === tile.x && (gby >> 7) === tile.y ? tile : getTile(gbx >> 7, gby >> 7);
      if (!src) continue;
      const off = src.index[(gby & (BLOCKS - 1)) * BLOCKS + (gbx & (BLOCKS - 1))];
      if (off < 0) continue;
      occupied[by * BW + bx] = 1;
      const data = src.data;
      const base = (1 + by * BLOCK_PX) * W + 1 + bx * BLOCK_PX;
      for (let py = 0; py < BLOCK_PX; py++) {
        const row = base + py * W;
        for (let bi = 0; bi < 8; bi++) {
          const byte = data[off + py * 8 + bi];
          if (!byte) continue;
          for (let k = 0; k < 8; k++) if ((byte >> (7 - k)) & 1) A[row + bi * 8 + k] = 1;
        }
      }
    }
  }
  // Only occupied blocks are ever processed. A 3×3 closing cannot add pixels to
  // an empty 64 px block, so the dilation merely needs a 1 px apron round each
  // occupied block, which the erosion then reads.
  const occ = [];
  for (let k = 0; k < occupied.length; k++) if (occupied[k]) occ.push((1 + ((k / BW) | 0) * BLOCK_PX) * W + 1 + (k % BW) * BLOCK_PX);

  // ── Closing (3×3): fills pinholes inside wide, many-times-travelled strips,
  //    which would otherwise thin into ladders of tiny loops. ──
  for (const base of occ) {
    for (let py = -1; py <= BLOCK_PX; py++) {
      for (let i = base + py * W - 1, e = i + BLOCK_PX + 2; i < e; i++) {
        B[i] = A[i] | A[i - 1] | A[i + 1] | A[i - W] | A[i + W] | A[i - W - 1] | A[i - W + 1] | A[i + W - 1] | A[i + W + 1];
      }
    }
  }
  let fg = [];
  for (const base of occ) {
    for (let py = 0; py < BLOCK_PX; py++) {
      for (let i = base + py * W, e = i + BLOCK_PX; i < e; i++) {
        const v = B[i] & B[i - 1] & B[i + 1] & B[i - W] & B[i + W] & B[i - W - 1] & B[i - W + 1] & B[i + W - 1] & B[i + W + 1];
        A[i] = v;
        if (v) fg.push(i);
      }
    }
  }

  // ── Zhang–Suen thinning over the foreground list ──
  const code = (i) =>
    A[i - W] | (A[i - W + 1] << 1) | (A[i + 1] << 2) | (A[i + W + 1] << 3) |
    (A[i + W] << 4) | (A[i + W - 1] << 5) | (A[i - 1] << 6) | (A[i - W - 1] << 7);
  const del = [];
  for (let changed = true; changed;) {
    changed = false;
    for (let step = 0; step < 2; step++) {
      const table = DEL[step];
      del.length = 0;
      for (let k = 0; k < fg.length; k++) if (table[code(fg[k])]) del.push(fg[k]);
      if (del.length) {
        changed = true;
        for (let k = 0; k < del.length; k++) A[del[k]] = 0;
        fg = fg.filter((i) => A[i]);
      }
    }
  }

  // ── Pixel graph. A diagonal step only counts when no orthogonal detour exists;
  //    otherwise every staircase corner would look like a junction. ──
  const nb = (i, out) => {
    out.length = 0;
    const n = A[i - W], s = A[i + W], e = A[i + 1], w = A[i - 1];
    if (n) out.push(i - W);
    if (e) out.push(i + 1);
    if (s) out.push(i + W);
    if (w) out.push(i - 1);
    if (A[i - W + 1] && !n && !e) out.push(i - W + 1);
    if (A[i + W + 1] && !s && !e) out.push(i + W + 1);
    if (A[i + W - 1] && !s && !w) out.push(i + W - 1);
    if (A[i - W - 1] && !n && !w) out.push(i - W - 1);
    return out;
  };
  const tmp = [];
  const DEG = B; // reuse: only read at skeleton pixels, which are all written here
  for (const i of fg) DEG[i] = nb(i, tmp).length;
  const isNode = (i) => DEG[i] !== 2;

  const edges = [];
  const direct = new Set();
  const nbs = [];
  const walk = (a, b) => {
    const line = [a, b];
    if (isNode(b)) {
      const key = a < b ? a * 2 ** 27 + b : b * 2 ** 27 + a;
      if (direct.has(key)) return;
      direct.add(key);
      edges.push(line);
      return;
    }
    let prev = a, cur = b;
    for (;;) {
      A[cur] = 2; // visited interior pixel
      nb(cur, nbs);
      const next = nbs[0] === prev ? nbs[1] : nbs[0];
      if (next === undefined) break;
      line.push(next);
      if (isNode(next) || A[next] === 2) break;
      prev = cur;
      cur = next;
    }
    edges.push(line);
  };
  for (const i of fg) {
    if (!isNode(i)) continue;
    for (const j of [...nb(i, tmp)]) {
      if (isNode(j) || A[j] === 1) walk(i, j);
    }
  }
  for (const i of fg) {  // closed loops without any junction
    if (A[i] !== 1 || isNode(i)) continue;
    nb(i, tmp);
    const first = tmp[0];
    A[i] = 2;
    const line = [i, first];
    let prev = i, cur = first;
    while (cur !== i && A[cur] === 1) {
      A[cur] = 2;
      nb(cur, nbs);
      const next = nbs[0] === prev ? nbs[1] : nbs[0];
      if (next === undefined) break;
      line.push(next);
      prev = cur;
      cur = next;
    }
    edges.push(line);
  }

  // ── Prune spurs: short dangling branches hanging off a junction ──
  let live = edges;
  for (let round = 0; round < SPUR_ROUNDS; round++) {
    const deg = new Map();
    for (const e of live) {
      deg.set(e[0], (deg.get(e[0]) || 0) + 1);
      deg.set(e[e.length - 1], (deg.get(e[e.length - 1]) || 0) + 1);
    }
    const kept = live.filter((e) => {
      const da = deg.get(e[0]), db = deg.get(e[e.length - 1]);
      return !(e.length < SPUR_PX && ((da === 1 && db >= 3) || (db === 1 && da >= 3)));
    });
    if (kept.length === live.length) break;
    live = kept;
  }

  // ── Chain: at every node, pair up the edge ends that continue most straight ──
  const n = live.length;
  const link = new Int32Array(2 * n).fill(-1);
  const ends = new Map();
  for (let k = 0; k < n; k++) {
    const e = live[k];
    if (e[0] === e[e.length - 1] && e.length > 2) continue; // closed loop, keep alone
    for (const side of [0, 1]) {
      const node = side ? e[e.length - 1] : e[0];
      let list = ends.get(node);
      if (!list) ends.set(node, (list = []));
      list.push(2 * k + side);
    }
  }
  const direction = (end) => {
    const e = live[end >> 1];
    const last = e.length - 1;
    const from = end & 1 ? e[last] : e[0];
    const to = end & 1 ? e[Math.max(0, last - DIR_SAMPLE)] : e[Math.min(last, DIR_SAMPLE)];
    const dx = (to % W) - (from % W), dy = ((to / W) | 0) - ((from / W) | 0);
    const len = Math.hypot(dx, dy) || 1;
    return [dx / len, dy / len];
  };
  for (const list of ends.values()) {
    if (list.length < 2) continue;
    if (list.length === 2) {
      if ((list[0] >> 1) !== (list[1] >> 1)) { link[list[0]] = list[1]; link[list[1]] = list[0]; }
      continue;
    }
    const dirs = list.map(direction);
    const pairs = [];
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        if ((list[a] >> 1) === (list[b] >> 1)) continue;
        const dot = dirs[a][0] * dirs[b][0] + dirs[a][1] * dirs[b][1];
        if (dot < STRAIGHT) pairs.push([dot, list[a], list[b]]);
      }
    }
    pairs.sort((p, q) => p[0] - q[0]);
    for (const [, ea, eb] of pairs) {
      if (link[ea] >= 0 || link[eb] >= 0) continue;
      link[ea] = eb;
      link[eb] = ea;
    }
  }

  // Restore the all-zero invariant of the scratch rasters.
  for (const base of occ) {
    for (let py = -1; py <= BLOCK_PX; py++) B.fill(0, base + py * W - 1, base + py * W + BLOCK_PX + 1);
    for (let py = 0; py < BLOCK_PX; py++) A.fill(0, base + py * W, base + py * W + BLOCK_PX);
  }

  // ── Assemble chains, convert to global pixels, clip to the tile itself ──
  const tx0 = tile.x * TILE_PX, ty0 = tile.y * TILE_PX;
  const out = [];
  for (const chain of assemble(n, link)) {
    const pts = [];
    for (const [k, forward] of chain) {
      const e = live[k];
      const m = e.length;
      for (let q = pts.length ? 1 : 0; q < m; q++) {
        const i = forward ? e[q] : e[m - 1 - q];
        pts.push(ox + (i % W), oy + ((i / W) | 0));
      }
    }
    let run = [];
    const flush = () => {
      if (run.length >= 4) out.push(simplify(cutCorners(run), BASE_EPS));
      run = [];
    };
    for (let q = 0; q < pts.length; q += 2) {
      const x = pts[q], y = pts[q + 1];
      if (x >= tx0 && x < tx0 + TILE_PX && y >= ty0 && y < ty0 + TILE_PX) run.push(x, y);
      else flush();
    }
    flush();
  }
  return out;
}

/**
 * The graph walk yields 4-connected staircases whose inner corners stick out by
 * up to a pixel. Dropping a corner whose neighbours touch diagonally leaves an
 * 8-connected line within half a pixel of the ideal one.
 */
function cutCorners(run) {
  const out = [run[0], run[1]];
  for (let q = 2; q < run.length - 2; q += 2) {
    const px = out[out.length - 2], py = out[out.length - 1];
    if (Math.abs(run[q + 2] - px) === 1 && Math.abs(run[q + 3] - py) === 1) continue;
    out.push(run[q], run[q + 1]);
  }
  out.push(run[run.length - 2], run[run.length - 1]);
  return Int32Array.from(out);
}

/**
 * Walks `link` (end → paired end, -1 if free; end = 2·piece + side, side 0 = start)
 * and returns chains as [[pieceIndex, forward], …].
 */
export function assemble(n, link) {
  const seen = new Uint8Array(n);
  const chains = [];
  for (let i = 0; i < n; i++) {
    if (seen[i]) continue;
    // Walk backwards to a free end, or all the way round a loop.
    let e = 2 * i;
    for (let guard = 0; guard <= n; guard++) {
      const o = link[e];
      if (o < 0 || (o >> 1) === i) break;
      e = o ^ 1;
    }
    const chain = [];
    for (;;) {
      const k = e >> 1;
      if (seen[k]) break;
      seen[k] = 1;
      chain.push([k, (e & 1) === 0]);
      const next = link[e ^ 1];
      if (next < 0) break;
      e = next;
    }
    chains.push(chain);
  }
  return chains;
}

/**
 * Re-joins polylines that were cut at tile borders. Two ends match when they lie
 * on opposite sides of a border and at most 2 px apart along it.
 */
export function stitch(polys) {
  const n = polys.length;
  const link = new Int32Array(2 * n).fill(-1);
  const edgeEnds = new Map(); // "x,y" → [end, …] for ends touching a tile border
  const onBorder = (v) => { const r = v % TILE_PX; return r === 0 || r === TILE_PX - 1; };
  const endXY = (end) => {
    const p = polys[end >> 1];
    const q = end & 1 ? p.length - 2 : 0;
    return [p[q], p[q + 1]];
  };
  for (let e = 0; e < 2 * n; e++) {
    const [x, y] = endXY(e);
    if (!onBorder(x) && !onBorder(y)) continue;
    const key = `${x},${y}`;
    const list = edgeEnds.get(key);
    list ? list.push(e) : edgeEnds.set(key, [e]);
  }
  const candidates = [];
  for (const list of edgeEnds.values()) {
    for (const e of list) {
      const [x, y] = endXY(e);
      const tile = `${Math.floor(x / TILE_PX)},${Math.floor(y / TILE_PX)}`;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const other = edgeEnds.get(`${x + dx},${y + dy}`);
          if (!other) continue;
          for (const f of other) {
            if (f <= e || (f >> 1) === (e >> 1)) continue;
            const [fx, fy] = endXY(f);
            if (`${Math.floor(fx / TILE_PX)},${Math.floor(fy / TILE_PX)}` === tile) continue;
            candidates.push([Math.max(Math.abs(dx), Math.abs(dy)), e, f]);
          }
        }
      }
    }
  }
  candidates.sort((a, b) => a[0] - b[0]);
  for (const [, e, f] of candidates) {
    if (link[e] >= 0 || link[f] >= 0) continue;
    link[e] = f;
    link[f] = e;
  }
  const out = [];
  for (const chain of assemble(n, link)) {
    if (chain.length === 1) { out.push(polys[chain[0][0]]); continue; }
    const pts = [];
    for (const [k, forward] of chain) {
      const p = polys[k];
      const m = p.length >> 1;
      for (let q = 0; q < m; q++) {
        const i = forward ? q : m - 1 - q;
        pts.push(p[2 * i], p[2 * i + 1]);
      }
    }
    out.push(Int32Array.from(pts));
  }
  return out;
}
