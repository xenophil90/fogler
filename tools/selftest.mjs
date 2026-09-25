// Self-test for the logic: tile names, tile decoding, ZIP, simplification,
// line reconstruction, stitching across tiles, GPX output. Runs in Node
// (`node tools/selftest.mjs`, as CI does) and in a browser (tools/selftest.html),
// where it also checks the real sample data in example/ if that folder exists.
const inBrowser = typeof window !== 'undefined';
const lines = [];
const log = (s) => { lines.push(s); if (!inBrowser) console.log(s); };

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) log(`  ok   ${name}`);
  else { failures++; log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

const root = new URL('../public/', import.meta.url);
const load = (p) => import(new URL(p, root).href);
const fog = await load('js/fog.js');
const { readZip, writeZip, crc32 } = await load('js/zip.js');
const { simplify } = await load('js/simplify.js');
const { traceTile, stitch } = await load('js/skeleton.js');
const { writeGpx, lineMetres, timelineEnd, Clock } = await load('js/gpx.js');

// Builds an uncompressed tile file from a pixel predicate over tile-local pixels.
function makeTile(tx, ty, isSet) {
  const blocks = [];
  const index = new Uint8Array(128 * 128 * 2);
  for (let by = 0; by < 128; by++) {
    for (let bx = 0; bx < 128; bx++) {
      const bm = new Uint8Array(515);
      let any = false;
      for (let py = 0; py < 64; py++) {
        for (let px = 0; px < 64; px++) {
          if (isSet(bx * 64 + px, by * 64 + py)) { bm[py * 8 + (px >> 3)] |= 1 << (7 - (px & 7)); any = true; }
        }
      }
      if (!any) continue;
      blocks.push(bm);
      const i = by * 128 + bx;
      index[2 * i] = blocks.length & 0xff;
      index[2 * i + 1] = blocks.length >> 8;
    }
  }
  const data = new Uint8Array(index.length + blocks.length * 515);
  data.set(index);
  blocks.forEach((b, k) => data.set(b, index.length + k * 515));
  return fog.readTile(tx, ty, data);
}

log('tile names');
check('decodes a name', JSON.stringify(fog.parseTileName('a1b2lohsooxy')) === JSON.stringify({ id: 102500, x: 100, y: 200 }));
check('path prefix ignored', fog.parseTileName('Sync/a1b2lohsooxy')?.id === 102500);
check('.DS_Store rejected', fog.parseTileName('.DS_Store') === null);
check('foreign letters rejected', fog.parseTileName('a1b2zzzzzxy') === null);

log('projection');
check('lon round trip', Math.abs(fog.pxToLon(fog.lonToPx(7.1)) - 7.1) < 1e-9);
check('lat round trip', Math.abs(fog.pxToLat(fog.latToPx(45.5)) - 45.5) < 1e-9);
check('≈6 m per px at 50°N', Math.abs(fog.metresPerPx(fog.latToPx(50)) - 6.14) < 0.05);

log('zip');
const enc = new TextEncoder();
const zipBlob = writeZip([{ name: 'a.txt', parts: [enc.encode('hello ')] }, { name: 'dir/b.txt', parts: [enc.encode('wor'), enc.encode('ld')] }]);
const entries = await readZip(zipBlob);
check('two entries', entries.length === 2, String(entries.length));
check('content round trip', new TextDecoder().decode(await entries[1].read()) === 'world');
check('crc32 of "123456789"', crc32(enc.encode('123456789')) === 0xcbf43926);

log('simplify');
const straight = Int32Array.from([0, 0, 1, 0, 2, 0, 3, 0, 4, 1, 5, 0]);
check('collinear points dropped', simplify(straight, 0.5).length === 8, String(simplify(straight, 0.5)));
check('big tolerance keeps ends', simplify(straight, 5).length === 4);

log('reconstruction');
// A 5 px wide diagonal-ish stroke across one tile.
const tile = makeTile(100, 200, (x, y) => x > 1000 && x < 5000 && Math.abs(y - (2000 + (x - 1000) * 0.3)) < 2.6);
const traced = traceTile(tile, () => undefined);
check('one line for one stroke', traced.length === 1, String(traced.length));
const t0 = traced[0];
const len = Math.hypot(t0[t0.length - 2] - t0[0], t0[t0.length - 1] - t0[1]);
check('spans the stroke', len > 4000 * 1.04 - 20 && len < 4000 * 1.05, String(len));
check('pre-simplified', t0.length / 2 < 40, String(t0.length / 2));

// A stroke crossing the border between two tiles comes back as one line.
const stroke = (x, y) => Math.abs(y - 3000) < 3;
const left = makeTile(100, 200, (x, y) => x > 6000 && stroke(x, y));
const right = makeTile(101, 200, (x, y) => x < 2000 && stroke(x, y));
const get = (x, y) => (x === 100 ? left : x === 101 ? right : undefined);
const pieces = [...traceTile(left, get), ...traceTile(right, get)];
check('cut at the border', pieces.length === 2, String(pieces.length));
const joined = stitch(pieces);
check('stitched back together', joined.length === 1, String(joined.length));
const j = joined[0];
check('stitched line spans both', Math.abs(Math.abs(j[j.length - 2] - j[0]) - 4190) < 20, String(j[j.length - 2] - j[0]));

// A cross: the two straight strokes should survive as two lines, not four.
const cross = makeTile(100, 200, (x, y) => (Math.abs(y - 4000) < 3 && x > 3000 && x < 5000) || (Math.abs(x - 4000) < 3 && y > 3000 && y < 5000));
check('crossing chained straight through', traceTile(cross, () => undefined).length === 2, String(traceTile(cross, () => undefined).length));

log('gpx');
const time = { start: Date.UTC(2000, 0, 1), speedKmh: 5, gapMinutes: 61 };
const doc = new TextDecoder().decode(new Uint8Array(await new Blob(writeGpx(joined, { name: 'Test & <co>', time })).arrayBuffer()));
const times = [...doc.matchAll(/<time>([^<]+)<\/time>/g)].map((m) => Date.parse(m[1]));
check('name escaped', doc.includes('Test &amp; &lt;co&gt;'));
check('every point has a time', times.length - 1 === (doc.match(/<trkpt /g) || []).length);
check('times strictly increase', times.slice(1).every((t, i, a) => i === 0 || t > a[i - 1]));
check('first point at start', times[1] === time.start);
check('timelineEnd matches', timelineEnd(joined, time) === times[times.length - 1]);
const metres = lineMetres(joined[0]);
check('walking pace', Math.abs((times[times.length - 1] - times[1]) / 1000 - metres / (5 / 3.6)) < (joined[0].length / 2) + 2);
const clock = new Clock(time);
clock.startLine(); clock.startLine();
check('gap between lines', clock.t - time.start === 61 * 60000);
const plain = new TextDecoder().decode(new Uint8Array(await new Blob(writeGpx(joined, { name: 'x', time: null })).arrayBuffer()));
check('no times when switched off', !/<trkpt[^>]*><time>/.test(plain));

// Real data — only where example/ is available (local browser run).
if (inBrowser) {
  const res = await fetch(new URL('../example/Sync.zip', import.meta.url)).catch(() => null);
  if (res && res.ok) {
    log('sample data');
    const all = await readZip(await res.blob());
    let tiles = 0, pixels = 0, skipped = 0;
    for (const e of all) {
      if (e.name.includes('__MACOSX/') || !fog.parseTileName(e.name)) { skipped++; continue; }
      pixels += fog.countPixels(await fog.decodeTile(e.name, await e.read()));
      tiles++;
    }
    check('755 tiles', tiles === 755, String(tiles));
    check('12 525 942 pixels', pixels === 12525942, String(pixels));
  } else {
    log('sample data — skipped (example/Sync.zip not found)');
  }
}

log(failures ? `\n${failures} failure(s)` : '\nall passed');
if (!inBrowser && failures) process.exit(1);
export { lines, failures };
