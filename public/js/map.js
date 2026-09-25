// Map preview. Leaflet (vendored, no CDN) with two canvas grid layers of our own:
// the reconstructed lines, and optionally the original revealed pixels. Tens of
// thousands of polylines as individual Leaflet layers would crawl; drawing them
// per map tile from a coarse spatial index stays smooth.
import * as L from '../vendor/leaflet/leaflet-src.esm.js';
import { WORLD_PX, TILE_PX, lonToPx, latToPx } from './fog.js';

const LINE_COLOR = '#34e0a1';
const COVERAGE_RGB = [180, 170, 255];
const CELL = TILE_PX; // spatial index cell, in global pixels

export function createMap(el, { requestCoverage, onMove }) {
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const map = L.map(el, {
    zoomControl: true, worldCopyJump: false, preferCanvas: true, keyboard: true,
    zoomAnimation: !still, fadeAnimation: !still, inertia: !still,
  });
  map.attributionControl.setPrefix(false);

  const basemap = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    className: 'basemap',
    attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a>',
  });

  // ── Lines ──
  let coords = new Int32Array(0);
  let offsets = new Uint32Array(1);
  let index = new Map();
  let stamp = new Uint32Array(0);
  let generation = 0;

  const LinesLayer = L.GridLayer.extend({
    createTile(c) {
      const dpr = window.devicePixelRatio || 1;
      const size = this.getTileSize();
      const canvas = document.createElement('canvas');
      canvas.width = size.x * dpr;
      canvas.height = size.y * dpr;
      const ctx = canvas.getContext('2d');
      const scale = (size.x * 2 ** c.z) / WORLD_PX; // map px per global px
      const x0 = (c.x * size.x) / scale, y0 = (c.y * size.y) / scale;
      const x1 = x0 + size.x / scale, y1 = y0 + size.y / scale;
      const pad = 4 / scale;
      ctx.scale(dpr, dpr);
      ctx.strokeStyle = LINE_COLOR;
      ctx.lineWidth = c.z >= 15 ? 2.5 : c.z >= 11 ? 1.8 : 1.2;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      generation++;
      for (let cy = Math.floor((y0 - pad) / CELL); cy <= Math.floor((y1 + pad) / CELL); cy++) {
        for (let cx = Math.floor((x0 - pad) / CELL); cx <= Math.floor((x1 + pad) / CELL); cx++) {
          const list = index.get(cy * 1024 + cx);
          if (!list) continue;
          for (const k of list) {
            if (stamp[k] === generation) continue;
            stamp[k] = generation;
            const a = offsets[k], b = offsets[k + 1];
            ctx.moveTo((coords[a] - x0) * scale, (coords[a + 1] - y0) * scale);
            for (let i = a + 2; i < b; i += 2) ctx.lineTo((coords[i] - x0) * scale, (coords[i + 1] - y0) * scale);
          }
        }
      }
      ctx.stroke();
      return canvas;
    },
  });
  const lines = new LinesLayer({ tileSize: 256, maxZoom: 19, zIndex: 3 });

  // ── Original pixels, rendered in the worker ──
  const CoverageLayer = L.GridLayer.extend({
    createTile(c, done) {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 256;
      requestCoverage(c).then((alpha) => {
        const ctx = canvas.getContext('2d');
        const img = ctx.createImageData(256, 256);
        for (let i = 0; i < alpha.length; i++) {
          if (!alpha[i]) continue;
          img.data.set(COVERAGE_RGB, i * 4);
          img.data[i * 4 + 3] = 210;
        }
        ctx.putImageData(img, 0, 0);
        done(null, canvas);
      }, (err) => done(err, canvas));
      return canvas;
    },
  });
  const coverage = new CoverageLayer({ tileSize: 256, maxZoom: 19, maxNativeZoom: 16, zIndex: 2, className: 'coverage' });

  map.on('moveend', () => onMove && onMove());

  return {
    map,
    setLines(newCoords, newOffsets) {
      coords = newCoords;
      offsets = newOffsets;
      const n = offsets.length - 1;
      stamp = new Uint32Array(n);
      generation = 0;
      index = new Map();
      for (let k = 0; k < n; k++) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (let i = offsets[k]; i < offsets[k + 1]; i += 2) {
          const x = coords[i], y = coords[i + 1];
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
        for (let cy = Math.floor(minY / CELL); cy <= Math.floor(maxY / CELL); cy++) {
          for (let cx = Math.floor(minX / CELL); cx <= Math.floor(maxX / CELL); cx++) {
            const key = cy * 1024 + cx;
            const list = index.get(key);
            list ? list.push(k) : index.set(key, [k]);
          }
        }
      }
      if (!map.hasLayer(lines)) lines.addTo(map);
      else lines.redraw();
    },
    fit(bounds) { map.fitBounds(bounds, { padding: [20, 20] }); },
    setBasemap(on) { on ? basemap.addTo(map) : basemap.remove(); },
    setCoverage(on) { on ? coverage.addTo(map) : coverage.remove(); },
    resetCoverage() { if (map.hasLayer(coverage)) coverage.redraw(); },
    /** Visible area as a global-pixel rectangle [x0, y0, x1, y1]. */
    visibleRect() {
      const b = map.getBounds();
      return [
        Math.max(0, lonToPx(b.getWest())), Math.max(0, latToPx(b.getNorth())),
        Math.min(WORLD_PX, lonToPx(b.getEast())), Math.min(WORLD_PX, latToPx(b.getSouth())),
      ];
    },
    invalidate() { map.invalidateSize(); },
  };
}
