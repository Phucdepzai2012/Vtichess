/* Same-origin Stockfish worker wrapper.
 * Uses the multi-threaded WASM build only when the page is cross-origin isolated
 * and SharedArrayBuffer is available. Otherwise it safely uses the single-thread build.
 */
const STOCKFISH_BASES = [
  'https://unpkg.com/stockfish@18.0.8/bin/',
  'https://cdn.jsdelivr.net/npm/stockfish@18.0.8/bin/'
];
const THREADS_ENABLED = self.crossOriginIsolated === true &&
  typeof SharedArrayBuffer === 'function' && typeof Atomics === 'object';
const STOCKFISH_FILE = THREADS_ENABLED ? 'stockfish-18-lite.js' : 'stockfish-18-lite-single.js';
const STOCKFISH_WASM = THREADS_ENABLED ? 'stockfish-18-lite.wasm' : 'stockfish-18-lite-single.wasm';
let activeBase = STOCKFISH_BASES[0];

self.Module = self.Module || {};
self.Module.locateFile = function(path, prefix) {
  const cleanPath = String(path || '').split(/[?#]/, 1)[0];
  const file = cleanPath.split('/').pop();
  if (file && file.toLowerCase().endsWith('.wasm')) return activeBase + STOCKFISH_WASM;
  return (prefix || activeBase) + path;
};

// Report the selected local CPU mode before the engine's UCI handshake.
postMessage({
  type: 'engine-mode',
  threaded: THREADS_ENABLED,
  threads: THREADS_ENABLED ? Math.max(1, Math.min(4, (Number(navigator.hardwareConcurrency) || 2) - 1)) : 1
});

let lastLoadError = null;
for (const base of STOCKFISH_BASES) {
  activeBase = base;
  try {
    importScripts(activeBase + STOCKFISH_FILE);
    lastLoadError = null;
    break;
  } catch (error) {
    lastLoadError = error;
  }
}

if (lastLoadError) {
  postMessage({
    type: 'error',
    error: {
      message: 'Không tải được Stockfish từ unpkg hoặc jsDelivr: ' +
        (lastLoadError && lastLoadError.message ? lastLoadError.message : String(lastLoadError)),
      stack: lastLoadError && lastLoadError.stack ? String(lastLoadError.stack) : ''
    }
  });
}
