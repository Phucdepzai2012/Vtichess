/* Stockfish WASM adapter for VtiChess.
 * Stockfish.js runs in a nested browser worker; move analysis stays on-device.
 * If the CDN/WASM cannot load, the existing VtiChess JS worker remains available as fallback.
 */
const STOCKFISH_BASE = 'https://cdn.jsdelivr.net/npm/stockfish@19.0.1/bin/';
const STOCKFISH_JS = STOCKFISH_BASE + 'stockfish-19-lite-single.js';
const STOCKFISH_WASM = STOCKFISH_BASE + 'stockfish-19-lite-single.wasm';

let fallbackWorker = null;
let fallbackReady = false;
let readySent = false;
let stockfishWorker = null;
let stockfishReady = false;
let stockfishDisabled = false;
let activeBackend = null;
let activeJob = null;
let stockfishBlobUrl = null;

function sendReady(engine) {
  if (readySent) return;
  readySent = true;
  postMessage({type:'ready', engine});
}

function startFallback() {
  try {
    fallbackWorker = new Worker(new URL('./vti-engine.worker.js', self.location.href));
    fallbackWorker.onmessage = function(event) {
      const msg = event.data || {};
      if (msg.type === 'ready') {
        fallbackReady = true;
        if (stockfishDisabled) sendReady('VtiChess JS dự phòng');
        return;
      }
      if (msg.type === 'result') {
        if (activeBackend !== 'fallback' || !activeJob || activeJob.id !== msg.id) return;
        activeJob = null;
        activeBackend = null;
        postMessage({...msg, engine:'VtiChess JS dự phòng'});
        return;
      }
      if (msg.type === 'progress') {
        if (activeBackend === 'fallback' && activeJob && activeJob.id === msg.id) {
          postMessage({...msg, engine:'VtiChess JS dự phòng'});
        }
        return;
      }
      if (msg.type === 'error') {
        if (activeBackend === 'fallback' && activeJob && activeJob.id === msg.id) {
          activeJob = null;
          activeBackend = null;
          postMessage(msg);
        }
      }
    };
    fallbackWorker.onerror = function() {
      if (!readySent) postMessage({type:'error', id:0, message:'Không thể khởi động engine dự phòng.'});
    };
  } catch (error) {
    postMessage({type:'error', id:0, message:'Không thể tạo engine dự phòng: ' + (error && error.message || error)});
  }
}

function skillLevelFor(botLevel) {
  if (botLevel < 200) return 0;
  if (botLevel < 400) return 2;
  if (botLevel < 600) return 3;
  if (botLevel < 800) return 4;
  if (botLevel < 1000) return 5;
  if (botLevel < 1100) return 6;
  if (botLevel < 1200) return 7;
  return 8;
}

function startStockfish() {
  try {
    const bootstrap = [
      'self.Module = self.Module || {};',
      'self.Module.locateFile = function(path, prefix) {',
      '  if (/\\.wasm(?:\\?|$)/.test(path)) return ' + JSON.stringify(STOCKFISH_WASM) + ';',
      '  return (prefix || ' + JSON.stringify(STOCKFISH_BASE) + ') + path;',
      '};',
      'importScripts(' + JSON.stringify(STOCKFISH_JS) + ');'
    ].join('\n');
    const blob = new Blob([bootstrap], {type:'text/javascript'});
    stockfishBlobUrl = URL.createObjectURL(blob);
    stockfishWorker = new Worker(stockfishBlobUrl);
    stockfishWorker.onmessage = function(event) { handleStockfishLine(event.data); };
    stockfishWorker.onerror = function() { disableStockfish('Không tải được Stockfish WASM; chuyển sang engine dự phòng.'); };
    stockfishWorker.postMessage('uci');
    setTimeout(function() {
      if (!stockfishReady) disableStockfish('Stockfish WASM khởi tạo quá lâu; dùng engine dự phòng.');
    }, 6500);
  } catch (error) {
    disableStockfish('Không tạo được Stockfish WASM: ' + (error && error.message || error));
  }
}

