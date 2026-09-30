// fast·md — PDF → Markdown entirely in the browser.
// Orchestration: file queue → engine run → film-strip progress → result
// preview. Nothing is ever uploaded; models cache locally after first use.
import { openPdf, closePdf, probeTextDensity } from './pdfjs.js';
import { runInstant } from './instant.js';
import { runInspector, classifyInspector } from './inspector.js';
import { runTesseract, terminateTesseract } from './tess.js';
import { runVlm, ensureVlm, VLM_DEFS, webgpuAvailable } from './vlm.js';
import { ENGINES, LANGUAGES, engineById } from './engines.js';
import { pagesToMarkdown, rtlRatio } from './markdown.js';
import {
  loadSettings, saveSettings, transformersCacheState, manifestBytes,
  clearTransformersCache, tesseractCacheState, clearTesseractCache, storageEstimate,
} from './store.js';
import { $, $$, el, toast, fmtBytes, fmtDuration, downloadText } from './ui.js';
import { marked } from '../vendor/marked/marked.esm.js';

const settings = loadSettings();
let fileSeq = 0; // unique id per queued file — results link back to it
const state = {
  files: [],            // {id, file, name, size, status, pages, density, hint}
  results: [],          // {fileId, name, md, rtl, pages, secs, pgps, engineName, device, chars}
  activeResult: 0,
  engine: settings.engine,
  userPickedEngine: false,
  running: false,
  stopRequested: false,
  tab: 'preview',
};

// ---------------------------------------------------------------- helpers --

function parsePageRange(spec, total) {
  if (!spec || !spec.trim()) return Array.from({ length: total }, (_, i) => i + 1);
  const pages = new Set();
  for (const part of spec.split(',')) {
    const m = part.trim().match(/^(\d+)\s*(?:[-–]\s*(\d+))?$/);
    if (!m) continue;
    const a = Math.max(1, +m[1]);
    const b = m[2] ? Math.min(total, +m[2]) : a;
    for (let p = a; p <= Math.max(a, b); p++) pages.add(p);
  }
  return [...pages].sort((x, y) => x - y).filter((p) => p <= total);
}

function sanitize(html) {
  return html
    .replace(/<(script|style|iframe|object|embed|link|meta)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<(script|style|iframe|object|embed|link|meta)\b[^>]*\/?>/gi, '')
    .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*(?:"javascript:[^"]*"|'javascript:[^']*')/gi, '$1="#"');
}

function baseName(name) {
  return name.replace(/\.pdf$/i, '');
}

// ------------------------------------------------------------- engine rail --

function renderEngines() {
  const rail = $('#engineRail');
  rail.replaceChildren();
  for (const engine of ENGINES) {
    const cached = engine.needsModel === true && manifestBytes(VLM_DEFS[engine.id]?.repo) > 0;
    const card = el('button', {
      class: `engine${state.engine === engine.id ? ' is-selected' : ''}`,
      type: 'button', role: 'radio', 'aria-checked': state.engine === engine.id,
      'data-engine': engine.id,
      onclick: () => selectEngine(engine.id, true),
    },
      el('div', { class: 'engine-head' },
        el('span', { class: 'engine-key mono' }, engine.key),
        el('span', { class: 'engine-name' }, engine.name),
        el('span', { class: 'engine-size mono' }, engine.size)),
      el('p', { class: 'engine-blurb' }, engine.blurb),
      el('div', { class: 'engine-foot' },
        el('span', { class: `badge badge--${engine.id}` }, engine.tier),
        cached ? el('span', { class: 'badge badge--cached' }, 'cached') : null,
        engine.id === 'qwen' && !webgpuAvailable()
          ? el('span', { class: 'badge badge--warn' }, 'CPU only — slow') : null,
      ),
    );
    rail.append(card);
  }
}

function selectEngine(id, byUser) {
  state.engine = id;
  if (byUser) state.userPickedEngine = true;
  settings.engine = id;
  saveSettings(settings);
  renderEngines();
  $('#langRow').classList.toggle('is-hidden', id !== 'tesseract');
  $('#dpiRow').classList.toggle('is-hidden', id === 'instant' || id === 'inspector');
  $('#tokensRow').classList.toggle('is-hidden', !(id === 'smolvlm' || id === 'qwen'));
}

