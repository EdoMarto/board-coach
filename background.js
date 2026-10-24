// Service worker: bridges the Chess.com page and the offscreen document running Stockfish.
importScripts('license/config.js', 'license/license.js');

const license = CPA_LICENSE.create({
  config: CPA_LICENSE_CONFIG,
  storage: {
    get: (k) => chrome.storage.local.get(k),
    set: (o) => chrome.storage.local.set(o),
    remove: (k) => chrome.storage.local.remove(k)
  },
  fetchFn: (...a) => fetch(...a),
  now: () => Math.floor(Date.now() / 1000),
  version: chrome.runtime.getManifest().version
});

const OFFSCREEN_URL = 'offscreen/offscreen.html';
const ports = new Map(); // jobId -> tab port
let creating = null;

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length) return;
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: ['WORKERS'],
        justification: 'Runs the Stockfish engine to analyze finished games.'
      })
      .finally(() => { creating = null; });
  }
  await creating;
}

async function sendToOffscreen(msg, tries = 10) {
  for (let i = 0; i < tries; i++) {
    try {
      await chrome.runtime.sendMessage({ target: 'offscreen', ...msg });
      return;
    } catch (e) {
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  throw new Error('The engine isn’t responding');
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'cpa-analisi') return;
  const mine = new Set();
  port.onMessage.addListener(async (msg) => {
    if (msg.cmd === 'ping') return; // keeps this service worker awake while a game page is open
    if (msg.cmd === 'stop') {
      ports.delete(msg.jobId);
      chrome.runtime.sendMessage({ target: 'offscreen', cmd: 'stop', jobId: msg.jobId }).catch(() => {});
      return;
    }
    if (msg.cmd !== 'start') return;
    // No valid license: the engine is never started.
    if (!(await license.ensure())) {
      try { port.postMessage({ jobId: msg.jobId, type: 'error', message: 'license' }); } catch (_) {}
      return;
    }
    mine.add(msg.jobId);
    ports.set(msg.jobId, port);
    try {
      await ensureOffscreen();
      await sendToOffscreen({ cmd: 'start', jobId: msg.jobId, fens: msg.fens, depth: msg.depth, multipv: msg.multipv });
    } catch (e) {
      try { port.postMessage({ jobId: msg.jobId, type: 'error', message: String(e.message || e) }); } catch (_) {}
    }
  });
  port.onDisconnect.addListener(() => {
    for (const id of mine) {
      ports.delete(id);
      chrome.runtime.sendMessage({ target: 'offscreen', cmd: 'stop', jobId: id }).catch(() => {});
    }
  });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.target !== 'background') return;
  const port = ports.get(msg.jobId);
  if (!port) return;
  try { port.postMessage(msg); } catch (_) { ports.delete(msg.jobId); }
  if (msg.type === 'done' || msg.type === 'error') ports.delete(msg.jobId);
});


// Messages from the settings window.
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (!msg || typeof msg.cmd !== 'string' || !msg.cmd.startsWith('license-')) return;
  (async () => {
    if (msg.cmd === 'license-status') return license.status();
    if (msg.cmd === 'license-activate') return license.activate(msg.key);
    if (msg.cmd === 'license-remove') return license.remove();
    return { ok: false, error: 'unknown' };
  })().then(reply, (e) => reply({ ok: false, error: String((e && e.message) || e) }));
  return true;
});

// Readable reasons in the console instead of "[object Object]".
self.addEventListener('unhandledrejection', (ev) => {
  const r = ev.reason;
  console.warn('[Board Coach] unhandled rejection:', (r && (r.stack || r.message)) || (typeof r === 'object' ? JSON.stringify(r) : String(r)));
});
