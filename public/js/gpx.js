// GPX 1.1 writer. Lines arrive in global pixel coordinates; output is compact
// (one point per line, no indentation) and produced in chunks so that a
// multi-megabyte export never exists as one giant string.
import { pxToLat, pxToLon, metresPerPx } from './fog.js';

const encoder = new TextEncoder();
const CHUNK_CHARS = 1 << 20;

const escapeXml = (s) => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
const isoSeconds = (ms) => new Date(ms).toISOString().slice(0, 19) + 'Z';

/** Length of a pixel polyline in metres. */
export function lineMetres(pts) {
  let m = 0;
  for (let i = 2; i < pts.length; i += 2) {
    const dx = pts[i] - pts[i - 2], dy = pts[i + 1] - pts[i - 1];
    m += Math.hypot(dx, dy) * metresPerPx((pts[i + 1] + pts[i - 1]) / 2);
  }
  return m;
}

/**
 * Synthetic clock for importers that insist on timestamps (Dawarich drops
 * trackpoints without <time>, and splits routes only on time gaps).
 * Time advances at a constant speed along each line, at least one second per
 * point so timestamps stay unique, and jumps by `gapMinutes` between lines.
 */
export class Clock {
  constructor({ start, speedKmh, gapMinutes }) {
    this.t = Math.floor(start / 1000) * 1000;
    this.first = true;
    this.mps = Math.max(0.1, speedKmh / 3.6);
    this.gap = Math.max(1, gapMinutes) * 60000;
  }
  startLine() {
    if (!this.first) this.t += this.gap;
    this.first = false;
  }
  step(metres) {
    this.t += Math.max(1000, Math.round(metres / this.mps) * 1000);
  }
}

/** Where the synthetic timeline ends for a set of lines, without writing them. */
export function timelineEnd(lines, time) {
  const clock = new Clock(time);
  for (const pts of lines) {
    if (pts.length < 4) continue;
    clock.startLine();
    for (let i = 2; i < pts.length; i += 2) {
      clock.step(Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]) * metresPerPx(pts[i + 1]));
    }
  }
  return clock.t;
}

/**
 * @param lines   iterable of pixel polylines (Int32Array [x0,y0,…])
 * @param opts    { name, time: null | { start, speedKmh, gapMinutes }, clock? }
 * @returns array of Uint8Array chunks forming one GPX document
 */
export function writeGpx(lines, { name, time, clock }) {
  const chunks = [];
  let buf = '';
  const push = (s) => {
    buf += s;
    if (buf.length > CHUNK_CHARS) { chunks.push(encoder.encode(buf)); buf = ''; }
  };
  const now = new Date().toISOString().slice(0, 19) + 'Z';
  push('<?xml version="1.0" encoding="UTF-8"?>\n');
  push('<gpx version="1.1" creator="fogler" xmlns="http://www.topografix.com/GPX/1/1" ' +
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
    'xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">\n');
  push(`<metadata><name>${escapeXml(name)}</name><time>${now}</time></metadata>\n`);
  push(`<trk><name>${escapeXml(name)}</name><src>fogler</src>\n`);
  const c = time ? clock || new Clock(time) : null;
  for (const pts of lines) {
    if (pts.length < 4) continue;
    push('<trkseg>\n');
    if (c) c.startLine();
    for (let i = 0; i < pts.length; i += 2) {
      const lat = pxToLat(pts[i + 1] + 0.5).toFixed(6);
      const lon = pxToLon(pts[i] + 0.5).toFixed(6);
      if (c) {
        if (i > 0) {
          const dx = pts[i] - pts[i - 2], dy = pts[i + 1] - pts[i - 1];
          c.step(Math.hypot(dx, dy) * metresPerPx(pts[i + 1]));
        }
        push(`<trkpt lat="${lat}" lon="${lon}"><time>${isoSeconds(c.t)}</time></trkpt>\n`);
      } else {
        push(`<trkpt lat="${lat}" lon="${lon}"/>\n`);
      }
    }
    push('</trkseg>\n');
  }
  push('</trk>\n</gpx>\n');
  chunks.push(encoder.encode(buf));
  return chunks;
}

/** Rough size of a GPX export, for the live estimate next to the sliders. */
export const estimateBytes = (lines, points, withTime) => 420 + lines * 19 + points * (withTime ? 81 : 42);