// ------------------------------------------------------------ file intake --

async function addFiles(list) {
  const pdfs = [...list].filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
  if (!pdfs.length) { toast('Only PDF files, please', 'error'); return; }
  for (const file of pdfs) {
    state.files.push({ id: ++fileSeq, file, name: file.name, size: file.size, status: 'ready', pages: 0, density: -1 });
  }
  renderQueue();
  await probeLastFile();
  syncRunBar();
}

async function probeLastFile() {
  const entry = state.files.at(-1);
  if (!entry || entry.density >= 0) return;

  // Prefer the real classifier (same one ocr-wrapper uses); fall back to a
  // pdf.js text-density heuristic if the WASM worker can't load.
  try {
    const cls = await classifyInspector(await entry.file.arrayBuffer());
    entry.pages = cls.pageCount;
    entry.density = cls.pdfType === 'TextBased' ? 999 : 0;
    if (cls.pdfType === 'TextBased') {
      entry.hint = { label: 'Digital PDF — pdf-inspector finishes in ~1 s', engine: 'inspector' };
    } else if (cls.pdfType === 'Mixed') {
      entry.hint = {
        label: `Mixed PDF — ${cls.pagesNeedingOcr.length} page(s) also need OCR`,
        engine: 'inspector',
      };
    } else {
      entry.hint = {
        label: `Scanned PDF — ${cls.pagesNeedingOcr.length} of ${cls.pageCount} page(s) need OCR`,
        engine: 'tesseract',
      };
    }
  } catch {
    try {
      const doc = await openPdf(await entry.file.arrayBuffer());
      entry.pages = doc.numPages;
      entry.density = await probeTextDensity(doc);
      closePdf(doc);
    } catch (error) {
      entry.status = 'error';
      entry.error = friendlyPdfError(error);
      toast(`${entry.name}: ${entry.error}`, 'error');
      renderQueue();
      return;
    }
    entry.hint = entry.density > 120
      ? { label: 'Digital PDF — pdf-inspector finishes in ~1 s', engine: 'inspector' }
      : { label: 'Scanned PDF — an OCR engine is needed', engine: 'tesseract' };
  }
  if (!state.userPickedEngine && !state.running) selectEngine(entry.hint.engine, false);
  renderQueue();
}

function friendlyPdfError(error) {
  if (error?.name === 'PasswordException') return 'password-protected PDF';
  if (error?.name === 'InvalidPDFException') return 'not a valid PDF';
  return error?.message || 'could not open';
}

/** Remove a queued file and everything that belongs to it (results included). */
function removeFile(index) {
  const [removed] = state.files.splice(index, 1);
  if (!removed) return;
  removed.removed = true; // a conversion in flight must not publish its result
  const shown = state.results[state.activeResult];
  state.results = state.results.filter((r) => r.fileId !== removed.id);
  if (state.results.length) {
    const at = state.results.indexOf(shown);
    state.activeResult = at >= 0 ? at : state.results.length - 1;
    renderResult();
  } else {
    state.activeResult = 0;
    showEmptyStage();
  }
  renderQueue();
  syncRunBar();
}

function showEmptyStage() {
  $('#stageEmpty').classList.remove('is-hidden');
  $('#stageRun').classList.add('is-hidden');
  $('#stageResult').classList.add('is-hidden');
}

function renderQueue() {
  const list = $('#fileList');
  list.replaceChildren();
  $('#fileListRow').classList.toggle('is-hidden', !state.files.length);
  for (const [i, f] of state.files.entries()) {
    const dot = el('span', { class: `dot dot--${f.status === 'error' ? 'error' : f.status === 'done' ? 'done' : 'ready'}` });
    const meta = [fmtBytes(f.size), f.pages ? `${f.pages} pg` : '…'].join(' · ');
    const item = el('li', { class: 'file-item' },
      dot,
      el('span', { class: 'file-name', title: f.name }, f.name),
      el('span', { class: 'file-meta mono' }, meta),
      el('button', {
        class: 'file-remove', type: 'button', 'aria-label': `Remove ${f.name}`,
        onclick: () => removeFile(i),
      }, '×'),
    );
    list.append(item);
  }
  const hint = state.files.find((f) => f.hint)?.hint;
  const hintEl = $('#pdfHint');
  hintEl.classList.toggle('is-hidden', !hint || state.running);
  if (hint) hintEl.textContent = hint.label;
}

