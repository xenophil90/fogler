# fogler — specification

> Status: agreed on 2026-09-25 and implemented in v1. The decisions are listed in §10.

---

## 1. The assignment in one sentence

**fogler** is a web app that reads the sync data of
[Fog of World](https://fogofworld.app/) (iOS), turns the revealed areas back into
paths and exports them as GPX. The result can be imported into Dawarich, OsmAnd,
Komoot or other fog-of-war apps. Everything runs in the browser.

## 2. Non-negotiable constraints (as in overmapper and wordler)

| Point | Requirement |
| --- | --- |
| Execution | 100 % client-side. No server, no telemetry. |
| Dependencies | No build step and no framework. Plain HTML, CSS and ES modules. **Exception:** Leaflet 1.9.4 is vendored in `public/vendor/` and never loaded from a CDN. |
| Deployment | Static hosting (GitHub Pages). `public/` is the web root. |
| Privacy | The fog data never leaves the page. The **only** outgoing requests are the preview's map tiles (§7). This is enforced by the CSP. |
| Languages | German and English, switchable, and the choice is remembered. |
| Accessibility | WCAG 2.1/2.2 AA: visible focus, a live region for status, full keyboard operation, and a text alternative for the map. |
| Platforms | Current Safari (macOS/iOS), Chrome and Firefox. It must work on an iPhone. |

## 3. Input: the Fog of World sync format

Fog of World syncs a `Sync/` folder via iCloud Drive or Dropbox. The format is not
documented. It was reverse-engineered by
[fog-machine](https://github.com/CaviarChen/fog-machine) and **verified** against the
sample data (755 files):

- **One file per tile.** The world is divided into 512 × 512 tiles (Web Mercator,
  i.e. zoom 9).
- **File name**, e.g. `a1b2lohsooxy`: characters `[4:-2]` encode the tile id in the
  alphabet `olhwjsktri`, which maps to digits `0–9`. Then `x = id % 512` and
  `y = id / 512`.
- **Content:** zlib-compressed. After inflating:
  - a block index of 128 × 128 × `u16` (little endian), where 0 means empty and
    `n` means block `n−1`;
  - then 515 bytes per block: a 512-byte bitmap (64 × 64 px, 1 bit each, row-major,
    most significant bit first) followed by 3 unknown bytes, which are ignored.
- **Resolution:** 2²² pixels around the world, about 9.5 m at the equator and about
  6 m at 50° N.
- **Not included:** timestamps, order, or individual tracks. The data is a map of
  revealed pixels and nothing else.

Accepted input: a ZIP of the folder (read in-house, inflated with the platform's
`DecompressionStream('deflate-raw')`), a dropped folder (entry API),
`webkitdirectory`, or individual files. Non-matching files are skipped and counted.

## 4. Data flow

```
files/ZIP ─► decode tiles ─► per-tile raster (+1 block margin from neighbours)
          ─► closing ─► Zhang–Suen skeleton ─► pixel graph ─► prune spurs
          ─► chain edges ─► clip to tile ─► cut staircase corners ─► base simplify (1 px)
          ─► stitch across tiles                                 [once per import]
          ─► min length + Douglas–Peucker at user tolerance       [on every slider change]
          ─► scope clip ─► synthetic time ─► GPX / ZIP            [on export]
```

Everything heavy runs in a module **Web Worker** (`worker.js`). Progress is
reported per tile, and a load can be cancelled.

## 5. Reconstruction

1. **Closing (3 × 3).** Fills pinholes inside wide strips that would otherwise
   thin into ladders of tiny loops. A 1 px closing cannot add pixels to an empty
   64 px block, so only occupied blocks plus a 1 px apron are processed. This keeps
   the cost proportional to the data rather than to the tile area.
2. **Zhang–Suen thinning** over a list of foreground pixels, with lookup tables
   indexed by the 8-neighbourhood code.
3. **Pixel graph.** Pixels are 8-neighbours, except that a diagonal step does not
   count when an orthogonal detour exists. Without that rule, every staircase corner
   becomes a junction.
4. **Spur pruning.** Dangling branches shorter than 8 px (~50 m) that hang off a
   junction are cut, in up to three rounds.
5. **Chaining.** At every junction, the edge ends that continue most straight are
   paired, up to a turn of ~107°. A node with exactly two ends always joins them.
6. **Clip, clean, pre-simplify.** Lines are cut to the tile's own area. Staircase
   corners are dropped when their neighbours touch diagonally. Douglas–Peucker at
   1 px then removes the skeleton's inherent ~0.9 px wobble.
7. **Stitch.** Ends on a tile border are matched with ends in the neighbouring tile
   up to 2 px apart, and the pieces are joined.
8. **User settings.** Minimum length (default 30 m) and simplification tolerance
   (5–50 m, default 10 m) are applied per line, with metres per pixel taken at that
   line's latitude.

**Measured on the sample data** (755 tiles, 12,525,942 pixels, 527 km²):

| | Value |
| --- | --- |
| Paths ≥ 30 m / points at 10 m tolerance | 16,938 / 271,686 |
| Length | ~59,600 km |
| GPX with timestamps | 22.2 MB (single file) |
| Timeline from 1 Jan 2000 (5 km/h, 61 min pause) | until 28 Apr 2003 |
| Time for decode + trace + stitch | ~10 s on a laptop (Chromium) |
| Export | < 1 s |

The first Python prototype produced 65,000 paths for the same data. Closing,
chaining at degree-2 nodes and stitching across tiles brought that down fourfold.

## 6. Output: GPX

GPX 1.1 with a single `<trk>` per file and one `<trkseg>` per path. Coordinates have
six decimals and the output is compact, one point per line. It is written in chunks
of about 1 MB and handed over as a `Blob`.

### 6.1 Synthetic timestamps (for Dawarich)

Evidence from Dawarich's source:

- `Gpx::TrackImporter#prepare_point` **drops `<trkpt>` without `<time>`**, and
  `<wpt>` elements only become "places".
- `Tracks::Segmentation` splits routes **only on time gaps**: default 60 minutes,
  "Minutes between routes". The distance threshold is deliberately ineffective. With
  no gap, Dawarich joins consecutive paths with straight lines.

Rules (`Clock` in `gpx.js`):

- Along a path, time advances at a constant pace (default 5 km/h), and at least
  1 s per point, so every timestamp is unique at Dawarich's one-second resolution.
- **Between paths** there is a pause (default 61 min) longer than Dawarich's
  threshold.
- The start date is freely chosen (default 1 Jan 2000). Time then runs forward as far
  as needed, and the interface shows where the timeline ends.
- Paths are ordered along a Hilbert curve over their start points, so paths that are
  near each other on the map are also near each other in time.
- Timestamps are strictly increasing across a whole export, including across the
  files of a ZIP.
- Timestamps can be switched off, for OsmAnd, Komoot and fog apps.

### 6.2 Splitting

- Default: **one GPX file**.
- Optional: **a ZIP with one file per 1° × 1° cell**, based on each path's start point,
  named `fogler-N48E002.gpx`. The ZIP is written stored (uncompressed) by in-house
  code.

## 7. Interface

A single page with settings on the left and the map on the right (stacked on narrow
screens):

1. **Import**: a drop zone (ZIP, folder, files), a "Choose folder" button, and help
   on where the Sync folder lives. Then progress with cancel, and a summary of tiles,
   revealed area and extent.
2. **Paths**: sliders for simplification and minimum length.
3. **Timestamps**: a switch, start date, pace and pause, plus the "timeline runs from …
   to …" note.
4. **Export**: scope (**everything** / **visible map area**, clipped at the edge), files
   (one GPX / ZIP by region), live figures for paths, points, length and size, and a
   download button.
5. **Map**: Leaflet with the OpenStreetMap background, darkened to match the page
   (switchable, choice remembered), the reconstructed lines as a canvas grid layer
   drawn from a coarse spatial index, and an optional overlay of the original pixels
   rendered by the worker. The map is only created once data is loaded, so nothing
   is requested before that.

**CSP:** `default-src 'self'; img-src 'self' blob: data: https://tile.openstreetmap.org; connect-src 'self'; worker-src 'self'; …`

## 8. Structure

```
public/
  index.html  style.css
  js/  main.js      – wiring, import, export, formatting
       ui.js  i18n.js
       worker.js    – pipeline, stats, export, coverage tiles
       fog.js       – tile names, tile decoding, projection
       zip.js       – ZIP read/write, CRC-32
       skeleton.js  – closing, thinning, graph, spurs, chaining, stitching
       simplify.js  – Douglas–Peucker
       gpx.js       – GPX writer, synthetic clock
       map.js       – Leaflet preview
  vendor/leaflet/   (BSD-2-Clause)
  assets/ fonts/
tools/selftest.mjs, selftest.html
docs/SPEC.md  BACKLOG.md  README.md
.github/workflows/ci.yml, pages.yml
```

## 9. Acceptance criteria

- [x] All 755 sample files decode without errors, giving 12,525,942 pixels.
- [x] The reconstruction lies on the original pixels (overlay) with no visible jumps
  at tile borders.
- [x] Export timestamps are strictly increasing and every point has a time.
- [x] Scope and region split export exactly the expected paths (checked by counting).
- [x] The mobile layout has no horizontal scrolling.
- [ ] The whole sample data set processes in under 60 s on a current iPhone.
- [ ] Imports into Dawarich, OsmAnd and Fog of World itself have been verified by hand.
- [ ] A screen reader pass has been done.

## 10. Decisions

| # | Topic | Decision |
| --- | --- | --- |
| 1 | Timeline for Dawarich | Free start date (default 1 Jan 2000), running forward as far as needed. The interface shows the end date, and pause and pace are adjustable. |
| 2 | Name | **fogler** |
| 3 | Documentation language | English. The app itself is bilingual (DE/EN). |
| 4 | Export scope | Everything, **or** only the visible map area. |
| 5 | GPX → Fog sync | Backlog. |
| – | Target apps | Dawarich, map apps (OsmAnd, Komoot), other fog-of-war apps |
| – | Representation | Reconstructed paths as tracks |
| – | Splitting | One file, optionally a ZIP by region |
| – | Import | ZIP, folder or individual files |
| – | Level of detail | Sliders with live figures |
| – | Preview | Leaflet with OSM tiles (switchable off) |
