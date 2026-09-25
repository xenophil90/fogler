// Fog of World sync format: one zlib-compressed file per map tile.
// Layout as reverse-engineered by fog-machine (github.com/CaviarChen/fog-machine)
// and verified against real sync data:
//
//   world    512 × 512 tiles (Web Mercator, zoom 9)
//   tile     128 × 128 blocks, file = u16 LE block index table, then 515 bytes per block
//   block    64 × 64 pixel bitmap (512 bytes, row-major, MSB first) + 3 unknown bytes
//   pixel    1 / 2^22 of the world's circumference — ≈ 9.5 m at the equator
//
// Everything below works in "global pixel" coordinates: x, y ∈ [0, 2^22).

export const TILES = 512;
export const BLOCKS = 128;            // per tile edge
export const BLOCK_PX = 64;           // per block edge
export const TILE_PX = BLOCKS * BLOCK_PX;           // 8192
export const WORLD_PX = TILES * TILE_PX;            // 2^22
export const WORLD_BLOCKS = TILES * BLOCKS;         // 2^16
const BLOCK_BYTES = 515;
const INDEX_BYTES = BLOCKS * BLOCKS * 2;
const EARTH_CIRCUMFERENCE = 40075016.686;

const FILENAME_DIGITS = 'olhwjsktri';

/**
 * Tile id from a sync file name such as "a1b2lohsooxy": characters [4, -2) encode
 * the decimal id with the alphabet above. Returns null for anything else
 * (.DS_Store, __MACOSX entries, unrelated files).
 */
export function parseTileName(name) {
  const base = name.split('/').pop();
  if (base.length < 7 || !/^[0-9a-f]{4}[a-z]+$/.test(base)) return null;
  const code = base.slice(4, -2);
  let id = 0;
  for (const ch of code) {
    const digit = FILENAME_DIGITS.indexOf(ch);
    if (digit < 0) return null;
    id = id * 10 + digit;
  }
  if (id >= TILES * TILES) return null;
  return { id, x: id % TILES, y: Math.floor(id / TILES) };
}

/** zlib (RFC 1950) inflate via the platform — no library needed. */
export async function inflate(bytes, format = 'deflate') {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * A decoded tile: `data` is the decompressed file, `index[i]` the byte offset of
 * block i's bitmap (i = by * 128 + bx) or -1 when the block is empty.
 */
export function readTile(x, y, data) {
  if (data.length < INDEX_BYTES) throw new Error('tile too short');
  const index = new Int32Array(BLOCKS * BLOCKS);
  let blocks = 0;
  for (let i = 0; i < BLOCKS * BLOCKS; i++) {
    const n = data[2 * i] | (data[2 * i + 1] << 8);
    if (n === 0) { index[i] = -1; continue; }
    const offset = INDEX_BYTES + (n - 1) * BLOCK_BYTES;
    if (offset + 512 > data.length) throw new Error('block out of range');
    index[i] = offset;
    blocks++;
  }
  return { x, y, data, index, blocks };
}

export async function decodeTile(name, compressed) {
  const id = parseTileName(name);
  if (!id) return null;
  return readTile(id.x, id.y, await inflate(compressed));
}

/** Bit test inside one block bitmap starting at `offset`. */
export const blockPixel = (data, offset, px, py) => (data[offset + py * 8 + (px >> 3)] >> (7 - (px & 7))) & 1;

export function countPixels(tile) {
  let n = 0;
  for (let i = 0; i < tile.index.length; i++) {
    const off = tile.index[i];
    if (off < 0) continue;
    for (let b = 0; b < 512; b++) n += POPCOUNT[tile.data[off + b]];
  }
  return n;
}
const POPCOUNT = new Uint8Array(256).map((_, i) => {
  let c = 0;
  for (let v = i; v; v >>= 1) c += v & 1;
  return c;
});

// ── Projection ──────────────────────────────────────────────────────

export const pxToLon = (x) => (x / WORLD_PX) * 360 - 180;
export const pxToLat = (y) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / WORLD_PX))) * 180) / Math.PI;
export const lonToPx = (lon) => ((lon + 180) / 360) * WORLD_PX;
export function latToPx(lat) {
  const r = (Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * WORLD_PX;
}
/** Metres per global pixel at a given pixel row. */
export const metresPerPx = (y) => (EARTH_CIRCUMFERENCE / WORLD_PX) * Math.cos((pxToLat(y) * Math.PI) / 180);