// --------------------------------------------------------------- the reel --

const reel = {
  total: 0, done: 0, group: 1, startedAt: 0, dirty: false, timer: null, modelLabel: '',
};

function buildReel(total) {
  const host = $('#reel');
  reel.total = total;
  reel.done = 0;
  reel.group = total <= 120 ? 1 : total <= 480 ? 4 : 12;
  host.replaceChildren();
  const chips = Math.ceil(total / reel.group);
  const frag = document.createDocumentFragment();
  for (let i = 0; i < chips; i++) {
    const from = i * reel.group + 1;
    frag.append(el('div', {
      class: 'pg-chip', 'data-from': from,
      title: `page ${from}${reel.group > 1 ? `–${Math.min(total, from + reel.group - 1)}` : ''}`,
    }, String(from)));
  }
  host.append(frag);
  host.classList.toggle('is-grouped', reel.group > 1);
  $('#stageRun').classList.remove('is-hidden');
  $('#stageEmpty').classList.add('is-hidden');
  $('#stageResult').classList.add('is-hidden');
  updateStats(true);
}

function reelTick(pageNo) {
  reel.done++;
  if (reel.timer) return;
  reel.timer = setTimeout(() => { reel.timer = null; paintReel(); }, 70);
}

function paintReel() {
  const host = $('#reel');
  const chips = host.children;
  let donePages = reel.done;
  for (let i = chips.length - 1; i >= 0; i--) {
    const from = +chips[i].dataset.from;
    const size = Math.min(reel.group, reel.total - from + 1);
    const doneInGroup = Math.max(0, Math.min(size, donePages - (from - 1)));
    chips[i].style.setProperty('--fill', doneInGroup / size);
    if (doneInGroup >= size) chips[i].classList.add('is-done');
  }
  updateStats(false);
}

function updateStats(reset) {
  const now = performance.now();
  if (reset) reel.startedAt = now;
  const elapsed = (now - reel.startedAt) / 1000;
  const rate = reel.done / Math.max(elapsed, 0.001);
  const eta = rate > 0 ? (reel.total - reel.done) / rate : Infinity;
  $('#statDone').textContent = `${reel.done}/${reel.total}`;
  $('#statRate').textContent = rate.toFixed(1);
  $('#statEta').textContent = isFinite(eta) && reel.done > 0 ? fmtDuration(eta) : '—';
}

function setModelStatus(status) {
  const row = $('#modelStatus');
  if (!status) { row.classList.add('is-hidden'); return; }
  row.classList.remove('is-hidden');
  $('#modelLabel').textContent = status.label;
  $('#modelBar').style.width = `${Math.round((status.progress ?? 0) * 100)}%`;
  $('#modelBytes').textContent = status.bytes
    ? `${fmtBytes(status.bytes.loaded)} / ${fmtBytes(status.bytes.total)}` : '';
}

// ---------------------------------------------------------------- convert --

function syncRunBar() {
  // 'done' files stay eligible so a different engine can be tried on them
  const pending = state.files.filter((f) => f.status === 'ready' || f.status === 'done').length;
  const pages = state.files.reduce((a, f) => a + (f.pages || 0), 0);
  $('#convertCount').textContent = pending
    ? `${pending} file${pending > 1 ? 's' : ''}${pages ? ` · ${pages} pages` : ''}` : 'nothing queued';
  $('#convertBtn').disabled = state.running || !pending;
  $('#stopBtn').classList.toggle('is-hidden', !state.running);
}

