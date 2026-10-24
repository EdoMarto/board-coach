// Runs Stockfish (WASM, single-threaded) in a Web Worker and analyzes positions one at a time.
let worker = null;
let ready = null;
const queue = [];
let active = null; // { id, fens, depth, i, cancelled, last }

function send(cmd) { if (worker) worker.postMessage(cmd); }

let stallTimer = null;
let errTimer = null;
const STALL_MS = 25000;

// Readable reasons in the console instead of "[object Object]".
addEventListener('unhandledrejection', (ev) => {
  const r = ev.reason;
  console.warn('[Board Coach] unhandled rejection:', (r && (r.stack || r.message)) || (typeof r === 'object' ? JSON.stringify(r) : String(r)));
});

function initEngine() {
  if (ready) return ready;
  ready = new Promise((resolve) => {
    let res = resolve;
    const w = new Worker('../engine/stockfish.js');
    worker = w;
    w.onmessage = (e) => {
      if (w !== worker) return;
      clearTimeout(errTimer); // the engine is still answering: any earlier error was harmless
      const line = String(e.data);
      if (line === 'readyok' && res) { const r = res; res = null; r(); return; }
      onLine(line);
    };
    w.onerror = (e) => {
      // Handled here, so it doesn't also show up as an uncaught error of the extension.
      if (e && e.preventDefault) e.preventDefault();
      console.warn('[Board Coach] engine reported an error:', (e && e.message) || '(no message)', e && e.filename, e && e.lineno);
      if (w !== worker) return;
      // Idle engine: just start a fresh one next time. Busy engine: a harmless exception leaves it
      // answering, so only restart it if it goes quiet.
      if (!active) { resetEngine(); return; }
      clearTimeout(errTimer);
      errTimer = setTimeout(() => {
        if (w === worker && active && !active.cancelled) recover('Engine error: ' + ((e && e.message) || 'unknown'));
      }, 3000);
    };
    w.postMessage('uci');
    w.postMessage('setoption name Hash value 64');
    w.postMessage('isready');
    // Never became ready: give up on this worker; the stall check then retries with a new one.
    setTimeout(() => { if (res && w === worker) { resetEngine(); const r = res; res = null; r(); } }, 15000);
  });
  return ready;
}

// The engine crashed or stopped answering: start a fresh one and retry the current position once.
function resetEngine() {
  clearTimeout(stallTimer);
  clearTimeout(errTimer);
  if (worker) { try { worker.terminate(); } catch (_) {} }
  worker = null;
  ready = null;
}

function recover(message) {
  resetEngine();
  const job = active;
  if (!job) return;
  if ((job.retries || 0) >= 1) {
    report('error', { message });
    active = null;
    pump();
    return;
  }
  job.retries = (job.retries || 0) + 1;
  restartCurrent(job);
}

async function restartCurrent(job) {
  await initEngine();
  if (active !== job) return;
  send('ucinewgame');
  send('isready');
  analyzeCurrent();
}

function report(type, extra) {
  chrome.runtime.sendMessage({ target: 'background', jobId: active && active.id, type, ...extra }).catch(() => {});
}

function analyzeCurrent() {
  const job = active;
  clearTimeout(stallTimer);
  stallTimer = setTimeout(() => { if (active === job && !job.cancelled) recover('Engine stalled'); }, STALL_MS);
  job.last = { cp: null, mate: null, pv: [] };
  job.lines = [];
  send('setoption name MultiPV value ' + job.multipv);
  send('position fen ' + job.fens[job.i]);
  send('go depth ' + job.depth);
}

async function pump() {
  if (active || !queue.length) return;
  active = queue.shift();
  await initEngine();
  send('ucinewgame');
  send('isready');
  analyzeCurrent();
}

function onLine(line) {
  if (!active) return;
  if (line.startsWith('info ') && line.includes(' score ')) {
    const mp = line.match(/ multipv (\d+)/);
    const idx = mp ? parseInt(mp[1], 10) : 1;
    const sc = line.match(/ score (cp|mate) (-?\d+)/);
    if (!sc) return;
    const pv = line.match(/ pv (.+)$/);
    const entry = {
      cp: sc[1] === 'cp' ? parseInt(sc[2], 10) : null,
      mate: sc[1] === 'mate' ? parseInt(sc[2], 10) : null,
      pv: pv ? pv[1].trim().split(/\s+/) : []
    };
    if (idx === 1) {
      if (!entry.pv.length) entry.pv = active.last.pv;
      active.last = entry;
    }
    if (active.multipv > 1 && entry.pv.length) active.lines[idx - 1] = { cp: entry.cp, mate: entry.mate, pv: entry.pv.slice(0, 6) };
    return;
  }
  if (line.startsWith('bestmove')) {
    const job = active;
    clearTimeout(stallTimer);
    if (job.cancelled) { active = null; pump(); return; }
    const best = line.split(/\s+/)[1];
    let { cp, mate, pv } = job.last;
    if (best === '(none)' && mate === null && cp === null) cp = 0;
    const result = { cp, mate, best, pv: pv.slice(0, 8) };
    if (job.multipv > 1) result.lines = job.lines.filter(Boolean);
    report('progress', { index: job.i, total: job.fens.length, result });
    job.i++;
    if (job.i < job.fens.length) analyzeCurrent();
    else { report('done', {}); active = null; pump(); }
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.target !== 'offscreen') return;
  if (msg.cmd === 'start') {
    queue.push({ id: msg.jobId, fens: msg.fens, depth: Math.max(1, Math.min(22, msg.depth | 0 || 15)),
      multipv: Math.max(1, Math.min(256, msg.multipv | 0 || 1)), i: 0 });
    pump();
  } else if (msg.cmd === 'stop') {
    const qi = queue.findIndex((j) => j.id === msg.jobId);
    if (qi >= 0) queue.splice(qi, 1);
    if (active && active.id === msg.jobId) { active.cancelled = true; send('stop'); }
  }
});
