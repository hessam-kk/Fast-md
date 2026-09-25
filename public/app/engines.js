// Engine registry — one row in the UI rail per entry.
// The lineup mirrors ocr-Wrapper's tiers, translated to engines that run
// entirely inside the browser tab.

export const ENGINES = [
  {
    id: 'inspector',
    key: '1',
    name: 'pdf-inspector',
    tier: 'Fastest',
    size: '≈ 2.4 MB',
    sizeBytes: 2.4 * 1024 * 1024,
    blurb: 'The Rust parser from ocr-wrapper, compiled to WebAssembly — same package, same results.',
    needsModel: false,
    ocr: false,
  },
  {
    id: 'instant',
    key: '2',
    name: 'Text layer',
    tier: 'Heuristic',
    size: '0 MB',
    sizeBytes: 0,
    blurb: 'Homegrown text-layer structurer — bigger heading inference, header/footer stripping.',
    needsModel: false,
    ocr: false,
  },
  {
    id: 'tesseract',
    key: '3',
    name: 'Tesseract',
    tier: 'Light',
    size: '≈ 15 MB / language',
    sizeBytes: 15 * 1024 * 1024,
    blurb: 'Classic OCR on WebAssembly. 100+ languages including Persian. The scan default.',
    needsModel: 'langs',
    ocr: true,
  },
  {
    id: 'smolvlm',
    key: '4',
    name: 'SmolVLM 256M',
    tier: 'Tiny VLM',
    size: '≈ 260 MB',
    sizeBytes: 260 * 1024 * 1024,
    blurb: 'Small vision-language model — follows layout better than classic OCR. WebGPU.',
    needsModel: true,
    ocr: true,
  },
  {
    id: 'qwen',
    key: '5',
    name: 'Qwen2-VL 2B',
    tier: 'Best quality',
    size: '≈ 1.3 GB',
    sizeBytes: 1.35 * 1024 ** 3,
    blurb: 'Bina-class vision-language OCR for hard scans and dense layouts. WebGPU.',
    needsModel: true,
    ocr: true,
  },
];

export function engineById(id) {
  return ENGINES.find((e) => e.id === id) || ENGINES[0];
}

/** Common languages for the Tesseract picker (code → label). */
export const LANGUAGES = [
  ['eng', 'English'],
  ['fas', 'Persian'],
  ['ara', 'Arabic'],
  ['deu', 'German'],
  ['fra', 'French'],
  ['spa', 'Spanish'],
  ['ita', 'Italian'],
  ['por', 'Portuguese'],
  ['rus', 'Russian'],
  ['tur', 'Turkish'],
  ['chi_sim', 'Chinese'],
  ['jpn', 'Japanese'],
  ['kor', 'Korean'],
  ['hin', 'Hindi'],
  ['urd', 'Urdu'],
  ['heb', 'Hebrew'],
  ['nld', 'Dutch'],
  ['pol', 'Polish'],
  ['swe', 'Swedish'],
  ['ukr', 'Ukrainian'],
];
