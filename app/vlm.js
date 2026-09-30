// Vision-language OCR engines via transformers.js (ONNX Runtime Web).
// Two tiers: SmolVLM-256M (tiny, ~260 MB) and Qwen2-VL-2B (Bina-class
// quality, ~1.3 GB). WebGPU when available, WASM fallback. Weights are
// downloaded from the Hugging Face CDN on first use and then served from
// the browser's cache — tracked in the model manifest.
//
// v4 note: the `image-text-to-text` pipeline task no longer exists, and the
// surviving `image-to-text` pipeline sends no text prompt — useless for
// instruction-tuned OCR. So we drive the model directly: tokenizer chat
// template → processor(text, image) → model.generate → decode, which is
// both the official example flow and the mirror of ocr-wrapper's Python
// generate loop.
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

let model = null;
let tokenizer = null;
let processor = null;
let lib = null; // the transformers.js module, cached after first import
let loadedRepo = '';
let usedDevice = '';

export function webgpuAvailable() {
  return !!navigator.gpu;
}

async function importTransformers() {
  let T;
  try {
    T = await import('@huggingface/transformers');
  } catch (error) {
    throw new Error(
      'Could not load the OCR runtime from the CDN — check your internet '
      + 'connection and reload. (' + (error?.message || error) + ')',
    );
  }
  T.env.allowLocalModels = false; // always resolve from the HF CDN
  lib = T;
  return T;
}

function makeProgress(def, onStatus) {
  return (event) => {
    trackModelProgress(def.repo, event);
    if (event.status === 'progress' && event.total) {
      onStatus?.({
        label: `Downloading ${def.label} — ${event.file.split('/').pop()}`,
        progress: event.loaded / event.total,
        bytes: { loaded: event.loaded, total: event.total },
      });
    }
  };
}

/** Load (or reuse) a VLM trio (tokenizer, processor, model). */
export async function ensureVlm(defId, onStatus) {
  if (model && loadedRepo === defId) return;
  if (model) await disposeVlm();
  const def = VLM_DEFS[defId];
  const T = await importTransformers();
  const progress = makeProgress(def, onStatus);

  onStatus?.({ label: `Loading ${def.label} tokenizer` });
  tokenizer = await T.AutoTokenizer.from_pretrained(def.repo, { progress_callback: progress });
  processor = await T.AutoProcessor.from_pretrained(def.repo, { progress_callback: progress });

  const attempts = webgpuAvailable()
    ? [{ device: 'webgpu', dtype: def.dtype }, { device: 'wasm', dtype: 'q4' }]
    : [{ device: 'wasm', dtype: 'q4' }];

  let lastError;
  for (const options of attempts) {
    try {
      onStatus?.({ label: `Loading ${def.label} (${options.device.toUpperCase()})` });
      model = await T.AutoModelForImageTextToText.from_pretrained(def.repo, {
        ...options,
        progress_callback: progress,
      });
      loadedRepo = defId;
      usedDevice = options.device;
      return;
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
  if (!model) return;
  try { await model.dispose?.(); } catch { /* ignore */ }
  model = null;
  tokenizer = null;
  processor = null;
  loadedRepo = '';
}

function cleanVlmOutput(text) {
  return String(text)
    .replace(/^#+\s*/gm, '') // models sometimes add spurious headings
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Transcribe pages with a VLM. cb.onPageDone(pageNo, markdown). */
export async function runVlm(defId, doc, pageNumbers, { dpi = 200, maxNewTokens = 1024 }, cb) {
  await ensureVlm(defId, cb.onStatus);
  cb.onReady?.({ device: usedDevice });

  for (const n of pageNumbers) {
    if (cb.shouldStop()) break;
    const page = await doc.getPage(n);
    const blob = await renderPageJpeg(page, dpi);
    page.cleanup();

    let text = '';
    const image = await lib.RawImage.fromBlob(blob);
    const conversation = [{
      role: 'user',
      content: [
        { type: 'image' },
        { type: 'text', text: PROMPT },
      ],
    }];
    const promptText = tokenizer.apply_chat_template(conversation, {
      add_generation_prompt: true,
      tokenize: false,
    });
    const inputs = await processor(promptText, [image]);
    const output = await model.generate({ ...inputs, max_new_tokens: maxNewTokens });
    const promptLen = inputs.input_ids.dims.at(-1);
    const generated = output.slice(null, [promptLen, null]);
    const decoded = tokenizer.batch_decode(generated, { skip_special_tokens: true });
    text = decoded[0] || '';
    cb.onPageDone(n, cleanVlmOutput(text));
  }
}
