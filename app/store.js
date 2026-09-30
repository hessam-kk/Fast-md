// Settings persistence + model cache management.
//
// transformers.js stores model files in the Cache API under
// 'transformers-cache'; tesseract.js stores language data in IndexedDB
// ('~/.tesseract/*'). We track what we downloaded through progress callbacks
// in a localStorage manifest so the UI can show sizes without walking caches.

const SETTINGS_KEY = 'fastmd.settings.v1';
const MODELS_KEY = 'fastmd.models.v1';

const DEFAULTS = {
  engine: 'inspector',
  dpi: 300,
  langs: ['eng'],
  normalize: 'auto', // 'auto' | 'on' | 'off'
  workers: 2,
  maxNewTokens: 1024,
  pageRange: '', // '' = all, else "1-10, 15"
};

export function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch { /* private mode etc. */ }
}

// ---- model manifest --------------------------------------------------------

function readManifest() {
  try {
    return JSON.parse(localStorage.getItem(MODELS_KEY) || '{}');
  } catch {
    return {};
  }
}

function writeManifest(m) {
  try {
    localStorage.setItem(MODELS_KEY, JSON.stringify(m));
  } catch { /* ignore */ }
}

/** Record download progress from a transformers.js progress_callback. */
export function trackModelProgress(repo, event) {
  if (!event?.file || event.status === 'progress' || event.status === 'done') {
    const m = readManifest();
    const entry = m[repo] ?? { files: {}, bytes: 0, at: 0 };
    if (event.status === 'progress' || event.status === 'initiate') {
      entry.files[event.file] = event.total || entry.files[event.file] || 0;
    } else if (event.status === 'done') {
      entry.files[event.file] = event.loaded || entry.files[event.file] || 0;
    }
    entry.bytes = Object.values(entry.files).reduce((a, b) => a + b, 0);
    entry.at = Date.now();
    m[repo] = entry;
    writeManifest(m);
  }
}

/** Bytes recorded for a model repo (0 if never downloaded here). */
export function manifestBytes(repo) {
  return readManifest()[repo]?.bytes || 0;
}

/** Verify a repo is actually present in the transformers.js cache. */
export async function transformersCacheState(repo) {
  const bytes = manifestBytes(repo);
  if (!bytes) return { cached: false, bytes: 0 };
  try {
    const cache = await caches.open('transformers-cache');
    const hit = await cache.match(`https://huggingface.co/${repo}/resolve/main/config.json`);
    return { cached: !!hit, bytes };
  } catch {
    return { cached: true, bytes }; // Cache API unavailable — trust manifest
  }
}

/** Remove a repo from the transformers.js cache + manifest. */
export async function clearTransformersCache(repo) {
  try {
    const cache = await caches.open('transformers-cache');
    const keys = await cache.keys();
    await Promise.all(keys
      .filter((k) => k.url.includes(`/${repo}/`))
      .map((k) => cache.delete(k)));
  } catch { /* ignore */ }
  const m = readManifest();
  delete m[repo];
  writeManifest(m);
}

// tesseract.js v7 keeps language data in IndexedDB 'keyval-store' (idb-keyval),
// keys like './eng.traineddata'
async function tesseractCachedLangs() {
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open('keyval-store');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  try {
    if (!db.objectStoreNames.contains('keyval')) return [];
    const keys = await new Promise((resolve, reject) => {
      const tx = db.transaction('keyval', 'readonly');
      const req = tx.objectStore('keyval').getAllKeys();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return keys.map(String)
      .map((k) => k.match(/([a-z]{2,3}(?:_[a-z]{3,4})?)\.traineddata$/i)?.[1])
      .filter(Boolean);
  } finally {
    db.close();
  }
}

/** Best-effort probe of tesseract language caches (IndexedDB). */
export async function tesseractCacheState() {
  try {
    return { known: true, langs: await tesseractCachedLangs() };
  } catch {
    return { known: false };
  }
}

export async function clearTesseractCache() {
  try {
    const req = indexedDB.deleteDatabase('keyval-store');
    await new Promise((res) => { req.onsuccess = req.onerror = req.onblocked = res; });
  } catch { /* ignore */ }
}

/** Overall storage usage for the storage panel. */
export async function storageEstimate() {
  try {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    return { usage, quota };
  } catch {
    return { usage: 0, quota: 0 };
  }
}
