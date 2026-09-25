<h1 align="center">fogler</h1>

<p align="center">
  <img src="public/assets/logo.svg" alt="" width="72" height="72">
</p>

<p align="center">
  Turn your <a href="https://fogofworld.app/">Fog of World</a> data into GPX, for
  Dawarich, OsmAnd, Komoot or another fog-of-war app. Everything runs in the browser:
  no backend, no accounts, no uploads.
</p>

## The problem

Fog of World does not store tracks. Its sync folder holds a bitmap of revealed
pixels, each about 6–10 m across, with no timestamps and no order. A GPX file needs
lines. fogler rebuilds those lines from the pixel map:

1. **Decode** the sync tiles (zlib-compressed, 128 × 128 blocks of 64 × 64 bits each)
2. **Close** pinholes in wide, often-travelled strips
3. **Thin** every strip to its centre line (Zhang–Suen)
4. **Trace** the pixel graph, **prune** short spurs, and **chain** edges through
   junctions along the straightest continuation
5. **Stitch** lines back together across tile borders
6. **Simplify** (Douglas–Peucker) to the tolerance you choose

On the sample data set (755 tiles, 527 km² revealed) this yields about 17,000 paths
with 270,000 points, totalling roughly 60,000 km. It takes about 10 seconds on a laptop.

## Features

**Input**

- The `Sync` folder dropped as a whole, a ZIP of it (the easy way on an iPhone: Files
  app → long-press → Compress), or individual files
- Non-tile files (`.DS_Store`, `__MACOSX/` …) are skipped and counted

**Paths**

- Simplification tolerance from 5 to 50 m and a minimum path length, both with a live
  count of paths, points, kilometres and file size

**Timestamps (for Dawarich)**

Dawarich drops trackpoints without `<time>`, and it splits routes only on time gaps,
never on distance. fogler therefore writes synthetic timestamps. Time runs at a
constant pace along each path, and a pause longer than Dawarich's "Minutes between
routes" separates one path from the next. You pick the start date, and the interface
shows where the timeline ends, so it can stay clear of your real data. Paths are
ordered along a Hilbert curve, so paths that are close together on the map are also
close together in time. Timestamps can be switched off for apps that don't need them.

**Export**

- Everything, or only the area visible on the map (lines are clipped at its edge)
- One GPX file, or a ZIP with one GPX file per 1° × 1° cell for apps that reject
  large files
- GPX 1.1, one `<trkseg>` per path, coordinates to six decimals

**Map preview**

- OpenStreetMap background, darkened to match the page, and switchable off
- Optional overlay of the original revealed pixels, to check the reconstruction

**Privacy**

Your fog data never leaves the page. The Content Security Policy allows no outgoing
connections at all, and permits images from `tile.openstreetmap.org` only. That one
exception is the background map, which you can switch off.

**Accessibility**

Built for EN 301 549 / WCAG 2.1–2.2 level AA. Every control is keyboard operable and
named. Progress and results are announced through a live region. The map is
keyboard-navigable and carries a text summary of what it shows. Reduced motion is
respected.

## Usage

Everything the site needs lives in `public/`. Serve that folder with any static file
server, for example:

```bash
python3 -m http.server 8000 --directory public
```

Then visit `http://localhost:8000`. Module workers don't run from `file://`, so opening
`index.html` directly won't work.

## Tests

```bash
node tools/selftest.mjs
```

This checks tile names, ZIP reading and writing, simplification, reconstruction,
stitching across tiles and GPX output on synthetic data. CI runs it on every push.
Serve the repository root and open `tools/selftest.html` to run the same tests in a
browser. If there is a `Sync.zip` in `example/`, it is checked as well. That folder is
git-ignored, because it is someone's location history.

## Deploying

Point the web server's document root at `public/`, not at the repository root. The
included workflow deploys `public/` to GitHub Pages.

## About this project

This app was built almost entirely through conversation with [Claude](https://claude.com)
(Anthropic's AI assistant): the file format analysis, the reconstruction algorithm, the
interface and this repository. It is an AI-generated / AI-assisted project.

## Credits

- The sync format was worked out by [fog-machine](https://github.com/CaviarChen/fog-machine)
  and verified here against real data
- [Leaflet](https://leafletjs.com/) 1.9.4 (BSD-2-Clause, see `public/vendor/leaflet/LICENSE`)
- Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors
- [Inter](https://github.com/rsms/inter) font (SIL Open Font License)

fogler is not affiliated with Fog of World or its developers.
