// Minimal ZIP support without a library: reading (stored + deflate, via the
// platform's DecompressionStream) and writing (stored — GPX is written in one go
// and compressing it again would only cost time on a phone).
import { inflate } from './fog.js';

const u16 = (v, o) => v.getUint16(o, true);
const u32 = (v, o) => v.getUint32(o, true);

/**
 * Lists a ZIP's entries from its central directory. `read()` on an entry returns
 * its uncompressed bytes. Directories are skipped. Takes a Blob/File, so only the
 * central directory and the entries actually read are loaded into memory.
 */
export async function readZip(blob) {
  const tailSize = Math.min(blob.size, 65557);
  const tail = new DataView(await blob.slice(blob.size - tailSize).arrayBuffer());
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (u32(tail, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip');
  const count = u16(tail, eocd + 10);
  const dirSize = u32(tail, eocd + 12);
  const dirOffset = u32(tail, eocd + 16);
  if (dirOffset === 0xffffffff || count === 0xffff) throw new Error('zip64 not supported');

  const dir = new DataView(await blob.slice(dirOffset, dirOffset + dirSize).arrayBuffer());
  const decoder = new TextDecoder();
  const entries = [];
  for (let p = 0, n = 0; n < count; n++) {
    if (u32(dir, p) !== 0x02014b50) throw new Error('broken central directory');
    const method = u16(dir, p + 10);
    const compressedSize = u32(dir, p + 20);
    const nameLen = u16(dir, p + 28);
    const extraLen = u16(dir, p + 30);
    const commentLen = u16(dir, p + 32);
    const localOffset = u32(dir, p + 42);
    const name = decoder.decode(new Uint8Array(dir.buffer, dir.byteOffset + p + 46, nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    entries.push({
      name,
      async read() {
        const head = new DataView(await blob.slice(localOffset, localOffset + 30).arrayBuffer());
        if (u32(head, 0) !== 0x04034b50) throw new Error('broken local header');
        const start = localOffset + 30 + u16(head, 26) + u16(head, 28);
        const raw = new Uint8Array(await blob.slice(start, start + compressedSize).arrayBuffer());
        if (method === 0) return raw;
        if (method === 8) return inflate(raw, 'deflate-raw');
        throw new Error(`unsupported zip method ${method}`);
      },
    });
  }
  return entries;
}

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
export function crc32(bytes, crc = 0) {
  let c = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

/**
 * Builds a stored (uncompressed) ZIP from [{ name, parts }] where `parts` is an
 * array of Uint8Array chunks. Returns a Blob; the chunks are referenced, not copied.
 */
export function writeZip(files, date = new Date()) {
  const encoder = new TextEncoder();
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const out = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    const name = encoder.encode(file.name);
    let size = 0;
    let crc = 0;
    for (const part of file.parts) { crc = crc32(part, crc); size += part.length; }
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true);          // UTF-8 names
    local.setUint16(8, 0, true);               // stored
    local.setUint16(10, dosTime, true);
    local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, name.length, true);
    out.push(local, name, ...file.parts);

    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(8, 0x0800, true);
    entry.setUint16(12, dosTime, true);
    entry.setUint16(14, dosDate, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, size, true);
    entry.setUint32(24, size, true);
    entry.setUint16(28, name.length, true);
    entry.setUint32(42, offset, true);
    central.push(entry, name);
    offset += 30 + name.length + size;
  }

  const dirSize = central.reduce((s, c) => s + c.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, dirSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...out, ...central, end], { type: 'application/zip' });
}