async function convertAll() {
  if (state.running) return;
  // the input is the source of truth at convert time (change may not have
  // committed if the user clicked straight from the field)
  settings.pageRange = $('#pageRange').value.trim();
  saveSettings(settings);
  const work = state.files.filter((f) => f.status === 'ready' || f.status === 'done');
  if (!work.length) { toast('Add a PDF first'); return; }

  state.running = true;
  state.stopRequested = false;
  syncRunBar();
  $('#convertBtn').disabled = true;
  renderQueue();

  let failures = 0;
  for (const entry of work) {
    if (state.stopRequested) break;
    try {
      await convertOne(entry);
    } catch (error) {
      failures++;
      entry.status = 'error';
      entry.error = error?.message || String(error);
      toast(`${entry.name}: ${entry.error}`, 'error');
      console.error(error);
    }
    renderQueue();
  }

  state.running = false;
  syncRunBar();
  if (state.stopRequested) toast('Stopped');
  else if (!failures) toast('Done — all files converted');
}

async function convertOne(entry) {
  const engine = engineById(state.engine);
  entry.status = 'busy';
  renderQueue();

  const doc = await openPdf(await entry.file.arrayBuffer());
  entry.pages = doc.numPages;
  const pageNumbers = parsePageRange(settings.pageRange, doc.numPages);
  if (!pageNumbers.length) { closePdf(doc); throw new Error('empty page range'); }

  buildReel(pageNumbers.length);
  setModelStatus(null);
  $('#runTitle').textContent = `${entry.name} — ${engine.name}`;
  let device = engine.ocr ? 'WASM' : 'built-in';

  const t0 = performance.now();
  const pageTexts = new Array(pageNumbers.length).fill('');
  const byPage = new Map();
  const callbacks = {
    onPage: () => reelTick(),
    onPageDone: (n, text) => { byPage.set(n, text); reelTick(); },
    onStatus: setModelStatus,
    onReady: (info) => { device = (info?.device || 'wasm').toUpperCase(); },
    shouldStop: () => state.stopRequested,
  };
  let instantRtl = null;

  if (engine.id === 'inspector') {
    // fresh read — pdf.js transferred/detached the first ArrayBuffer
    const bytes = await entry.file.arrayBuffer();
    const result = await runInspector(bytes, pageNumbers, callbacks);
    device = result.pdfType;
    byPage.set(pageNumbers[0], result.markdown);
  } else if (engine.id === 'instant') {
    const { pageTexts: texts, rtl } = await runInstant(doc, pageNumbers, {}, callbacks);
    texts.forEach((t, i) => byPage.set(pageNumbers[i], t));
    device = 'built-in';
    instantRtl = rtl;
  } else if (engine.id === 'tesseract') {
    await runTesseract(doc, pageNumbers, {
      dpi: settings.dpi, langs: settings.langs, workers: settings.workers,
    }, callbacks);
    device = 'wasm';
  } else {
    await runVlm(engine.id, doc, pageNumbers, {
      dpi: Math.min(settings.dpi, 220), maxNewTokens: settings.maxNewTokens,
    }, callbacks);
  }

  closePdf(doc);
  for (const [i, n] of pageNumbers.entries()) pageTexts[i] = byPage.get(n) || '';
  const joined = pageTexts.join('\n\n');
  const rtl = instantRtl ?? (rtlRatio(joined) > 0.3);
  const normalize = settings.normalize === 'on' || (settings.normalize === 'auto' && rtl);
  const md = pagesToMarkdown(pageTexts, { rtl, normalize });

  const secs = (performance.now() - t0) / 1000;
  if (entry.removed) return; // file was pulled mid-run — drop its output
  state.results.push({
    fileId: entry.id,
    name: baseName(entry.name), md, rtl,
    pages: pageNumbers.length, secs,
    pgps: pageNumbers.length / Math.max(secs, 0.001),
    engineName: engine.name, device, chars: md.length, normalize,
  });
  state.activeResult = state.results.length - 1;
  entry.status = 'done';
  renderResult();
  renderQueue();
}

// ---------------------------------------------------------------- results --

