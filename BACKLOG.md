# Backlog

Ideas and open points for fogler. None of it is in progress; within each section
the order is roughly by usefulness.

## Next up

- [ ] **Detect and drop flights.** Fog of World reveals a dotted line along a flight
  path (a few pixels every few kilometres). Reconstructed, those become many tiny paths
  strung along a straight line. On the sample data they alone add around 300 cells to
  the ZIP-by-region export. A switch that drops runs of short, collinear, widely spaced
  pieces would clean this up.
- [ ] **Verify the import in Dawarich, OsmAnd and Fog of World itself** with the sample
  export, and write down any quirks in the README. Round trip: import the GPX back into
  Fog of World and compare the revealed area with the original.
- [ ] **Size cap per file** for "ZIP by region": split a cell further when its GPX
  exceeds a limit (e.g. 20 MB), instead of relying on the 1° grid alone.
- [ ] **Rectangle selection** for the export scope, independent of the visible map area
  and operable by keyboard.

## Reconstruction

- [ ] Smooth the centre lines (e.g. Chaikin) before simplifying: the skeleton follows
  the pixel grid and wobbles by up to a pixel.
- [ ] Merge parallel duplicates: the same road travelled on two slightly different GPS
  tracks sometimes survives as two lines a few pixels apart.
- [ ] Expose the spur length and junction angle as advanced settings.
- [ ] Reuse the traced result between sessions (IndexedDB) so a reload doesn't have to
  trace again.

## Output

- [ ] **GPX → Fog of World sync tiles** (the reverse direction). `fog.js` would gain a
  writer, and nothing else in the pipeline changes.
- [ ] GeoJSON and KML export alongside GPX.
- [ ] Choose the ordering of the synthetic timeline: along a Hilbert curve (today), by
  region, or longest paths first.

## Interface

- [ ] On narrow screens, show the map before the settings once data is loaded.
- [ ] Hide the "Choose folder" button where the platform cannot pick folders (iOS).
- [ ] Remember the settings (simplification, timestamps, split) between visits.