function disableStockfish(reason) {
  if (stockfishDisabled) return;
  stockfishDisabled = true;
  stockfishReady = false;
  if (stockfishWorker) {
    try { stockfishWorker.terminate(); } catch (_) {}
    stockfishWorker = null;
  }
  if (stockfishBlobUrl) {
    try { URL.revokeObjectURL(stockfishBlobUrl); } catch (_) {}
    stockfishBlobUrl = null;
  }
  postMessage({type:'engine', engine:'VtiChess JS dự phòng', detail:reason});
  if (activeBackend === 'stockfish' && activeJob && fallbackWorker && fallbackReady) {
    activeBackend = 'fallback';
    fallbackWorker.postMessage({...activeJob, type:'analyze'});
  }
  if (!readySent && fallbackReady) sendReady('VtiChess JS dự phòng');
}

function handleStockfishLine(data) {
  if (typeof data !== 'string') {
    if (data && data.error) disableStockfish(String(data.error));
    return;
  }
  const line = data.trim();
  if (!line) return;
  if (line === 'uciok') {
    if (!stockfishWorker || stockfishDisabled) return;
    stockfishWorker.postMessage('setoption name Threads value 1');
    stockfishWorker.postMessage('setoption name Hash value 32');
    stockfishWorker.postMessage('setoption name MultiPV value 1');
    stockfishWorker.postMessage('isready');
    return;
  }
  if (line === 'readyok') {
    if (stockfishDisabled) return;
    stockfishReady = true;
    postMessage({type:'engine', engine:'Stockfish 19 Lite WASM', detail:'Stockfish chạy trong trình duyệt; không gửi thế cờ lên API phân tích.'});
    sendReady('Stockfish 19 Lite WASM');
    return;
  }
  if (!activeJob || activeBackend !== 'stockfish') return;
  if (line.startsWith('info ')) {
    const depthMatch = line.match(/\bdepth\s+(\d+)/);
    const multiMatch = line.match(/\bmultipv\s+(\d+)/);
    const nodesMatch = line.match(/\bnodes\s+(\d+)/);
    const cpMatch = line.match(/\bscore\s+cp\s+(-?\d+)/);
    const mateMatch = line.match(/\bscore\s+mate\s+(-?\d+)/);
    const pvMarker = line.indexOf(' pv ');
    if (nodesMatch) activeJob.nodes = Math.max(activeJob.nodes || 0, Number(nodesMatch[1]) || 0);
    if (!depthMatch || pvMarker < 0 || (!cpMatch && !mateMatch)) return;
    const depth = Number(depthMatch[1]) || 1;
    const multipv = multiMatch ? Math.max(1, Number(multiMatch[1]) || 1) : 1;
    let score;
    if (cpMatch) score = Number(cpMatch[1]) || 0;
    else {
      const mate = Number(mateMatch[1]) || 0;
      score = mate === 0 ? 29998 : Math.sign(mate) * (30000 - Math.min(1000, Math.abs(mate) * 2));
    }
    const pv = line.slice(pvMarker + 4).trim();
    if (!pv) return;
    let bucket = activeJob.linesByDepth.get(depth);
    if (!bucket) { bucket = new Map(); activeJob.linesByDepth.set(depth, bucket); }
    bucket.set(multipv, {score, pv, depth, multipv});
    if (depth > activeJob.lastProgressDepth) {
      activeJob.lastProgressDepth = depth;
      postMessage({type:'progress', id:activeJob.id, depth, nodes:activeJob.nodes || 0, score, engine:'Stockfish 19 Lite WASM'});
    }
    return;
  }
  if (line.startsWith('bestmove ')) {
    const tokens = line.split(/\s+/);
    const bestmove = tokens[1] || '(none)';
    const job = activeJob;
    const requested = Math.max(1, Math.min(3, Number(job.multiPV) || 1));
    const depths = Array.from(job.linesByDepth.keys()).sort((a,b)=>b-a);
    let selectedDepth = 0;
    for (const depth of depths) {
      const bucket = job.linesByDepth.get(depth);
      let complete = true;
      for (let n=1; n<=requested; n++) if (!bucket.has(n)) { complete=false; break; }
      if (complete) { selectedDepth=depth; break; }
    }
    if (!selectedDepth) {
      selectedDepth = depths.find(depth => job.linesByDepth.get(depth).has(1)) || 0;
    }
    const selectedBucket = job.linesByDepth.get(selectedDepth);
    const lines = [];
    if (selectedBucket) {
      for (let n=1; n<=requested; n++) {
        const item = selectedBucket.get(n);
        if (item) lines.push({score:item.score, pv:item.pv});
      }
    }
    if (!lines.length && bestmove !== '(none)' && bestmove !== '0000') lines.push({score:0, pv:bestmove});
    const primary = selectedBucket && selectedBucket.get(1);
    activeJob = null;
    activeBackend = null;
    postMessage({
      type:'result', id:job.id, fen:job.fen, depth:selectedDepth,
      bestmove, score:primary ? primary.score : (lines[0] ? lines[0].score : 0),
      lines, nodes:job.nodes || 0, engine:'Stockfish 19 Lite WASM'
    });
  }
}

