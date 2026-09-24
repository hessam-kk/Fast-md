// Vision-language OCR engines via transformers.js (ONNX Runtime Web).
// Two tiers: SmolVLM-256M (tiny, ~260 MB) and Qwen2-VL-2B (Bina-class
// quality, ~1.3 GB). WebGPU when available, WASM fallback. Weights are
// downloaded from the Hugging Face CDN on first use and then served from
// the browser's cache — tracked in the model manifest.
import { renderPageJpeg } from './pdfjs.js';
import { trackModelProgress } from './store.js';

export const VLM_DEFS = {
  smolvlm: {
    repo: 'HuggingFaceTB/SmolVLM-256M-Instruct',
    label: 'SmolVLM 256M',
    approxBytes: 260 * 1024 * 1024,
    dtype: 'q4f16',
  },
  qwen: {
    repo: 'onnx-community/Qwen2-VL-2B-Instruct',
    label: 'Qwen2-VL 2B',
    approxBytes: 1.35 * 1024 ** 3,
    dtype: 'q4f16',
  },
};

const PROMPT =
  'Transcribe all text in this image exactly as it appears. Keep the original paragraph breaks. Output only the transcription.';

let pipe = null;
let pipeKey = '';
let usedDevice = '';

export function webgpuAvailable() {
  return !!navigator.gpu;
}

async function importTransformers() {
  let mod;
  try {
    mod = await import('@huggingface/transformers');
  } catch (error) {
    throw new Error(
      'Could not load the OCR runtime from the CDN — check your internet '
      + 'connection and reload. (' + (error?.message || error) + ')',
    );
  }
  mod.env.allowLocalModels = false; // always resolve from the HF CDN
  return mod;
}

/** Load (or reuse) a VLM pipeline. Falls back to WASM when WebGPU fails. */
export async function ensureVlm(defId, onStatus) {
  if (pipe && pipeKey === defId) return pipe;
  if (pipe) {
    try { await pipe.dispose(); } catch { /* ignore */ }
    pipe = null;
  }
  const def = VLM_DEFS[defId];
  const { pipeline } = await importTransformers();
  const progress = (event) => {
    trackModelProgress(def.repo, event);
    if (event.status === 'progress' && event.total) {
      onStatus?.({
        label: `Downloading ${def.label} — ${event.file.split('/').pop()}`,
        progress: event.loaded / event.total,
        bytes: { loaded: event.loaded, total: event.total },
      });
    }
  };
  const attempts = webgpuAvailable()
    ? [{ device: 'webgpu', dtype: def.dtype }, { device: 'wasm', dtype: 'q4' }]
    : [{ device: 'wasm', dtype: 'q4' }];

  let lastError;
  for (const options of attempts) {
    try {
      onStatus?.({ label: `Loading ${def.label} (${options.device.toUpperCase()})` });
      pipe = await pipeline('image-text-to-text', def.repo, { ...options, progress_callback: progress });
      pipeKey = defId;
      usedDevice = options.device;
      return pipe;
    } catch (error) {
      lastError = error;
      console.warn(`[fast-md] ${def.label} failed on ${options.device}:`, error);
    }
  }
  throw new Error(`Could not load ${def.label}: ${lastError?.message || lastError}`);
}

export function currentVlmDevice() {
  return usedDevice;
}

export async function disposeVlm() {
  if (!pipe) return;
  try { await pipe.dispose(); } catch { /* ignore */ }
  pipe = null;
  pipeKey = '';
}

function cleanVlmOutput(text) {
  return String(text)
    .replace(/^#+\s*/gm, '') // models sometimes add spurious headings
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Transcribe pages with a VLM. cb.onPageDone(pageNo, markdown). */
export async function runVlm(defId, doc, pageNumbers, { dpi = 200, maxNewTokens = 1024 }, cb) {
  const generator = await ensureVlm(defId, cb.onStatus);
  cb.onReady?.({ device: usedDevice });

  for (const n of pageNumbers) {
    if (cb.shouldStop()) break;
    const page = await doc.getPage(n);
    const blob = await renderPageJpeg(page, dpi);
    page.cleanup();
    const url = URL.createObjectURL(blob);
    let text = '';
    try {
      const messages = [{
        role: 'user',
        content: [
          { type: 'image', image: url },
          { type: 'text', text: PROMPT },
        ],
      }];
      const output = await generator(messages, { max_new_tokens: maxNewTokens });
      const gen = Array.isArray(output) ? output[0]?.generated_text : output?.generated_text;
      text = typeof gen === 'string' ? gen : gen?.at(-1)?.content || '';
    } finally {
      URL.revokeObjectURL(url);
    }
    cb.onPageDone(n, cleanVlmOutput(text));
  }
}
