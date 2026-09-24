// pdf.js loading, page rendering and text access — one place, so engines
// never touch pdf.js directly.
import * as pdfjsLib from '../vendor/pdfjs/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  '../vendor/pdfjs/pdf.worker.min.mjs',
  import.meta.url,
).toString();

const openTasks = new WeakMap();

/** Open a PDF from an ArrayBuffer. Throws pdf.js exceptions (e.g. passwords). */
export async function openPdf(data) {
  const task = pdfjsLib.getDocument({
    data,
    isEvalSupported: false,
    useSystemFonts: true,
  });
  const doc = await task.promise;
  openTasks.set(doc, task);
  return doc;
}

/** Free a document's worker memory (destroy lives on the loading task). */
export function closePdf(doc) {
  const task = openTasks.get(doc);
  openTasks.delete(doc);
  if (task) task.destroy();
}

/** Render one page to a PNG blob at the given DPI. */
export async function renderPageBlob(page, dpi) {
  const viewport = page.getViewport({ scale: dpi / 72 });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

/** Render one page to a JPEG blob (smaller payload for VLM engines). */
export async function renderPageJpeg(page, dpi, quality = 0.94) {
  const viewport = page.getViewport({ scale: Math.min(dpi, 220) / 72 });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}

/** Quick probe: average extractable characters per page over a sample. */
export async function probeTextDensity(doc, sample = 4) {
  const n = Math.min(sample, doc.numPages);
  if (!n) return 0;
  let chars = 0;
  for (let i = 1; i <= n; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    chars += tc.items.reduce((a, it) => a + (it.str?.trim().length || 0), 0);
    page.cleanup();
  }
  return chars / n;
}
