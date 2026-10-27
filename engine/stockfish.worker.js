/* Same-origin Stockfish worker wrapper.
 * Tries two public npm CDNs and keeps the WASM on the same CDN that served the loader.
 * This avoids making the whole engine depend on jsDelivr being reachable from the user's network.
 */
const STOCKFISH_BASES = [
  'https://unpkg.com/stockfish@18.0.8/bin/',
  'https://cdn.jsdelivr.net/npm/stockfish@18.0.8/bin/'
];
const STOCKFISH_FILE = 'stockfish-18-lite-single.js';
let activeBase = STOCKFISH_BASES[0];

self.Module = self.Module || {};
self.Module.locateFile = function(path, prefix) {
  const cleanPath = String(path || '').split(/[?#]/, 1)[0];
  const file = cleanPath.split('/').pop();
  if (file && file.toLowerCase().endsWith('.wasm')) return activeBase + file;
  return (prefix || activeBase) + path;
};

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
