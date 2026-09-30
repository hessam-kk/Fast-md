# fast·md — PDF → Markdown, entirely in your browser

A local-first PDF-to-Markdown converter that runs as a static site on the
**Cloudflare free tier**. Drop a PDF, pick an engine, get clean Markdown —
**the file never leaves your device**, because there is no server: parsing,
OCR and vision models all run inside the browser tab (WebAssembly + WebGPU).

The engine lineup is the browser-native translation of
[ocr-wrapper](../ocr-Wrapper)'s tiers — its actual pdf-inspector parser as
official WebAssembly, plus light OCR and Bina-class vision-language OCR:

| # | Engine | Download | Best for | Runtime |
|---|--------|----------|----------|---------|
| 1 | **pdf-inspector** | ≈ 2.4 MB | Digital (text-based) PDFs — the same Rust parser ocr-wrapper calls, as its official WASM build | Web Worker |
| 2 | **Text layer** | 0 MB | Digital PDFs — homegrown structurer (heading inference, header/footer stripping) | pdf.js |
| 3 | **Tesseract** | ≈ 15 MB / language | Scans, 100+ languages incl. Persian | tesseract.js (WASM) |
| 4 | **SmolVLM 256M** | ≈ 260 MB | Tricky scans, small VLM | transformers.js (WebGPU/WASM) |
| 5 | **Qwen2-VL 2B** | ≈ 1.3 GB | Hard scans, best quality | transformers.js (WebGPU) |

## How it stays local & fast

- **No uploads.** pdf.js parses and renders pages on-device; the site is
  served as static files, so there is nothing to upload *to*.
- **Model caching.** VLM weights download once from the Hugging Face CDN
  into the browser's Cache API; Tesseract language data lands in IndexedDB.
  After the first run everything works offline. The **Model storage** panel
  shows what's cached, its size, and lets you pre-download or clear models.
- **Instant auto-picks.** Adding a PDF probes its text layer: digital PDFs
  preselect *pdf-inspector*, scans suggest an OCR engine. pdf-inspector also
  reports its classification (`TextBased`/`Scanned`/`Mixed`) and confidence
  in the result stats, and refuses scanned pages with a hint to switch
  engines — exactly like ocr-wrapper's `inspector.py`.
- **Structure-aware output.** The Text-layer engine rebuilds headings (font-size
  clustering), paragraphs, lists, and two-column reading order, drops running
  headers/footers, and stitches sentences cut by page breaks (ported from
  ocr-wrapper's merge logic). RTL documents are auto-detected and wrapped,
  with an optional Persian tidy-up (half-space/ZWNJ reinsertion, glyph and
  digit unification — a light hazm).

## Run locally

```bash
node serve.mjs          # → http://localhost:8788
```

No build step, no dependencies — the repo root **is** the site: plain ES
modules plus vendored libraries (`pdf.js`, `tesseract.js`, `marked`,
`pdf-inspector-wasm`). transformers.js and model weights stream from CDNs on
first use.

## Deploy

The site lives at the repository root, so both hosts pick it up with zero
build configuration. All internal paths are relative, so it also works when
served under a subpath.

### GitHub Pages

1. Push this repository to GitHub.
2. Repo **Settings → Pages → Build and deployment → Deploy from a branch**,
   branch `master`/`main`, folder `/ (root)`.
3. Done — `https://<user>.github.io/<repo>/` (or the user site if the repo is
   `<user>.github.io`). `.nojekyll` is included so GitHub serves `_headers`
   and everything as-is.

### Cloudflare Pages (free tier)

The project `fast-md` → https://fast-md.pages.dev is deployed from the root.

Option A — dashboard (Git integration):

1. Cloudflare dashboard → **Workers & Pages → fast-md → Settings → Build**:
   Build command *(none)*, output directory `/`.

Option B — CLI:

```bash
npx wrangler pages deploy . --project-name fast-md --branch main
```

`.assetsignore` documents the intended upload exclusions (legacy `pages
deploy` currently ignores it and serves `README.md` / `serve.mjs` as plain
files — harmless, they're public in the repo anyway; GitHub Pages serves
them too). `_headers` pins long caches for vendored libs. Model weights are
**not** deployed — they're fetched client-side from the Hugging Face CDN and
cached per visitor.

## Layout

```
/                        ← repo root = site root
├── index.html           # shell + import map
├── styles.css           # design system (ink chrome, paper well, PDF-red accent)
├── _headers             # Cloudflare Pages cache rules
├── .nojekyll            # GitHub Pages: serve as-is, no Jekyll
├── .assetsignore        # Cloudflare upload exclusions
├── serve.mjs            # local dev server (not deployed)
├── app/
│   ├── main.js           # orchestration: queue → engine → reel → result
│   ├── engines.js        # engine registry + language list
│   ├── inspector.js      # pdf-inspector WASM (worker-backed, same Rust core as ocr-wrapper)
│   ├── inspector-worker.js
│   ├── instant.js        # text layer → markdown (headings, columns, RTL)
│   ├── tess.js           # tesseract.js scheduler wrapper
│   ├── vlm.js            # transformers.js pipelines (SmolVLM, Qwen2-VL)
│   ├── pdfjs.js          # pdf.js open/render/probe helpers
│   ├── markdown.js       # page merge + RTL + Persian normalize (from ocr-wrapper)
│   ├── store.js          # settings + model-cache manifest
│   └── ui.js             # dom/toast helpers
└── vendor/               # pdf.js, tesseract.js, marked, pdf-inspector-wasm (pinned builds)
```

## Notes

- Qwen2-VL 2B wants WebGPU (Chrome/Edge 113+). Without it, engines fall back
  to WASM/CPU — slower but functional; the header chip tells you which.
- First VLM run downloads ~260 MB / ~1.3 GB; a live progress bar shows under
  the page reel, then it's cached for every future visit.
- Tesseract runs 1–4 parallel workers (default 2) over rendered pages at
  your chosen DPI.
- Why not run ocr-wrapper's exact engines (Bina-0.1, oneocr, Chrome Screen
  AI, the Rust pdf-inspector)? They need Python/torch/native DLLs and can't
  execute on Cloudflare's static tier — so fast·md mirrors each tier with a
  browser-native equivalent, keeping the same "instant / light / VLM"
  choice and the same output shaping.
