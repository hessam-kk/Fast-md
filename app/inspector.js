// pdf-inspector engine — the exact parser ocr-wrapper uses (pdf_inspector
// process_pdf), here as its official WebAssembly build: same Rust core,
// same pdfType / markdown / pagesNeedingOcr result. One job per document
// (not per page); the worker owns the blocking parse.
let worker = null;
let seq = 0;
const pending = new Map();

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./inspector-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (event) => {
    const { id, ok, result, error } = event.data;
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    ok ? entry.resolve(result) : entry.reject(new Error(error));
  };
  worker.onerror = () => {
    // module/wasm failed to load — fail everything queued
    for (const { reject } of pending.values()) {
      reject(new Error('pdf-inspector failed to load — check your connection and reload'));
    }
    pending.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

/**
 * Extract markdown from raw PDF bytes.
 * cb.onStatus receives load/extract phases; pageNumbers restricts pages
 * (undefined options = whole document).
 */
export async function runInspector(bytes, pageNumbers, cb = {}) {
  const target = ensureWorker();
  cb.onStatus?.({ label: 'Extracting with pdf-inspector (Rust · WASM)', progress: null });

  const id = ++seq;
  const options = pageNumbers ? { pages: pageNumbers } : undefined;
  const buffer = bytes.slice(0); // transferred to the worker — keep caller's copy intact
  const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  target.postMessage({ id, bytes: buffer, options }, [buffer]);
  const result = await promise;

  cb.onStatus?.(null);
  if (!result.markdown) {
    const pages = result.pagesNeedingOcr?.length || result.pageCount;
    throw new Error(
      `pdf-inspector: no text layer (${result.pdfType}, ${pages} page(s) need OCR) — press 3 for Tesseract or 4/5 for a vision model`,
    );
  }
  return result;
}

/**
 * Fast classification (pdfType, pageCount, pagesNeedingOcr) without
 * extraction — the same detect step ocr-wrapper relies on. Used to
 * auto-pick an engine when a PDF is added.
 */
export async function classifyInspector(bytes) {
  const target = ensureWorker();
  const id = ++seq;
  const buffer = bytes.slice(0);
  const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  target.postMessage({ id, bytes: buffer, classify: true }, [buffer]);
  return promise;
}

export function inspectorVersion(mod) {
  return mod?.version?.();
}
