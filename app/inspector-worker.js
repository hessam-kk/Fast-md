// Module worker for the pdf-inspector WASM parser (same Rust core as the
// pdf-inspector Python package in ocr-wrapper). processPdf() is synchronous
// and can block for seconds on large books — running it here keeps the UI
// and the page reel responsive.
import init, { processPdf, classifyPdf } from '../vendor/pdf-inspector/pdf_inspector_wasm.js';

let ready = null;

self.onmessage = async (event) => {
  const { id, bytes, options, classify } = event.data;
  try {
    ready ??= init();
    await ready;
    const result = classify
      ? classifyPdf(new Uint8Array(bytes))
      : processPdf(new Uint8Array(bytes), options);
    self.postMessage({ id, ok: true, result });
  } catch (error) {
    self.postMessage({ id, ok: false, error: String(error?.message || error) });
  }
};
