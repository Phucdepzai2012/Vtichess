/* Same-origin Stockfish worker wrapper.
 * Avoids creating a nested blob: worker, which can be blocked by worker-src CSP.
 * The Stockfish loader and its WASM are fetched from the pinned CDN release.
 */
const STOCKFISH_BASE = 'https://cdn.jsdelivr.net/npm/stockfish@18.0.8/bin/';
const STOCKFISH_JS = STOCKFISH_BASE + 'stockfish-18-lite-single.js';
const STOCKFISH_WASM = STOCKFISH_BASE + 'stockfish-18-lite-single.wasm';

self.Module = self.Module || {};
self.Module.locateFile = function(path, prefix) {
  const file = String(path || '').split(/[?#]/, 1)[0].split('/').pop();
  if (file && file.toLowerCase().endsWith('.wasm')) return STOCKFISH_WASM;
  return (prefix || STOCKFISH_BASE) + path;
};

try {
  importScripts(STOCKFISH_JS);
} catch (error) {
  postMessage({
    type: 'error',
    error: {
      message: error && error.message ? error.message : String(error),
      stack: error && error.stack ? String(error.stack) : ''
    }
  });
}