function renderResult() {
  const result = state.results[state.activeResult];
  if (!result) return;
  $('#stageEmpty').classList.add('is-hidden');
  $('#stageRun').classList.add('is-hidden');
  const box = $('#stageResult');
  box.classList.remove('is-hidden');

  const tabs = $('#resultTabs');
  tabs.replaceChildren();
  state.results.forEach((r, i) => {
    tabs.append(el('button', {
      class: `rtab${i === state.activeResult ? ' is-active' : ''}`,
      type: 'button',
      onclick: () => { state.activeResult = i; renderResult(); },
    }, r.name));
  });

  const stats = [
    `${result.engineName} · ${result.device}`,
    `${result.pages} page${result.pages > 1 ? 's' : ''}`,
    fmtDuration(result.secs),
    `${result.pgps >= 0.1 ? result.pgps.toFixed(1) : '< 0.1'} pg/s`,
    `${(result.chars / 1000).toFixed(1)}k chars${result.normalize ? ' · Persian tidied' : ''}`,
  ].join('  ·  ');
  $('#resultStats').textContent = stats;
  $('#downloadBtn').onclick = () => {
    downloadText(`${result.name}.md`, result.md);
    toast('Saved ' + result.name + '.md');
  };
  $('#copyBtn').onclick = async () => {
    try { await navigator.clipboard.writeText(result.md); toast('Copied to clipboard'); }
    catch { toast('Clipboard blocked by browser', 'error'); }
  };

  paintResultBody(result);
}

function paintResultBody(result) {
  const body = $('#resultBody');
  body.dir = result.rtl ? 'rtl' : 'ltr';
  if (state.tab === 'preview') {
    body.className = 'well is-paper';
    body.innerHTML = sanitize(marked.parse(result.md, { breaks: false, gfm: true }));
  } else {
    body.className = 'well is-raw';
    body.replaceChildren(el('pre', {}, el('code', { text: result.md })));
  }
  $$('#viewTabs .seg-btn').forEach((t) => t.classList.toggle('is-active', t.dataset.view === state.tab));
}

// ---------------------------------------------------------- storage panel --

let storageRenderSeq = 0;
async function renderStorage() {
  const seq = ++storageRenderSeq;
  const list = $('#modelList');
  list.replaceChildren();

  const rows = [];
  for (const [key, def] of Object.entries(VLM_DEFS)) {
    const { cached, bytes } = await transformersCacheState(def.repo);
    rows.push({
      label: def.label,
      detail: cached ? `cached · ${fmtBytes(bytes)}` : `not cached · ~${fmtBytes(def.approxBytes)}`,
      download: () => ensureVlm(key, setModelStatus),
      clear: () => clearTransformersCache(def.repo),
    });
  }
  const tess = await tesseractCacheState();
  rows.push({
    label: 'Tesseract languages',
    detail: tess.known && tess.langs?.length
      ? `cached: ${tess.langs.join(', ')}` : 'not cached yet',
    clear: async () => { await clearTesseractCache(); await terminateTesseract(); },
  });

  const { usage, quota } = await storageEstimate();
  if (seq !== storageRenderSeq) return; // a newer render superseded this one
  for (const row of rows) {
    list.append(el('li', { class: 'model-row' },
      el('div', { class: 'model-info' },
        el('span', { class: 'model-name' }, row.label),
        el('span', { class: 'model-meta mono' }, row.detail)),
      el('div', { class: 'model-actions' },
        row.download ? el('button', {
          class: 'btn btn--ghost', type: 'button',
          onclick: async (ev) => {
            const btn = ev.currentTarget;
            btn.disabled = true; btn.textContent = 'downloading…';
            try { await row.download(); btn.textContent = 'cached ✓'; toast(`${row.label} cached`); }
            catch (e) { btn.textContent = 'download'; toast(e.message, 'error'); }
          },
        }, 'download') : null,
        el('button', {
          class: 'btn btn--ghost', type: 'button',
          onclick: async () => { await row.clear?.(); toast(`${row.label} cache cleared`); renderStorage(); renderEngines(); },
        }, 'clear'),
      ),
    ));
  }

  const pct = quota ? Math.min(100, (usage / quota) * 100) : 0;
  $('#storageBar').style.width = `${Math.max(2, pct)}%`;
  $('#storageText').textContent = quota
    ? `${fmtBytes(usage)} of ~${fmtBytes(quota)} site storage used` : 'storage estimate unavailable';
}

// ------------------------------------------------------------------ boot --