function runStockfishJob(job) {
  const botLevel = job.botLevel !== null && job.botLevel !== undefined && Number.isFinite(Number(job.botLevel))
    ? Number(job.botLevel) : null;
  const multiPV = Math.max(1, Math.min(3, Number(job.multiPV) || 1));
  const requestedTime = job.timeMs !== null && job.timeMs !== undefined && Number.isFinite(Number(job.timeMs))
    ? Number(job.timeMs) : null;
  const botTime = botLevel === null ? 700
    : botLevel < 500 ? 450
    : botLevel < 1200 ? 650
    : botLevel < 2000 ? 900
    : botLevel < 3000 ? 1300 : 1800;
  const timeMs = requestedTime === null ? botTime : Math.max(100, Math.min(7500, requestedTime));
  activeBackend = 'stockfish';
  activeJob = {...job, multiPV, nodes:0, lastProgressDepth:0, linesByDepth:new Map()};
  stockfishWorker.postMessage('setoption name MultiPV value ' + multiPV);
  if (botLevel !== null && botLevel >= 1320 && botLevel <= 3190) {
    stockfishWorker.postMessage('setoption name UCI_LimitStrength value true');
    stockfishWorker.postMessage('setoption name UCI_Elo value ' + Math.round(botLevel));
    stockfishWorker.postMessage('setoption name Skill Level value 20');
  } else {
    stockfishWorker.postMessage('setoption name UCI_LimitStrength value false');
    stockfishWorker.postMessage('setoption name Skill Level value ' + (botLevel === null ? 20 : skillLevelFor(botLevel)));
  }
  stockfishWorker.postMessage('position fen ' + String(job.fen));
  stockfishWorker.postMessage('go movetime ' + timeMs);
}

startFallback();
startStockfish();

onmessage = function(event) {
  const msg = event.data || {};
  if (msg.type === 'stop') {
    if (activeBackend === 'stockfish' && stockfishWorker) stockfishWorker.postMessage('stop');
    else if (fallbackWorker) fallbackWorker.postMessage(msg);
    return;
  }
  if (msg.type !== 'analyze') return;
  if (stockfishReady && !stockfishDisabled && stockfishWorker) {
    runStockfishJob(msg);
    return;
  }
  activeBackend = 'fallback';
  activeJob = msg;
  if (fallbackWorker && fallbackReady) fallbackWorker.postMessage(msg);
  else postMessage({type:'error', id:msg.id, message:'Engine chưa sẵn sàng.'});
};
