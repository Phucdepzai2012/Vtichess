/* Stockfish WASM adapter for VtiChess.
 * Stockfish.js runs in a nested browser worker; move analysis stays on-device.
 * If the CDN/WASM cannot load, the existing VtiChess JS worker remains available as fallback.
 */
// Pin 18.0.8: Stockfish.js 19.0.1 Lite Single has a confirmed search hang
// on a tactical position (upstream nmrugg/stockfish.js issue #124).
const STOCKFISH_BASE = 'https://cdn.jsdelivr.net/npm/stockfish@18.0.8/bin/';
const STOCKFISH_JS = STOCKFISH_BASE + 'stockfish-18-lite-single.js';
const STOCKFISH_WASM = STOCKFISH_BASE + 'stockfish-18-lite-single.wasm';

let fallbackWorker = null;
let fallbackReady = false;
let readySent = false;
let stockfishWorker = null;
let stockfishReady = false;
let stockfishDisabled = false;
let activeBackend = null;
let activeJob = null;
let queuedStockfishJobs = [];

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
        // Let the app start immediately using the working fallback while Stockfish loads.
        // If Stockfish completes later, its "engine" event updates the visible engine status.
        sendReady('VtiChess JS dự phòng');
        if (stockfishDisabled) dispatchNextStockfishJob();
        return;
      }
      if (msg.type === 'result') {
        if (activeBackend !== 'fallback' || !activeJob || activeJob.id !== msg.id) return;
        activeJob = null;
        activeBackend = null;
        postMessage({...msg, engine:'VtiChess JS dự phòng'});
        dispatchNextStockfishJob();
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
          dispatchNextStockfishJob();
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
    // Serve the nested worker from this repository instead of a blob: URL.
    // This also works on hosts whose Content-Security-Policy disallows worker-src blob:.
    stockfishWorker = new Worker(new URL('./stockfish.worker.js', self.location.href));
    stockfishWorker.onmessage = function(event) { handleStockfishLine(event.data); };
    stockfishWorker.onerror = function(event) {
      const details = event && event.message ? String(event.message) : 'Worker phát sinh lỗi không có thông tin chi tiết.';
      disableStockfish('Stockfish worker lỗi: ' + details);
    };
    stockfishWorker.onmessageerror = function() {
      disableStockfish('Không đọc được thông điệp từ Stockfish worker; dùng engine dự phòng.');
    };
    stockfishWorker.postMessage('uci');
    setTimeout(function() {
      if (!stockfishReady) {
        disableStockfish('Stockfish chưa gửi readyok sau 20 giây. Kiểm tra kết nối CDN hoặc lỗi tải tệp WASM; engine dự phòng vẫn hoạt động.');
      }
    }, 20000);
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
  // Preserve the active request and queued requests when Stockfish fails mid-session.
  if (activeBackend === 'stockfish' && activeJob) {
    const interrupted = activeJob;
    activeJob = null;
    activeBackend = null;
    if (!interrupted.cancelled) queuedStockfishJobs.unshift(interrupted);
    else postMessage({type:'error', id:interrupted.id, message:'Phân tích đã bị hủy.'});
  }

  postMessage({type:'engine', engine:'VtiChess JS dự phòng', detail:reason});
  if (!readySent && fallbackReady) sendReady('VtiChess JS dự phòng');
  if (fallbackReady) dispatchNextStockfishJob();
}

function dispatchNextStockfishJob() {
  if (activeJob || !queuedStockfishJobs.length) return;
  const next = queuedStockfishJobs.shift();
  if (stockfishReady && !stockfishDisabled && stockfishWorker) {
    runStockfishJob(next);
    return;
  }
  if (fallbackWorker && fallbackReady) {
    activeBackend = 'fallback';
    activeJob = next;
    fallbackWorker.postMessage({...next, type:'analyze'});
    return;
  }
  queuedStockfishJobs.unshift(next);
}