function bindUI() {
  // dropzone
  const dz = $('#dropzone');
  dz.addEventListener('click', () => $('#fileInput').click());
  $('#fileInput').addEventListener('change', (e) => addFiles(e.target.files));
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; dz.classList.add('is-drag'); });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; dz.classList.remove('is-drag'); } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    dz.classList.remove('is-drag');
    if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
  });

  // convert / stop
  $('#convertBtn').addEventListener('click', convertAll);
  $('#stopBtn').addEventListener('click', () => { state.stopRequested = true; toast('Stopping after current page…'); });

  // view tabs
  $$('#viewTabs .seg-btn').forEach((t) => t.addEventListener('click', () => {
    state.tab = t.dataset.view;
    paintResultBody(state.results[state.activeResult]);
  }));

  // options
  $$('#dpiRow [data-dpi]').forEach((chip) => {
    chip.classList.toggle('is-active', +chip.dataset.dpi === settings.dpi);
    chip.addEventListener('click', () => {
      settings.dpi = +chip.dataset.dpi;
      saveSettings(settings);
      $$('#dpiRow [data-dpi]').forEach((c) => c.classList.toggle('is-active', c === chip));
    });
  });
  $$('#workersRow [data-workers]').forEach((chip) => {
    chip.classList.toggle('is-active', +chip.dataset.workers === settings.workers);
    chip.addEventListener('click', () => {
      settings.workers = +chip.dataset.workers;
      saveSettings(settings);
      $$('#workersRow [data-workers]').forEach((c) => c.classList.toggle('is-active', c === chip));
    });
  });

  const rangeInput = $('#pageRange');
  rangeInput.value = settings.pageRange;
  rangeInput.addEventListener('change', () => { settings.pageRange = rangeInput.value.trim(); saveSettings(settings); });

  const tokensInput = $('#maxTokens');
  tokensInput.value = settings.maxNewTokens;
  $('#tokensValue').textContent = settings.maxNewTokens;
  tokensInput.addEventListener('input', () => {
    settings.maxNewTokens = +tokensInput.value;
    $('#tokensValue').textContent = tokensInput.value;
    saveSettings(settings);
  });

  const normSelect = $('#normalizeSel');
  normSelect.value = settings.normalize;
  normSelect.addEventListener('change', () => { settings.normalize = normSelect.value; saveSettings(settings); });

  // language chips
  const langRow = $('#langChips');
  for (const [code, label] of LANGUAGES) {
    const chip = el('button', {
      class: `chip-btn${settings.langs.includes(code) ? ' is-active' : ''}`,
      type: 'button',
      onclick: () => {
        const set = new Set(settings.langs);
        if (set.has(code)) { if (set.size > 1) set.delete(code); } else set.add(code);
        settings.langs = [...set];
        saveSettings(settings);
        chip.classList.toggle('is-active', set.has(code));
      },
    }, label);
    langRow.append(chip);
  }

  // storage dialog
  const dlg = $('#storageDlg');
  $('#storageBtn').addEventListener('click', () => { dlg.showModal(); renderStorage(); });
  $('#storageClose').addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  dlg.addEventListener('close', renderEngines);

  // keyboard
  window.addEventListener('keydown', (e) => {
    if (!(e.target instanceof Element) || e.target.matches('input, select, textarea')
      || e.metaKey || e.ctrlKey || e.altKey) return;
    const hit = ENGINES.find((en) => en.key === e.key);
    if (hit) { selectEngine(hit.id, true); return; }
    if (e.key === 'Enter') { e.preventDefault(); convertAll(); }
    if (e.key === 'Escape') {
      if (dlg.open) dlg.close();
      else if (state.running) state.stopRequested = true;
    }
  });

  // header webgpu chip
  $('#gpuChip').textContent = webgpuAvailable() ? 'WebGPU ready' : 'No WebGPU — VLMs on CPU';
  $('#gpuChip').classList.toggle('is-off', !webgpuAvailable());

  // live star count on the GitHub button — silent if the API is unreachable
  fetch('https://api.github.com/repos/hessam-kk/Fast-md')
    .then((r) => (r.ok ? r.json() : null))
    .then((repo) => {
      if (typeof repo?.stargazers_count === 'number') {
        const el = $('#ghStars');
        if (el) el.textContent = `★ ${repo.stargazers_count}`;
      }
    })
    .catch(() => {});
}

function boot() {
  bindUI();
  renderEngines();
  selectEngine(state.engine, false);
  syncRunBar();
}

boot();
