import { $, t, currentLang, detectInitialLang, applyLanguage, initLangSwitch, bindSegmented, bindSwitch, show, debounce } from './ui.js';
import { createMap } from './map.js';

const BASEMAP_KEY = 'fogler-basemap';

const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
let view = null;          // map wrapper, created on first data so nothing loads before
let loaded = null;        // summary of the current data set
let linesId = 0, statsId = 0, coverageId = 0;
const coverageWaiting = new Map();
let exportFilename = '';
let lastStats = null;

// ── Formatting ─────────────────────────────────────────────────────

const fmt = (n, digits = 0) => n.toLocaleString(currentLang(), { maximumFractionDigits: digits, minimumFractionDigits: digits });
const fmtKm = (km) => `${fmt(km, km < 100 ? 1 : 0)} km`;
const fmtBytes = (b) => (b >= 1e6 ? `${fmt(b / 1e6, 1)} MB` : `${fmt(Math.max(1, b / 1e3))} kB`);
const fmtDate = (ms) => new Date(ms).toLocaleDateString(currentLang(), { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const fmtLat = (v) => `${fmt(Math.abs(v), 2)}° ${t(v < 0 ? 'dirS' : 'dirN')}`;
const fmtLon = (v) => `${fmt(Math.abs(v), 2)}° ${t(v < 0 ? 'dirW' : 'dirE')}`;

function setStatus(text) { $('status').textContent = text; }
function setError(text) {
  $('error').textContent = text || '';
  show($('error'), Boolean(text));
}

// ── Settings ───────────────────────────────────────────────────────

const scope = bindSegmented('optScope', 'all', () => { requestStats(); });
const split = bindSegmented('optSplit', 'single', () => { paintExportButton(); });
const timeOn = bindSwitch('optTime', true, (on) => { show($('timeFields'), on); requestStats(); });
let basemapOn = true;
try { basemapOn = localStorage.getItem(BASEMAP_KEY) !== 'off'; } catch { /* default */ }
const basemap = bindSwitch('optBasemap', basemapOn, (on) => {
  try { localStorage.setItem(BASEMAP_KEY, on ? 'on' : 'off'); } catch { /* not worth failing over */ }
  view && view.setBasemap(on);
});
const coverage = bindSwitch('optCoverage', false, (on) => { view && view.setCoverage(on); });

function timeSettings() {
  if (!timeOn.get()) return null;
  const start = Date.parse(`${$('optStart').value || '2000-01-01'}T00:00:00Z`);
  const clamp = (v, lo, hi, d) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  return {
    start: Number.isFinite(start) ? start : Date.UTC(2000, 0, 1),
    speedKmh: clamp(parseFloat($('optSpeed').value), 1, 300, 5),
    gapMinutes: clamp(parseFloat($('optGap').value), 1, 1440, 61),
  };
}
const scopeRect = () => (scope.get() === 'view' && view ? view.visibleRect() : null);

function paintSliderOutputs() {
  $('optEpsOut').textContent = `${$('optEps').value} m`;
  $('optMinOut').textContent = `${$('optMin').value} m`;
}
function paintExportButton() {
  $('exportBtn').textContent = t(split.get() === 'region' ? 'btnExportZip' : 'btnExport');
}

// ── Worker traffic ─────────────────────────────────────────────────

function requestLines() {
  if (!loaded) return;
  worker.postMessage({ type: 'lines', id: ++linesId, epsMetres: +$('optEps').value, minMetres: +$('optMin').value });
}
function requestStats() {
  if (!loaded) return;
  worker.postMessage({ type: 'stats', id: ++statsId, rect: scopeRect(), time: timeSettings() });
}
const requestLinesSoon = debounce(requestLines, 150);
const requestStatsSoon = debounce(requestStats, 200);

function requestCoverage({ x, y, z }) {
  const id = ++coverageId;
  worker.postMessage({ type: 'coverage', id, x, y, z });
  return new Promise((resolve) => coverageWaiting.set(id, resolve));
}

worker.onmessage = (e) => {
  const m = e.data;
  switch (m.type) {
    case 'progress': {
      const label = { decode: 'phaseDecode', trace: 'phaseTrace', stitch: 'phaseStitch' }[m.phase];
      $('progressLabel').textContent = t(label, { done: fmt(m.done), total: fmt(m.total) });
      $('progress').max = m.total;
      $('progress').value = m.done;
      break;
    }
    case 'loaded': onLoaded(m); break;
    case 'lines': {
      if (m.id !== linesId) break;
      view.setLines(m.coords, m.offsets);
      requestStats();
      break;
    }
    case 'stats': {
      if (m.id !== statsId) break;
      paintStats(m);
      break;
    }
    case 'coverage': {
      const resolve = coverageWaiting.get(m.id);
      coverageWaiting.delete(m.id);
      resolve && resolve(m.alpha);
      break;
    }
    case 'exported': onExported(m); break;
    case 'error': {
      show($('progressWrap'), false);
      $('exportBtn').disabled = false;
      setError(t('errorGeneric', { message: m.message }));
      break;
    }
  }
};

// ── Import ─────────────────────────────────────────────────────────

function startLoad(files) {
  files = files.filter((f) => !f.name.startsWith('.'));
  if (!files.length) return;
  if (typeof DecompressionStream === 'undefined') { setError(t('errorBrowser')); return; }
  setError('');
  loaded = null;
  $('progressLabel').textContent = t('phaseRead');
  $('progress').removeAttribute('value');
  show($('progressWrap'), true);
  setStatus(t('phaseRead'));
  worker.postMessage({ type: 'load', files });
}

function onLoaded(m) {
  show($('progressWrap'), false);
  if (!m.tiles) {
    setError(t('errorNoTiles'));
    setStatus('');
    return;
  }
  loaded = m;
  const notes = [];
  if (m.skipped) notes.push(t('skipped', { n: fmt(m.skipped) }));
  if (m.broken) notes.push(t('broken', { n: fmt(m.broken) }));
  $('skippedHint').textContent = notes.join(' ');
  show($('skippedHint'), notes.length > 0);
  paintSummary();
  ['linesPanel', 'timePanel', 'exportPanel', 'summary', 'mapOptions'].forEach((id) => show($(id), true));
  show($('previewEmpty'), false);

  if (!view) {
    view = createMap($('map'), { requestCoverage, onMove: () => { if (scope.get() === 'view') requestStatsSoon(); } });
    view.setBasemap(basemap.get());
    view.setCoverage(coverage.get());
    $('map').setAttribute('aria-label', t('ariaMap'));
  } else {
    view.resetCoverage();
  }
  view.invalidate();
  view.fit(m.bounds);
  requestLines();
}

function paintSummary() {
  if (!loaded) return;
  const [[south, west], [north, east]] = loaded.bounds;
  $('factTiles').textContent = fmt(loaded.tiles);
  $('factArea').textContent = `${fmt(loaded.areaKm2, 1)} km²`;
  $('factRange').textContent = `${fmtLat(south)} … ${fmtLat(north)}, ${fmtLon(west)} … ${fmtLon(east)}`;
}

function paintStats(s) {
  lastStats = s;
  $('statLines').textContent = fmt(s.lines);
  $('statPoints').textContent = fmt(s.points);
  $('statKm').textContent = fmtKm(s.km);
  $('statSize').textContent = fmtBytes(s.bytes);
  $('exportBtn').disabled = s.lines === 0;
  const time = timeSettings();
  $('timeRange').textContent = time && s.timeEnd ? t('timeRange', { from: fmtDate(time.start), to: fmtDate(s.timeEnd) }) : '';
  if (loaded && scope.get() === 'all') {
    const [[south, west], [north, east]] = loaded.bounds;
    $('mapDescription').textContent = t('mapDescription', {
      lines: fmt(s.lines), km: fmtKm(s.km),
      south: fmtLat(south), north: fmtLat(north),
      west: fmtLon(west), east: fmtLon(east),
    });
    setStatus(t('statusLoaded', { tiles: fmt(loaded.tiles), lines: fmt(s.lines) }));
  }
}

/** Files from a drop, including whole folders (Safari/Chrome/Firefox entry API). */
async function filesFromDrop(dt) {
  const items = [...(dt.items || [])];
  const entries = items.map((i) => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
  if (!entries.length) return [...(dt.files || [])];
  const out = [];
  const walk = async (entry) => {
    if (entry.isFile) {
      out.push(await new Promise((res, rej) => entry.file(res, rej)));
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const child of batch) await walk(child);
      }
    }
  };
  for (const entry of entries) await walk(entry);
  return out;
}

const drop = $('drop');
['dragenter', 'dragover'].forEach((type) => drop.addEventListener(type, (e) => { e.preventDefault(); drop.classList.add('is-over'); }));
['dragleave', 'drop'].forEach((type) => drop.addEventListener(type, (e) => { e.preventDefault(); drop.classList.remove('is-over'); }));
drop.addEventListener('drop', async (e) => startLoad(await filesFromDrop(e.dataTransfer)));
$('fileInput').addEventListener('change', (e) => { startLoad([...e.target.files]); e.target.value = ''; });
$('folderBtn').addEventListener('click', () => $('folderInput').click());
$('folderInput').addEventListener('change', (e) => { startLoad([...e.target.files]); e.target.value = ''; });
$('cancelBtn').addEventListener('click', () => {
  worker.postMessage({ type: 'cancel' });
  show($('progressWrap'), false);
  setStatus('');
});

// ── Settings wiring ────────────────────────────────────────────────

['optEps', 'optMin'].forEach((id) => $(id).addEventListener('input', () => { paintSliderOutputs(); requestLinesSoon(); }));
['optStart', 'optSpeed', 'optGap'].forEach((id) => $(id).addEventListener('input', requestStatsSoon));

// ── Export ─────────────────────────────────────────────────────────

$('exportBtn').addEventListener('click', () => {
  if (!loaded) return;
  $('exportBtn').disabled = true;
  setStatus(t('exporting'));
  const now = new Date();
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  worker.postMessage({
    type: 'export', rect: scopeRect(), time: timeSettings(), split: split.get(),
    name: 'Fog of World', stamp,
  });
});

function onExported(m) {
  $('exportBtn').disabled = false;
  if (m.empty) { setStatus(t('exportEmpty')); return; }
  exportFilename = m.filename;
  const url = URL.createObjectURL(m.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = m.filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  const size = fmtBytes(m.blob.size);
  const key = !m.files ? 'exported' : m.files === 1 ? 'exportedZipOne' : 'exportedZip';
  setStatus(t(key, { file: exportFilename, n: fmt(m.files || 0), size }));
}

// ── Language ───────────────────────────────────────────────────────

function onLanguage() {
  paintSliderOutputs();
  paintExportButton();
  paintSummary();
  if (view) $('map').setAttribute('aria-label', t('ariaMap'));
  if (lastStats) paintStats(lastStats);
}
const initial = detectInitialLang();
const langSwitch = initLangSwitch((lang) => applyLanguage(lang, onLanguage));
langSwitch.select(initial);