function handleStockfishLine(data) {
  if (typeof data !== 'string') {
    if (data && data.error) {
      const detail = data.error.stack || data.error.message || String(data.error);
      disableStockfish('Stockfish trả về lỗi: ' + detail);
    }
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
    postMessage({type:'engine', engine:'Stockfish 18.0.8 Lite Single WASM', detail:'Stockfish chạy trong trình duyệt; không gửi thế cờ lên API phân tích.'});
    sendReady('Stockfish 18.0.8 Lite Single WASM');
    return;
  }
  if (!activeJob || activeBackend !== 'stockfish') return;
  if (activeJob.cancelled && !line.startsWith('bestmove ')) return;
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
      postMessage({type:'progress', id:activeJob.id, depth, nodes:activeJob.nodes || 0, score, engine:'Stockfish 18.0.8 Lite Single WASM'});
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
    let matchingDepth = 0;
    // Prefer a depth whose primary PV agrees with Stockfish's final bestmove.
    // MultiPV can leave the newest iteration incomplete when the time limit expires.
    for (const depth of depths) {
      const bucket = job.linesByDepth.get(depth);
      const primary = bucket.get(1);
      const firstMove = primary && primary.pv ? primary.pv.trim().split(/\s+/)[0] : '';
      if (firstMove !== bestmove) continue;
      if (!matchingDepth) matchingDepth = depth;
      let complete = true;
      for (let n=1; n<=requested; n++) if (!bucket.has(n)) { complete=false; break; }
      if (complete) { selectedDepth=depth; break; }
    }
    if (!selectedDepth) {
      selectedDepth = matchingDepth || depths.find(depth => job.linesByDepth.get(depth).has(1)) || 0;
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
    const cancelled = !!job.cancelled;
    activeJob = null;
    activeBackend = null;
    if (cancelled) {
      postMessage({type:'error', id:job.id, message:'Phân tích đã bị hủy.'});
    } else {
      postMessage({
        type:'result', id:job.id, fen:job.fen, depth:selectedDepth,
        bestmove, score:primary ? primary.score : (lines[0] ? lines[0].score : 0),
        lines, nodes:job.nodes || 0, engine:'Stockfish 18.0.8 Lite Single WASM'
      });
    }
    dispatchNextStockfishJob();
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
    // Ratings above the calibrated UCI_Elo range should use full strength, not Skill Level 8.
    const skill = botLevel === null || botLevel > 3190 ? 20 : skillLevelFor(botLevel);
    stockfishWorker.postMessage('setoption name Skill Level value ' + skill);
  }
  stockfishWorker.postMessage('position fen ' + String(job.fen));
  stockfishWorker.postMessage('go movetime ' + timeMs);
}

startFallback();
startStockfish();

onmessage = function(event) {
  const msg = event.data || {};
  if (msg.type === 'stop') {
    for (const queued of queuedStockfishJobs.splice(0)) {
      postMessage({type:'error', id:queued.id, message:'Phân tích đã bị hủy.'});
    }
    if (activeBackend === 'stockfish' && stockfishWorker && activeJob) {
      activeJob.cancelled = true;
      stockfishWorker.postMessage('stop');
    } else if (activeBackend === 'fallback' && fallbackWorker && activeJob) {
      const cancelled = activeJob;
      activeJob = null;
      activeBackend = null;
      fallbackWorker.postMessage(msg);
      postMessage({type:'error', id:cancelled.id, message:'Phân tích đã bị hủy.'});
    } else if (fallbackWorker) {
      fallbackWorker.postMessage(msg);
    }
    return;
  }
  if (msg.type !== 'analyze') return;

  // UCI engines must finish the current search and emit bestmove before another
  // position is started; otherwise a stale bestmove can be attached to a new FEN.
  if (activeJob) {
    queuedStockfishJobs.push(msg);
    return;
  }
  if (stockfishReady && !stockfishDisabled && stockfishWorker) {
    runStockfishJob(msg);
    return;
  }
  if (fallbackWorker && fallbackReady) {
    activeBackend = 'fallback';
    activeJob = msg;
    fallbackWorker.postMessage(msg);
    return;
  }
  postMessage({type:'error', id:msg.id, message:'Engine chưa sẵn sàng.'});
};
