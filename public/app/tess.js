// Tesseract engine — lightweight classic OCR on WebAssembly (tesseract.js).
// Language data is fetched once per language and cached in IndexedDB by
// tesseract.js itself; the scheduler runs 1–4 workers in parallel.
import { renderPageBlob } from './pdfjs.js';

let scheduler = null;
let workerPool = [];
let loadedLangs = '';

const STATUS_LABELS = {
  'loading tesseract core': 'Loading OCR engine',
  'initializing tesseract': 'Starting OCR engine',
  'loading language traineddata': 'Downloading language data',
  'initializing api': 'Warming up',
};

function mapStatus(m) {
  const label = STATUS_LABELS[m.status];
  return label ? { label, progress: m.progress || 0 } : null;
}

async function buildScheduler(langs, workers, onStatus) {
  const T = window.Tesseract;
  if (!T) throw new Error('Tesseract failed to load — check your connection and reload the page.');
  const sched = T.createScheduler();
  const pool = [];
  for (let i = 0; i < workers; i++) {
    const worker = await T.createWorker(langs.join('+'), 1, {
      logger: (m) => {
        if (m.status === 'recognizing text') return;
        const s = mapStatus(m);
        if (s && i === 0) onStatus?.(s);
      },
    });
    sched.addWorker(worker);
    pool.push(worker);
  }
  return { sched, pool };
}

export async function ensureTesseract(langs, workers = 2, onStatus) {
  const key = langs.join('+');
  if (scheduler && loadedLangs === key) return;
  await terminateTesseract();
  const built = await buildScheduler(langs, Math.max(1, Math.min(4, workers)), onStatus);
  scheduler = built.sched;
  workerPool = built.pool;
  loadedLangs = key;
}

export async function terminateTesseract() {
  if (!scheduler) return;
  try { await scheduler.terminate(); } catch { /* ignore */ }
  scheduler = null;
  workerPool = [];
  loadedLangs = '';
}

function paragraphsFromResult(data) {
  try {
    const paras = [];
    for (const block of data.blocks || []) {
      for (const p of block.paragraphs || []) {
        const lineTexts = (p.lines || []).map((l) => l.text?.trim()).filter(Boolean);
        if (lineTexts.length) paras.push(lineTexts.join(' '));
      }
    }
    if (paras.length) return paras.join('\n\n');
  } catch { /* fall through to raw text */ }
  return (data.text || '').trim();
}

/**
 * OCR pages with Tesseract. Workers pull from a shared queue; results come
 * back per page via cb.onPageDone(pageNo, text) in completion order.
 */
export async function runTesseract(doc, pageNumbers, { dpi = 300, langs = ['eng'], workers = 2 }, cb) {
  await ensureTesseract(langs, workers, cb.onStatus);
  const queue = [...pageNumbers];
  const concurrency = Math.max(1, Math.min(workerPool.length || 1, 4));

  const runner = async () => {
    while (queue.length && !cb.shouldStop()) {
      const n = queue.shift();
      const page = await doc.getPage(n);
      const blob = await renderPageBlob(page, dpi);
      page.cleanup();
      const { data } = await scheduler.addJob('recognize', blob);
      cb.onPageDone(n, paragraphsFromResult(data));
    }
  };
  await Promise.all(Array.from({ length: concurrency }, runner));
}
