// Board Coach: move suggestions vs the computer and game analysis on the Chess.com board.
// Runs ONLY after a game has ended: using an engine during a live game breaks Chess.com's rules.
(() => {
  'use strict';
  if (window.__cpaLoaded) return;
  window.__cpaLoaded = true;

  const A = CPA_ANALYSIS;
  const CLS = {
    best: { label: 'Best move', glyph: '★', color: '#81b64c' },
    good: { label: 'Good move', glyph: '✓', color: '#97af8b' },
    forced: { label: 'Forced move', glyph: '□', color: '#97af8b' },
    inaccuracy: { label: 'Inaccuracy', glyph: '?!', color: '#f7c045' },
    mistake: { label: 'Mistake', glyph: '?', color: '#ffa459' },
    blunder: { label: 'Blunder', glyph: '??', color: '#fa412d' }
  };

  const S = {
    settings: { depth: 15, auto: true, arrows: true, evalbar: true, botLive: true, coach: true,
      suggest: 'engine', topN: 3, humanElo: 1200, oppTurn: false, verdicts: true, style: 'arrows' },
    game: null,          // { key, id, white, black, fens, plies, placements }
    evals: [],
    result: null,        // output of classify
    running: false,
    done: false,
    port: null,
    jobId: null,
    viewPly: null,       // ply currently shown (read from the board)
    onBoard: false,      // the board shows a position from the game
    triggered: new Set(),
    attempts: {},
    offGame: false,      // the user is looking at a position outside the game
    minimized: false,
    board: null,
    lastRect: ''
  };

  // ---------- Settings ----------
  chrome.storage.sync.get(S.settings, (v) => {
    Object.assign(S.settings, v);
    if (v.coach === false && v.suggest === 'engine') S.settings.suggest = 'off'; // older versions
    normalizeSettings();
  });
  // Options that are no longer configurable stay at their defaults; "both" was removed.
  function normalizeSettings() {
    Object.assign(S.settings, { auto: true, arrows: true, evalbar: true, botLive: true });
    if (S.settings.suggest === 'both') S.settings.suggest = 'engine';
  }
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'local' && ch.cpaLicense) {
      // The license changed (activated, renewed or denied): try again.
      LIVE.licenseBlocked = false; licenseToasted = false; LIVE.key = null;
      try { liveTick(); } catch (_) {}
      return;
    }
    if (area !== 'sync') return;
    for (const k in ch) S.settings[k] = ch[k].newValue;
    normalizeSettings();
    LIVE.key = null;
    liveTick();
    drawOverlay();
  });

  // ---------- UI (Shadow DOM, so Chess.com styles stay untouched) ----------
  const host = document.createElement('div');
  host.id = 'cpa-host';
  host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483000;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
  <style>
    :host { all: initial; }
    * { box-sizing: border-box; }
    .ui { font: 13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #ece6dc; }
    .panel { position: fixed; top: 88px; right: 16px; width: 300px; max-height: calc(100vh - 110px);
      display: flex; flex-direction: column; background: #262421; border: 1px solid #3c3934;
      border-radius: 10px; box-shadow: 0 12px 32px rgba(0,0,0,.45); overflow: hidden; }
    .panel[hidden] { display: none; }
    .head { display: flex; align-items: center; gap: 8px; padding: 8px 10px; background: #1e1c1a; cursor: move; user-select: none; }
    .head .title { font-weight: 650; font-size: 13px; flex: 1; }
    .head button { all: unset; cursor: pointer; width: 22px; height: 22px; display: grid; place-items: center;
      border-radius: 5px; color: #a59d90; font-size: 15px; }
    .head button:hover, .head button:focus-visible { background: #3c3934; color: #fff; }
    .body { overflow: auto; padding: 10px; display: flex; flex-direction: column; gap: 10px; }
    .panel.min .body { display: none; }
    .progress .ptext { font-size: 12px; color: #a59d90; margin-bottom: 4px; }
    .pbar { height: 4px; background: #3c3934; border-radius: 2px; overflow: hidden; }
    .pbar i { display: block; height: 100%; width: 0; background: #81b64c; transition: width .2s; }
    .players { display: grid; grid-template-columns: 1fr auto; gap: 4px 10px; align-items: center; }
    .pl { display: flex; align-items: center; gap: 7px; min-width: 0; }
    .pl .sw { width: 12px; height: 12px; border-radius: 3px; flex: none; border: 1px solid #55504a; }
    .pl.w .sw { background: #f2efe9; } .pl.b .sw { background: #151412; }
    .pl .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .acc { font-variant-numeric: tabular-nums; font-weight: 650; font-size: 15px; text-align: right; }
    .acc small { font-weight: 400; color: #a59d90; font-size: 11px; margin-left: 2px; }
    .counts { display: grid; grid-template-columns: 1fr repeat(3, 34px); gap: 2px 4px; font-size: 12px;
      font-variant-numeric: tabular-nums; color: #a59d90; }
    .counts span { text-align: center; } .counts .h { font-weight: 700; }
    .graph { width: 100%; height: 76px; display: block; border-radius: 6px; cursor: pointer; background: #151412; }
    .current { background: #1e1c1a; border-radius: 8px; padding: 8px 10px; min-height: 58px; }
    .current .top { display: flex; align-items: center; gap: 8px; }
    .badge { width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; font-weight: 800;
      font-size: 11px; color: #fff; flex: none; }
    .current .mv { font-weight: 650; font-size: 14px; flex: 1; }
    .ev { font-variant-numeric: tabular-nums; font-weight: 700; padding: 1px 6px; border-radius: 4px; font-size: 12px; }
    .ev.pos { background: #f2efe9; color: #151412; } .ev.neg { background: #151412; color: #f2efe9; border: 1px solid #3c3934; }
    .current p { margin: 5px 0 0; color: #cfc8bc; }
    .current .line { color: #a59d90; font-size: 12px; }
    .moves { display: grid; grid-template-columns: 30px 1fr 1fr; gap: 1px; max-height: 240px; overflow: auto;
      font-variant-numeric: tabular-nums; scroll-behavior: smooth; }
    .moves .n { color: #7d766b; padding: 3px 0; text-align: right; padding-right: 6px; }
    .moves button { all: unset; cursor: pointer; padding: 3px 6px; border-radius: 4px; display: flex; gap: 4px;
      align-items: baseline; }
    .moves button:hover { background: #33302c; }
    .moves button:focus-visible { outline: 2px solid #81b64c; }
    .moves button.on { background: #45413b; }
    .moves .g { font-weight: 800; font-size: 11px; }
    .nav { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
    .nav button { all: unset; cursor: pointer; text-align: center; padding: 6px 0; border-radius: 6px; background: #3c3934;
      font-size: 14px; }
    .nav button:hover, .nav button:focus-visible { background: #4b4741; }
    .hint { font-size: 12px; color: #a59d90; }
    .err { color: #ffb4a8; font-size: 12px; }
    .err button { all: unset; cursor: pointer; text-decoration: underline; color: #fff; margin-left: 6px; }
    .fab { all: unset; position: fixed; right: 18px; bottom: 18px;
      cursor: pointer; background: #81b64c; color: #fff; font-weight: 700; padding: 10px 16px; border-radius: 8px;
      box-shadow: 0 4px 0 #45753c, 0 8px 20px rgba(0,0,0,.35); font-size: 14px; }
    .fab:hover { background: #95c95f; } .fab:focus-visible { outline: 3px solid #fff; }
    .fab[hidden] { display: none; }
    .toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); background: #1e1c1a;
      border: 1px solid #3c3934; padding: 10px 14px; border-radius: 8px; max-width: 420px; box-shadow: 0 8px 24px rgba(0,0,0,.4); }
    .toast[hidden] { display: none; }
    .evalbar { position: fixed; width: 18px; border-radius: 3px; overflow: hidden; background: #403d39;
      pointer-events: none; display: none; }
    .evalbar .fill { position: absolute; left: 0; right: 0; background: #f2efe9; transition: height .3s ease; }
    .evalbar .lbl { position: absolute; left: 0; right: 0; text-align: center; font-size: 9px; font-weight: 800; }
    .overlay { position: fixed; pointer-events: none; display: none; overflow: visible; }
    /* Embedded mode inside the Chess.com sidebar */
    .panel.embedded { position: static; width: auto; max-height: none; margin: 0 0 8px; border-radius: 6px;
      box-shadow: none; border-color: #3c3934; }
    .panel.embedded .head { cursor: default; background: #21201d; }
    .panel.embedded .graph { height: 56px; }
    .panel.native-list .moves, .panel.native-list .nav, .panel.native-list .hint { display: none; }
    .panel.live .players, .panel.live .counts, .panel.live .graph, .panel.live .moves,
    .panel.live .nav, .panel.live .hint, .panel.live .progress, .panel.live .err { display: none; }
    .hintbox { display: none; }
    .panel.live .hintbox { display: flex; align-items: center; gap: 10px; background: #1e1c1a; border-radius: 8px;
      padding: 8px 10px; border-left: 3px solid #4fa3e0; }
    .hintbox[data-empty] { display: none !important; }
    .hintbox p { margin: 0; flex: 1; color: #cfc8bc; }
    .hintbox > div { flex: 1; }
    .hintbox .hl { margin: 6px 0 0; padding: 0; list-style: none; display: grid; gap: 3px; counter-reset: h; }
    .hintbox .hl li { display: flex; gap: 8px; align-items: baseline; font-variant-numeric: tabular-nums; counter-increment: h; }
    .hintbox .hl li::before { content: counter(h) "."; color: #7d766b; width: 18px; }
    .hintbox .sc { font-weight: 700; }
    .hintbox .dl { color: #a59d90; font-size: 12px; margin-left: auto; }
    .hintbox .tip { margin-top: 6px; font-size: 12px; color: #a59d90; }
    .hintbox button { all: unset; cursor: pointer; background: #3c3934; color: #fff; font-weight: 650;
      padding: 6px 10px; border-radius: 6px; white-space: nowrap; }
    .hintbox button:hover { background: #4b4741; }
    .hintbox button:focus-visible { outline: 2px solid #4fa3e0; }
    .idle-box { display: none; align-items: center; gap: 10px; padding: 10px; }
    .panel.idle .idle-box { display: flex; }
    .panel.idle .body, .panel.idle [data-act="min"] { display: none; }
    .idle-box p { margin: 0; flex: 1; color: #cfc8bc; }
    .idle-box button { all: unset; cursor: pointer; background: #81b64c; color: #fff; font-weight: 700;
      padding: 7px 12px; border-radius: 6px; box-shadow: 0 3px 0 #45753c; white-space: nowrap; }
    .idle-box button:hover { background: #95c95f; }
    .idle-box button:focus-visible, .head button:focus-visible { outline: 2px solid #fff; }
    .hintbox .grp + .grp { margin-top: 8px; }
    .hintbox .who { font-size: 12px; color: #a59d90; }
    .opp { margin-top: 6px; padding-top: 6px; border-top: 1px solid #3c3934; display: flex; gap: 8px; align-items: center; font-size: 12px; color: #cfc8bc; }
    .opp .badge { width: 18px; height: 18px; font-size: 10px; }
    @media (prefers-reduced-motion: reduce) { .evalbar .fill, .pbar i { transition: none; } .moves { scroll-behavior: auto; } }
  </style>
  <div class="ui">
    <svg class="overlay" viewBox="0 0 800 800"></svg>
    <div class="evalbar"><div class="fill"></div><span class="lbl"></span></div>
    <section class="panel" hidden aria-label="Game analysis">
      <div class="head">
        <span class="title">Game analysis</span>
        <button data-act="min" title="Collapse" aria-label="Collapse panel">–</button>
        <button data-act="close" title="Close" aria-label="Close analysis">×</button>
      </div>
      <div class="idle-box"><p>Game over. Want to see where it went wrong?</p><button type="button" data-act="start">Analyze</button></div>
      <div class="body">
        <div class="progress" hidden><div class="ptext"></div><div class="pbar"><i></i></div></div>
        <div class="err" hidden></div>
        <div class="players"></div>
        <div class="counts"></div>
        <svg class="graph" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="Evaluation graph"></svg>
        <div class="current"></div>
        <div class="moves" role="list"></div>
        <div class="nav">
          <button data-nav="first" aria-label="Start">⏮</button>
          <button data-nav="prev" aria-label="Previous move">◀</button>
          <button data-nav="next" aria-label="Next move">▶</button>
          <button data-nav="last" aria-label="End">⏭</button>
        </div>
        <div class="hint">You can also use the ← → keys on the Chess.com board: the panel follows along.</div>
      </div>
    </section>
    <button class="fab" hidden>Analyze game</button>
    <div class="toast" hidden role="status"></div>
  </div>`;
  (document.body || document.documentElement).appendChild(host);

  // The panel has its own host so it can be placed inside the Chess.com sidebar.
  const panelHost = document.createElement('div');
  panelHost.id = 'cpa-panel-host';
  const panelRoot = panelHost.attachShadow({ mode: 'open' });
  panelRoot.appendChild(root.querySelector('style').cloneNode(true));
  const panelWrap = document.createElement('div');
  panelWrap.className = 'ui';
  panelRoot.appendChild(panelWrap);

  panelWrap.appendChild(root.querySelector('.panel'));
  const $ = (s) => root.querySelector(s) || panelRoot.querySelector(s);
  const el = {
    panel: $('.panel'), body: $('.body'), progress: $('.progress'), ptext: $('.ptext'), pbar: $('.pbar i'),
    err: $('.err'), players: $('.players'), counts: $('.counts'), graph: $('.graph'), current: $('.current'),
    title: $('.head .title'), moves: $('.moves'), fab: $('.fab'), toast: $('.toast'), evalbar: $('.evalbar'), evalfill: $('.evalbar .fill'),
    evallbl: $('.evalbar .lbl'), overlay: $('.overlay')
  };

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fig = (san) => san.replace(/[KQRBN]/g, (p) => ({ K: '♔', Q: '♕', R: '♖', B: '♗', N: '♘' }[p]));

  let toastTimer;
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.toast.hidden = true), 4500);
  }

  // ---------- Chess.com / Lichess page ----------
  const SITE = /(^|\.)lichess\.org$/.test(location.hostname) ? 'lichess' : 'chesscom';

  function gameIdFromUrl() {
    if (SITE === 'lichess') {
      // lichess.org/<8-char game id>, optionally followed by the 4-char player id or /white|/black
      const m = location.pathname.match(/^\/([a-zA-Z0-9]{8})(?:[a-zA-Z0-9]{4})?(?:\/(?:white|black))?\/?$/);
      return m ? { kind: 'lichess', id: m[1], key: 'li-' + m[1] } : null;
    }
    const m = location.pathname.match(/\/game\/(?:(live|daily)\/)?(\d+)/);
    return m ? { kind: m[1] || null, id: m[2], key: m[2] } : null;
  }

  function isFlipped(b) {
    if (!b) return false;
    if (SITE === 'lichess') { const w = b.closest('.cg-wrap'); return !!w && w.classList.contains('orientation-black'); }
    return b.classList.contains('flipped');
  }

  // Lichess game data (players, status, moves) from its public export endpoint.
  async function fetchLichess(ref) {
    try {
      const r = await fetch(`/game/export/${ref.id}?moves=true&clocks=false&evals=false&opening=false`,
        { credentials: 'include', headers: { Accept: 'application/json' } });
      if (!r.ok) return null;
      const j = await r.json();
      return j && j.id ? j : null;
    } catch (_) { return null; }
  }
  const lichessName = (p) => (p && p.user && p.user.name) || (p && p.aiLevel ? `Stockfish level ${p.aiLevel}` : null);

  function gameIdFromPage() {
    const fromUrl = gameIdFromUrl();
    if (fromUrl) return fromUrl;
    if (SITE === 'lichess') return null;
    const a = document.querySelector('[class*="game-over"] a[href*="/game/"], [class*="board-modal"] a[href*="/game/"]');
    if (a) {
      const m = a.getAttribute('href').match(/\/game\/(?:(live|daily)\/)?(\d+)/);
      if (m) return { kind: m[1] || null, id: m[2], key: m[2] };
    }
    return null;
  }

  function gameOverVisible() {
    return !!document.querySelector(
      '.game-over-modal-content, .game-over-modal-container, [data-cy="game-over-modal"], ' +
      '.game-over-header-component, .game-over-buttons-component, .game-review-buttons-component, ' +
      '.game-over-message-component, ' +
      // Lichess: result shown under the moves, rematch / new opponent buttons
      '.result-wrap, .rcontrols .follow-up, .round__app .follow-up'
    );
  }

  function findBoard() {
    const cands = document.querySelectorAll('wc-chess-board, chess-board, #board-single, #board-layout-chessboard .board, cg-board');
    let best = null, area = 0;
    for (const b of cands) {
      if (!b.querySelector('.piece, piece')) continue;
      const r = b.getBoundingClientRect();
      if (!best || r.width * r.height > area) { area = r.width * r.height; best = b; }
    }
    return best;
  }

  // Lichess (chessground): pieces are <piece class="white knight"> placed with a CSS translate.
  function readPlacementLichess(board, grid) {
    const size = (board.offsetWidth || board.getBoundingClientRect().width) / 8;
    if (!size) return 0;
    const flip = isFlipped(board);
    const T = { pawn: 'p', knight: 'n', bishop: 'b', rook: 'r', queen: 'q', king: 'k' };
    let n = 0;
    for (const p of board.querySelectorAll('piece')) {
      if (p.classList.contains('ghost') || p.classList.contains('fading') || p.classList.contains('dragging')) continue;
      const color = p.classList.contains('white') ? 'w' : p.classList.contains('black') ? 'b' : null;
      const type = Object.keys(T).find((k) => p.classList.contains(k));
      const m = (p.style.transform || '').match(/translate\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px/);
      if (!color || !type || !m) continue;
      const x = Math.round(+m[1] / size), y = Math.round(+m[2] / size);
      if (x < 0 || x > 7 || y < 0 || y > 7) continue;
      const file = flip ? 7 - x : x, row = flip ? 7 - y : y; // row 0 = rank 8
      grid[row][file] = color === 'w' ? T[type].toUpperCase() : T[type];
      n++;
    }
    return n;
  }

  function readPlacement(board) {
    const grid = Array.from({ length: 8 }, () => Array(8).fill(null));
    let n = 0;
    if (board.tagName === 'CG-BOARD') n = readPlacementLichess(board, grid);
    for (const p of board.tagName === 'CG-BOARD' ? [] : board.querySelectorAll('.piece')) {
      let type = null, sq = null;
      for (const c of p.classList) {
        if (/^[wb][pnbrqk]$/.test(c)) type = c;
        const m = c.match(/^square-(\d)(\d)$/);
        if (m) sq = [+m[1] - 1, +m[2] - 1];
      }
      if (!type || !sq || sq[0] < 0 || sq[0] > 7 || sq[1] < 0 || sq[1] > 7) continue;
      grid[7 - sq[1]][sq[0]] = type[0] === 'w' ? type[1].toUpperCase() : type[1];
      n++;
    }
    if (!n) return null;
    return grid.map((row) => {
      let s = '', e = 0;
      for (const c of row) { if (!c) e++; else { if (e) s += e; e = 0; s += c; } }
      return s + (e || '');
    }).join('/');
  }

  async function fetchGame(ref, kind) {
    try {
      if (SITE !== 'chesscom') return null;
      const r = await fetch(`/callback/${kind}/game/${ref.id}`, { credentials: 'include' });
      if (!r.ok) return null;
      const j = await r.json();
      return j && j.game && typeof j.game.moveList === 'string' ? j : null;
    } catch (_) { return null; }
  }

  const MOVE_LIST_SEL = 'wc-simple-move-list, wc-move-list, vertical-move-list, .move-list, .play-controller-moves, l4x, rm6, .tview2';

  function sansFromDom() {
    const list = document.querySelector(MOVE_LIST_SEL);
    if (!list && SITE !== 'lichess') return [];
    return moveNodes(list).map((n) => {
      const san = n.querySelector('san');
      if (san) return san.textContent.replace(/[!?]+$/g, '').trim();
      const f = n.querySelector('[data-figurine]');
      const c = n.cloneNode(true);
      c.querySelectorAll('.cpa-glyph').forEach((g) => g.remove());
      c.querySelectorAll('glyph, eval, .glyph').forEach((g) => g.remove());
      const txt = c.textContent.replace(/[!?+#]+$/g, '').replace(/\s+/g, '').trim();
      return (f ? f.getAttribute('data-figurine') : '') + txt;
    }).filter(Boolean);
  }

  function moveNodes(list) {
    if (SITE === 'lichess') return lichessMoveNodes();
    list = list || document.querySelector(MOVE_LIST_SEL);
    if (!list) return [];
    let nodes = [...list.querySelectorAll('.node')];
    if (!nodes.length) nodes = [...list.querySelectorAll('[data-ply]')];
    return nodes.filter((n) => !n.closest('.variation, .subline, [class*="variation"]'));
  }

  // Lichess renames the tags of its move list from time to time (they are deliberately obfuscated),
  // so the list is found by its content: the container holding the most elements whose text is a move.
  const SAN_RE = /^(O-O(-O)?|[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](=[QRBN])?)[+#]?[!?]*$/;
  let liMoveTag = null;
  function moveText(e) {
    for (const n of e.childNodes) if (n.nodeType === 3 && n.textContent.trim()) return n.textContent.trim();
    return '';
  }
  function lichessMoveNodes() {
    const tv = document.querySelector('.tview2');
    if (tv) return [...tv.querySelectorAll(':scope > move')].filter((n) => n.querySelector('san'));
    const root = document.querySelector('.round__app') || document.querySelector('main') || document.body;
    const pick = (tag) => [...root.querySelectorAll(tag)].filter((e) => !e.closest('cg-container, #cpa-panel-host') && SAN_RE.test(moveText(e)));
    if (liMoveTag) {
      const nodes = pick(liMoveTag);
      if (nodes.length) return nodes;
    }
    const byParent = new Map();
    for (const e of root.querySelectorAll('*')) {
      if (e.children.length > 2 || e.closest('cg-container, #cpa-panel-host')) continue;
      if (!SAN_RE.test(moveText(e))) continue;
      const k = e.parentElement;
      if (!byParent.has(k)) byParent.set(k, []);
      byParent.get(k).push(e);
    }
    let best = [];
    for (const list of byParent.values()) if (list.length > best.length) best = list;
    if (!best.length) return [];
    liMoveTag = best[0].tagName.toLowerCase();
    return best.filter((e) => e.tagName === best[0].tagName);
  }

  // ---------- Starting the analysis ----------
  async function start(manual) {
    if (S.running) return false;
    const ref = gameIdFromPage();
    let game = null;

    if (ref && ref.kind === 'lichess') {
      const j = await fetchLichess(ref);
      if (j) {
        if (j.status === 'created' || j.status === 'started') {
          if (manual) toast('This game is still in progress. Analysis will be available once it ends.');
          return false;
        }
        if (j.variant && j.variant !== 'standard' && j.variant !== 'fromPosition') {
          if (manual) toast('This variant isn’t supported (standard chess only).');
          return false;
        }
        const built = A.buildFromSans((j.moves || '').split(/\s+/).filter(Boolean), j.initialFen || null);
        const pw = j.players || {};
        game = { key: ref.key, ...built, white: lichessName(pw.white) || 'White', black: lichessName(pw.black) || 'Black',
          whiteElo: pw.white && pw.white.rating, blackElo: pw.black && pw.black.rating };
      }
    } else if (ref) {
      const board = findBoard();
      const shown = board ? readPlacement(board) : null;
      for (const kind of ref.kind ? [ref.kind] : ['live', 'daily']) {
        const data = await fetchGame(ref, kind);
        if (!data) continue;
        const g = data.game;
        const h = g.pgnHeaders || {};
        let built;
        try { built = A.buildFromMoves(CPA_TCN.decode(g.moveList), h.SetUp === '1' ? h.FEN : null); }
        catch (e) { if (manual) toast('This variant isn’t supported (standard chess only).'); return false; }
        // A live game and a daily game can share an ID: check it matches the board.
        if (shown && !built.fens.some((f) => f.split(' ')[0] === shown) && !ref.kind) continue;
        const finished = g.isFinished === true || (h.Result && h.Result !== '*');
        if (!finished) {
          if (manual) toast('This game is still in progress. Analysis will be available once it ends.');
          return false;
        }
        game = { key: ref.key, ...built, white: h.White || 'White', black: h.Black || 'Black',
          whiteElo: h.WhiteElo, blackElo: h.BlackElo, result: h.Result };
        break;
      }
    }

    if (!game) {
      if (!gameOverVisible()) {
        if (manual) toast('No finished game found on this page.');
        return false;
      }
      const built = A.buildFromSans(sansFromDom());
      if (!built.plies.length) { if (manual) toast('Couldn’t read the moves of this game.'); return false; }
      game = { key: 'dom-' + built.fens[built.fens.length - 1], ...built, white: 'White', black: 'Black' };
    }

    if (!game.plies.length) { if (manual) toast('This game has no moves to analyze.'); return false; }
    S.triggered.add(game.key);
    runAnalysis(game);
    return true;
  }

  function cacheKey(game) { return 'cpa:' + game.key + ':' + S.settings.depth; }

  async function runAnalysis(game) {
    stopJob();
    game.placements = game.fens.map((f) => f.split(' ')[0]);
    S.game = game;
    S.evals = new Array(game.fens.length).fill(null);
    S.result = null;
    S.done = false;
    S.viewPly = game.fens.length - 1;
    S.dismissedUrl = null;
    clearNativeGlyphs();
    el.err.hidden = true;
    updateMount();
    renderAll();

    if (!game.key.startsWith('dom-')) {
      const k = cacheKey(game);
      const cached = await chrome.storage.local.get(k);
      if (cached[k] && cached[k].length === game.fens.length) {
        S.evals = cached[k].map((r, i) => A.normalize(game.fens[i], r));
        finish(false);
        return;
      }
    }

    S.running = true;
    const raw = new Array(game.fens.length).fill(null);
    const jobId = 'j' + Date.now() + Math.random().toString(36).slice(2, 7);
    S.jobId = jobId;
    let port;
    try { port = chrome.runtime.connect({ name: 'cpa-analisi' }); }
    catch (e) { showError('The extension was reloaded. Refresh the page.'); S.running = false; return; }
    S.port = port;
    showProgress(0, game.fens.length);
    port.onMessage.addListener((msg) => {
      if (msg.jobId !== S.jobId) return;
      if (msg.type === 'progress') {
        raw[msg.index] = msg.result;
        S.evals[msg.index] = A.normalize(game.fens[msg.index], msg.result);
        showProgress(msg.index + 1, msg.total);
        if ((msg.index + 1) % 4 === 0) renderAll();
      } else if (msg.type === 'done') {
        S.running = false;
        if (!game.key.startsWith('dom-')) saveCache(cacheKey(game), raw);
        finish(true);
        try { port.disconnect(); } catch (_) {}
      } else if (msg.type === 'error') {
        S.running = false;
        showError(msg.message === 'license' ? 'A license is needed. Click the extension icon to activate Board Coach.' : (msg.message || 'Engine error.'));
      }
    });
    port.onDisconnect.addListener(() => {
      if (S.running && S.jobId === jobId) { S.running = false; showError('Analysis stopped.'); }
    });
    port.postMessage({ cmd: 'start', jobId, fens: game.fens, depth: S.settings.depth });
  }

  async function saveCache(k, raw) {
    try {
      const { 'cpa:index': idx = [] } = await chrome.storage.local.get('cpa:index');
      const next = [k, ...idx.filter((x) => x !== k)];
      const drop = next.splice(30);
      await chrome.storage.local.set({ [k]: raw, 'cpa:index': next });
      if (drop.length) await chrome.storage.local.remove(drop);
    } catch (_) {}
  }

  function stopJob() {
    S.running = false;
    S.jobId = null;
    if (S.port) { try { S.port.disconnect(); } catch (_) {} S.port = null; }
  }

  function finish() {
    S.done = true;
    el.progress.hidden = true;
    syncFromBoard();
    renderAll();
  }

  function showProgress(n, total) {
    el.progress.hidden = false;
    el.ptext.textContent = `Stockfish is analyzing… ${n}/${total} positions`;
    el.pbar.style.width = (100 * n / total).toFixed(1) + '%';
  }

  function showError(msg) {
    el.progress.hidden = true;
    el.err.hidden = false;
    el.err.innerHTML = esc(msg) + '<button type="button">Try again</button>';
    el.err.querySelector('button').onclick = () => { el.err.hidden = true; if (S.game) runAnalysis(S.game); };
  }

  // ---------- Panel rendering ----------
  function renderAll() {
    if (!S.game) return;
    S.result = A.classify(S.game, S.evals);
    renderPlayers();
    renderGraph();
    renderMoves();
    renderCurrent();
    annotateNative();
    drawOverlay();
  }

  function renderPlayers() {
    const g = S.game, acc = S.result.accuracy;
    const fmt = (v) => (v == null || !S.done ? '–' : v.toFixed(1) + '<small>%</small>');
    const elo = (e) => (e ? ` <span style="color:#7d766b">(${esc(e)})</span>` : '');
    el.players.innerHTML =
      `<div class="pl w"><span class="sw"></span><span class="name">${esc(g.white)}${elo(g.whiteElo)}</span></div><div class="acc" title="Estimated accuracy">${fmt(acc.w)}</div>` +
      `<div class="pl b"><span class="sw"></span><span class="name">${esc(g.black)}${elo(g.blackElo)}</span></div><div class="acc" title="Estimated accuracy">${fmt(acc.b)}</div>`;
    const c = S.result.counts;
    const h = (k) => `<span class="h" style="color:${CLS[k].color}" title="${CLS[k].label}">${CLS[k].glyph}</span>`;
    el.counts.innerHTML =
      `<span></span>${h('inaccuracy')}${h('mistake')}${h('blunder')}` +
      `<span>White</span><span>${c.w.inaccuracy}</span><span>${c.w.mistake}</span><span>${c.w.blunder}</span>` +
      `<span>Black</span><span>${c.b.inaccuracy}</span><span>${c.b.mistake}</span><span>${c.b.blunder}</span>`;
  }

  function renderGraph() {
    const n = S.game.fens.length - 1 || 1;
    const pts = [];
    S.evals.forEach((e, i) => {
      if (e) pts.push(`${(100 * i / n).toFixed(2)},${(50 - 50 * A.winChance(e.wcp)).toFixed(2)}`);
    });
    const lastX = pts.length ? pts[pts.length - 1].split(',')[0] : 0;
    let marks = '';
    S.result.moves.forEach((m, i) => {
      if (!m || !['mistake', 'blunder', 'inaccuracy'].includes(m.cls)) return;
      const x = (100 * i / n).toFixed(2);
      marks += `<line x1="${x}" x2="${x}" y1="0" y2="100" stroke="${CLS[m.cls].color}" stroke-width="${m.cls === 'inaccuracy' ? 1 : 1.6}" opacity="${m.cls === 'inaccuracy' ? 0.45 : 0.85}" vector-effect="non-scaling-stroke"/>`;
    });
    const vx = S.viewPly != null ? (100 * S.viewPly / n).toFixed(2) : null;
    el.graph.innerHTML =
      (pts.length ? `<polygon points="0,100 ${pts.join(' ')} ${lastX},100" fill="#f2efe9"/>` : '') +
      `<line x1="0" x2="100" y1="50" y2="50" stroke="#7d766b" stroke-width="1" vector-effect="non-scaling-stroke" stroke-dasharray="3 3"/>` +
      marks +
      (vx !== null ? `<line x1="${vx}" x2="${vx}" y1="0" y2="100" stroke="#81b64c" stroke-width="2" vector-effect="non-scaling-stroke"/>` : '');
  }

  function renderMoves() {
    const g = S.game;
    let html = '';
    for (let i = 0; i < g.plies.length; i++) {
      const p = g.plies[i];
      if (i === 0 && p.color === 'b') html += `<span class="n">1...</span><span></span>`;
      if (p.color === 'w') html += `<span class="n">${Math.floor(i / 2) + 1 + (g.plies[0].color === 'b' ? 1 : 0)}.</span>`;
      const m = S.result.moves[i + 1];
      const show = m && m.cls !== 'good' && m.cls !== 'forced';
      const g1 = show ? `<span class="g" style="color:${CLS[m.cls].color}">${CLS[m.cls].glyph}</span>` : '';
      html += `<button type="button" role="listitem" data-ply="${i + 1}" class="${S.viewPly === i + 1 ? 'on' : ''}">${esc(fig(p.san))}${g1}</button>`;
    }
    el.moves.innerHTML = html;
    scrollActive();
  }

  function scrollActive() {
    const on = el.moves.querySelector('button.on');
    if (!on) return;
    const top = on.offsetTop - el.moves.offsetTop;
    if (top < el.moves.scrollTop || top > el.moves.scrollTop + el.moves.clientHeight - 24) {
      el.moves.scrollTop = top - el.moves.clientHeight / 2;
    }
  }

  function evalChip(e) {
    if (!e) return '<span class="ev neg">…</span>';
    return `<span class="ev ${e.wcp >= 0 ? 'pos' : 'neg'}">${A.formatEval(e)}</span>`;
  }

  function moveLabel(i) {
    const p = S.game.plies[i - 1];
    const firstBlack = S.game.plies[0].color === 'b' ? 1 : 0;
    const num = Math.floor((i - 1 + firstBlack) / 2) + 1;
    return `${num}${p.color === 'w' ? '.' : '...'} ${fig(p.san)}`;
  }

  function renderCurrent() {
    const i = S.viewPly;
    if (S.offGame || i == null) {
      el.current.innerHTML = `<p style="margin:0">The board is showing a position that isn’t part of this game. Go back to a game move to see the analysis.</p>`;
      return;
    }
    if (i === 0) {
      el.current.innerHTML = `<div class="top"><span class="mv">Starting position</span>${evalChip(S.evals[0])}</div>`;
      return;
    }
    const m = S.result.moves[i];
    const e = S.evals[i];
    if (!m) {
      el.current.innerHTML = `<div class="top"><span class="mv">${esc(moveLabel(i))}</span>${evalChip(e)}</div><p class="line">Waiting for the engine…</p>`;
      return;
    }
    const c = CLS[m.cls];
    let txt = `<p>${c.label}.`;
    if (m.bestSan) txt += ` Best was <b>${esc(fig(m.bestSan))}</b> ${evalChip(m.bestEval)}`;
    txt += '</p>';
    if (m.bestSan && m.line.length > 1) txt += `<p class="line">Line: ${esc(m.line.map(fig).join(' '))}</p>`;
    if (e && e.mate === 0) txt += `<p class="line">Checkmate.</p>`;
    el.current.innerHTML =
      `<div class="top"><span class="badge" style="background:${c.color}">${c.glyph}</span><span class="mv">${esc(moveLabel(i))}</span>${evalChip(e)}</div>` + txt;
  }

  // ---------- Drawing on the board ----------
  function squareXY(sq, flipped) {
    const f = sq.charCodeAt(0) - 97, r = +sq[1] - 1;
    return flipped ? [(7 - f) * 100 + 50, r * 100 + 50] : [f * 100 + 50, (7 - r) * 100 + 50];
  }

  // "Squares" style: the start and end squares are tinted, with the move's rank (1 = best) on the end square.
  function squareMark(from, to, flipped, color, i) {
    const [fx, fy] = squareXY(from, flipped), [tx, ty] = squareXY(to, flipped);
    return `<rect x="${fx - 50}" y="${fy - 50}" width="100" height="100" fill="${color}" opacity=".35"/>` +
      `<rect x="${tx - 46}" y="${ty - 46}" width="92" height="92" rx="6" fill="none" stroke="${color}" stroke-width="8" opacity=".95"/>` +
      `<circle cx="${tx - 30}" cy="${ty - 30}" r="15" fill="${color}"/>` +
      `<text x="${tx - 30}" y="${ty - 30}" text-anchor="middle" dominant-baseline="central" font-family="system-ui,sans-serif" font-weight="800" font-size="18" fill="#fff">${i + 1}</text>`;
  }

  function arrow(from, to, flipped, color, width, opacity, dashed) {
    const [x1, y1] = squareXY(from, flipped), [x2, y2] = squareXY(to, flipped);
    const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1;
    const w = width || 9, ux = dx / len, uy = dy / len, head = 16 + w * 1.4, hw = 8 + w;
    const sx = x1 + ux * 22, sy = y1 + uy * 22;
    const bx = x2 - ux * head, by = y2 - uy * head;
    const px = -uy, py = ux;
    return `<g opacity="${opacity || 0.85}"><line x1="${sx}" y1="${sy}" x2="${bx}" y2="${by}" stroke="${color}" stroke-width="${w}" stroke-linecap="round"${dashed ? ` stroke-dasharray="${w * 2} ${w * 1.6}"` : ''}/>` +
      `<polygon points="${x2},${y2} ${bx + px * hw},${by + py * hw} ${bx - px * hw},${by - py * hw}" fill="${color}"/></g>`;
  }

  function badge(sq, flipped, cls) {
    const [x, y] = squareXY(sq, flipped);
    const c = CLS[cls];
    return `<g><circle cx="${x + 38}" cy="${y - 38}" r="19" fill="${c.color}" stroke="#fff" stroke-width="3"/>` +
      `<text x="${x + 38}" y="${y - 38}" text-anchor="middle" dominant-baseline="central" font-family="system-ui,sans-serif" font-weight="800" font-size="${c.glyph.length > 1 ? 17 : 20}" fill="#fff">${c.glyph}</text></g>`;
  }

  function drawEvalBar(e, r, flipped) {
    if (!S.settings.evalbar || !e) { el.evalbar.style.display = 'none'; return; }
    const w = 50 + 50 * A.winChance(e.wcp);
    const left = Math.max(2, r.left - 24);
    Object.assign(el.evalbar.style, { display: 'block', left: left + 'px', top: r.top + 'px', height: r.height + 'px' });
    el.evalfill.style.height = w + '%';
    el.evalfill.style.top = flipped ? '0' : 'auto';
    el.evalfill.style.bottom = flipped ? 'auto' : '0';
    const whiteSide = e.wcp >= 0;
    el.evallbl.textContent = A.formatEval(e, true).replace(/^[+−-]/, '');
    el.evallbl.style.color = whiteSide ? '#151412' : '#f2efe9';
    const atBottom = whiteSide !== flipped;
    el.evallbl.style.top = atBottom ? 'auto' : '4px';
    el.evallbl.style.bottom = atBottom ? '4px' : 'auto';
  }

  function drawOverlay() {
    if (!S.game) {
      try { liveDraw(); } catch (e) { console.error('[Board Coach]', e); el.overlay.style.display = 'none'; }
      return;
    }
    const b = S.board;
    const show = b && S.game && S.onBoard && S.viewPly != null && document.contains(b);
    if (!show) { el.overlay.style.display = 'none'; el.evalbar.style.display = 'none'; return; }
    const r = b.getBoundingClientRect();
    const flipped = isFlipped(b);
    Object.assign(el.overlay.style, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });

    let svg = '';
    const i = S.viewPly;
    const m = S.result && S.result.moves[i];
    if (i > 0 && m) {
      const p = S.game.plies[i - 1];
      if (S.settings.arrows && m.bestUci && m.bestSan) svg += arrow(m.bestUci.slice(0, 2), m.bestUci.slice(2, 4), flipped, '#81b64c');
      svg += badge(p.to, flipped, m.cls);
    }
    el.overlay.innerHTML = svg;

    drawEvalBar(S.evals[i], r, flipped);
  }

  // ---------- Sync with the Chess.com board ----------
  function syncFromBoard() {
    if (!S.game) {
      // A move on the board starts the engine right away, without waiting for the page check.
      if (LIVE.active) { const k = LIVE.key; liveTick(); if (LIVE.key === k) liveSync(); }
      return;
    }
    const b = S.board = findBoard();
    if (!b) { S.onBoard = false; return; }
    const pl = readPlacement(b);
    const idxs = [];
    S.game.placements.forEach((p, i) => { if (p === pl) idxs.push(i); });
    const prev = S.viewPly, wasOff = S.offGame;
    if (idxs.length) {
      const ref = prev ?? S.game.fens.length - 1;
      S.viewPly = idxs.reduce((a, x) => (Math.abs(x - ref) < Math.abs(a - ref) ? x : a), idxs[0]);
      S.onBoard = true;
      S.offGame = false;
    } else {
      S.onBoard = false;
      S.offGame = true;
    }
    if (prev !== S.viewPly || !S.onBoard || wasOff !== S.offGame) {
      for (const btn of el.moves.querySelectorAll('button')) btn.classList.toggle('on', +btn.dataset.ply === S.viewPly);
      scrollActive();
      if (S.result) { renderCurrent(); renderGraph(); }
    }
    drawOverlay();
  }

  let boardObs = null, observedBoard = null, syncTimer = null;
  function watchBoard() {
    const b = findBoard();
    if (b === observedBoard) return;
    if (boardObs) boardObs.disconnect();
    observedBoard = b;
    if (!b) return;
    boardObs = new MutationObserver(() => {
      clearTimeout(syncTimer);
      syncTimer = setTimeout(syncFromBoard, 40);
    });
    boardObs.observe(b, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style'] });
    syncFromBoard();
  }

  function goToPly(n) {
    if (!S.game) return;
    n = Math.max(0, Math.min(S.game.fens.length - 1, n));
    const nodes = moveNodes();
    if (n >= 1 && nodes[n - 1]) {
      nodes[n - 1].click();
    } else if (n === 0 && nodes[0]) {
      nodes[0].click();
      setTimeout(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37, bubbles: true })), 40);
    }
    setTimeout(() => {
      syncFromBoard();
      if (S.viewPly !== n) {
        // The board didn't move: still show the analysis in the panel.
        S.viewPly = n;
        S.onBoard = false;
        S.offGame = false;
        for (const btn of el.moves.querySelectorAll('button')) btn.classList.toggle('on', +btn.dataset.ply === n);
        renderCurrent(); renderGraph(); drawOverlay();
      }
    }, 260);
  }

  // ---------- Panel events ----------
  el.moves.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-ply]');
    if (b) goToPly(+b.dataset.ply);
  });
  $('.nav').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-nav]');
    if (!b || !S.game) return;
    const last = S.game.fens.length - 1, cur = S.viewPly ?? last;
    goToPly({ first: 0, prev: cur - 1, next: cur + 1, last }[b.dataset.nav]);
  });
  el.graph.addEventListener('click', (e) => {
    if (!S.game) return;
    const r = el.graph.getBoundingClientRect();
    goToPly(Math.round(((e.clientX - r.left) / r.width) * (S.game.fens.length - 1)));
  });
  $('[data-act="close"]').addEventListener('click', () => {
    stopJob();
    S.game = null;
    S.dismissedUrl = location.href;
    clearNativeGlyphs();
    drawOverlay();
    updateMount();
  });
  $('[data-act="start"]').addEventListener('click', () => start(true));
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.cmd === 'cpa-start') { S.dismissedUrl = null; start(true); }
  });
  $('[data-act="min"]').addEventListener('click', () => {
    S.minimized = !S.minimized;
    el.panel.classList.toggle('min', S.minimized);
  });
  el.fab.addEventListener('click', () => start(true));

  // Panel dragging
  (() => {
    const head = $('.head');
    let sx, sy, ox, oy, drag = false;
    head.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button') || el.panel.classList.contains('embedded')) return;
      drag = true; head.setPointerCapture(e.pointerId);
      const r = el.panel.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
    });
    head.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const x = Math.max(0, Math.min(innerWidth - 120, ox + e.clientX - sx));
      const y = Math.max(0, Math.min(innerHeight - 40, oy + e.clientY - sy));
      Object.assign(el.panel.style, { left: x + 'px', top: y + 'px', right: 'auto' });
    });
    head.addEventListener('pointerup', () => {
      if (!drag) return;
      drag = false;
      chrome.storage.local.set({ 'cpa:pos': { left: el.panel.style.left, top: el.panel.style.top } });
    });
    chrome.storage.local.get('cpa:pos', (v) => {
      const p = v['cpa:pos'];
      if (p && p.left) Object.assign(el.panel.style, { left: p.left, top: p.top, right: 'auto' });
    });
  })();

  // ---------- Coach mode during play: ONLY in games against the Chess.com computer ----------
  // Against people this would be engine assistance, so it is never enabled outside /play/computer.
  const LIVE = {
    active: false, port: null, jobs: {}, pending: new Set(),
    evals: new Map(),   // fen -> normalized main eval (White POV)
    top: new Map(),     // fen -> [{ uci, san, score, label }] best 3 moves, side-to-move POV
    topFull: new Set(), // fens whose best moves come from the full-strength search
    human: new Map(),   // depth|fen -> Map(uci -> score): shallow search used to model human play
    game: null, key: null, userColor: 'w', viewPly: null
  };

  // You can insert here your logic so that this works only agains the computer.
  // It currently works agains everyone, so human opponents included
  function isBotGamePage() {
    return true;
  }

  // Suggestions "Off" turns off everything during the game: no panel, no verdicts, no marks.
  function liveEnabled() { return coachOn() && isBotGamePage() && !S.game; }

  // Score of a line from the side to move's point of view (in centipawns, mates as large numbers).
  function lineScore(l) {
    if (l.mate !== null && l.mate !== undefined) return l.mate > 0 ? 10000 - l.mate * 10 : -10000 - l.mate * 10;
    return l.cp || 0;
  }
  function lineLabel(l) {
    if (l.mate !== null && l.mate !== undefined) return (l.mate > 0 ? 'Mate in ' : 'Mated in ') + Math.abs(l.mate);
    const v = (l.cp || 0) / 100;
    return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1);
  }
  function deltaLabel(score, best) {
    if (Math.abs(best) >= 9000 || Math.abs(score) >= 9000) return best - score < 1 ? 'best' : '';
    const d = (Math.round(score / 10) - Math.round(best / 10)) / 10; // same rounding as the scores shown
    return d === 0 ? '±0.0' : (d > 0 ? '+' : '−') + Math.abs(d).toFixed(1);
  }
  function livePort() {
    if (LIVE.port) return LIVE.port;
    try { LIVE.port = chrome.runtime.connect({ name: 'cpa-analisi' }); } catch (_) { return null; }
    LIVE.port.onMessage.addListener((msg) => {
      const job = LIVE.jobs[msg.jobId];
      if (!job) return;
      if (msg.type === 'progress') {
        const { kind, fen } = job;
        const r = msg.result;
        // The best-moves search is the reference for its position, so arrows and bar always agree;
        // the shallow human search never replaces a real eval.
        const hadEval = LIVE.evals.has(fen);
        if (kind === 'top' || (kind === 'eval' && !LIVE.topFull.has(fen))) LIVE.evals.set(fen, A.normalize(fen, r));
        // A new evaluation can change how strong the imitated player should be right now.
        if (!hadEval && LIVE.evals.has(fen) && wantHuman()) setTimeout(() => { try { liveRequestNeeded(); } catch (_) {} }, 0);
        const lines = (r.lines && r.lines.length ? r.lines : [{ cp: r.cp, mate: r.mate, pv: r.pv }]).filter((l) => l.pv && l.pv.length);
        if (kind === 'top') {
          // Arrows appear only once the full-strength search is done.
          LIVE.top.set(fen, lines.slice(0, 3).map((l) => ({ uci: l.pv[0], san: A.uciToSan(fen, l.pv[0]), score: lineScore(l), label: lineLabel(l) })));
          LIVE.topFull.add(fen);
        } else if (kind === 'human') {
          const m = new Map();
          for (const l of lines) m.set(l.pv[0], lineScore(l));
          LIVE.human.set(job.depth + '|' + fen, m);
        }
        liveRender();
      } else if (msg.type === 'done' || msg.type === 'error') {
        if (msg.message === 'license') { LIVE.licenseBlocked = true; licenseToast(); }
        LIVE.pending.delete(job.pkey);
        delete LIVE.jobs[msg.jobId];
      }
    });
    LIVE.port.onDisconnect.addListener(() => {
      LIVE.port = null; LIVE.pending.clear(); LIVE.jobs = {};
      setTimeout(() => { try { if (LIVE.active && LIVE.game) liveRequestNeeded(); } catch (e) { console.error('[Board Coach]', e); } }, 300);
    });
    return LIVE.port;
  }

  function liveRequest(kind, fen) {
    if (!fen || LIVE.licenseBlocked) return;
    const hd = kind === 'human' ? depthForElo(humanEffective(fen).elo) : 0;
    const k = kind === 'human' ? `human|${hd}|${fen}` : kind + '|' + fen;
    if (LIVE.pending.has(k)) return;
    if (kind === 'eval' && LIVE.evals.has(fen)) return;
    if (kind === 'top' && LIVE.topFull.has(fen)) return;
    if (kind === 'human' && LIVE.human.has(hd + '|' + fen)) return;
    const legal = new Chess(fen).moves().length;
    if (kind !== 'eval' && legal === 0) return;
    const port = livePort();
    if (!port) return;
    const multipv = kind === 'top' ? Math.min(3, legal) : kind === 'human' ? legal : 1;
    const depth = kind === 'human' ? hd : S.settings.depth; // best moves: always full strength
    const jobId = 'l' + Date.now() + Math.random().toString(36).slice(2, 6);
    LIVE.jobs[jobId] = { kind, fen, depth, pkey: k, t: Date.now() };
    LIVE.pending.add(k);
    try { port.postMessage({ cmd: 'start', jobId, fens: [fen], depth, multipv }); } catch (_) { LIVE.port = null; }
  }

  // Drops engine work for positions that are no longer relevant (you or the bot already moved).
  function liveCancelStale(keep) {
    for (const [id, job] of Object.entries(LIVE.jobs)) {
      if (keep.has(job.fen)) continue;
      try { LIVE.port && LIVE.port.postMessage({ cmd: 'stop', jobId: id }); } catch (_) {}
      LIVE.pending.delete(job.pkey);
      delete LIVE.jobs[id];
    }
  }

  function verdictsOn() { return S.settings.verdicts !== false; }

  let licenseToasted = false;
  function licenseToast() {
    if (licenseToasted) return;
    licenseToasted = true;
    toast('Board Coach needs a license. Click the extension icon to activate it.');
  }

  function coachOn() { return S.settings.suggest !== 'off'; }
  function wantEngine() { return S.settings.suggest === 'engine'; }
  function wantHuman() { return S.settings.suggest === 'human'; }
  function topN() { return Math.max(1, Math.min(3, S.settings.topN | 0 || 3)); }

  // ----- Human move model -----
  // An estimate, not a recording of real players (see humanDistribution in analysis.js).
  const HUMAN_ADAPT = 300; // largest Elo shift from the score (ahead: weaker, behind: stronger)
  const HUMAN_BOOST = 100; // the imitated players are a little stronger than the plain Elo scale
  function humanElo() { return Math.max(400, Math.min(2800, S.settings.humanElo | 0 || 1200)); }
  function depthForElo(e) { return e < 900 ? 1 : e < 1200 ? 2 : e < 1500 ? 4 : e < 1800 ? 6 : e < 2100 ? 8 : 10; }

  // Level used for the position `fen`: your Elo plus a small boost, shifted by who is ahead (your own turns only).
  // ready = false while the evaluation needed for the shift is still being calculated.
  function humanEffective(fen) {
    const base = Math.min(2800, humanElo() + HUMAN_BOOST);
    const shift = HUMAN_ADAPT; // fixed: at most +/-300 Elo, reached when you are about 1-2 pawns ahead or behind
    const g = LIVE.game;
    const myTurn = !!g && fen === g.fens[g.fens.length - 1] && fen.split(' ')[1] === LIVE.userColor;
    if (!shift || !myTurn) return { elo: base, ready: true };
    const sc = moverScore(fen, LIVE.evals.get(fen));
    if (!sc) return { elo: base, ready: false };
    return { elo: A.adaptElo(base, sc.score, shift), ready: true };
  }
  function humanMoves(fen) {
    const eff = humanEffective(fen);
    if (!eff.ready) return null;
    const raw = LIVE.human.get(depthForElo(eff.elo) + '|' + fen);
    if (!raw || !raw.size) return null;
    return A.humanDistribution(fen, raw, eff.elo);
  }

  // If the move list can't be read reliably, the position is rebuilt from the pieces on the board,
  // so suggestions keep working (only the verdict on past moves is lost).
  function gameFromBoard(plyCount) {
    const b = findBoard();
    const placement = b ? readPlacement(b) : null;
    if (!placement) return null;
    const flat = placement.split('/').map((r) => r.replace(/\d/g, (d) => '.'.repeat(+d)));
    let castle = '';
    if (flat[7][4] === 'K') { if (flat[7][7] === 'R') castle += 'K'; if (flat[7][0] === 'R') castle += 'Q'; }
    if (flat[0][4] === 'k') { if (flat[0][7] === 'r') castle += 'k'; if (flat[0][0] === 'r') castle += 'q'; }
    const fen = `${placement} ${plyCount % 2 === 0 ? 'w' : 'b'} ${castle || '-'} - 0 ${Math.floor(plyCount / 2) + 1}`;
    if (!new Chess().validate_fen(fen).valid) return null;
    return { fens: [fen], plies: [], placements: [placement] };
  }

  function liveTick() {
    if (!liveEnabled()) { if (LIVE.active) liveStop(); return; }
    if (!findBoard()) return;
    LIVE.active = true;
    const sans = sansFromDom();
    const key = sans.join(' ');
    const b0 = findBoard();
    const pos0 = b0 ? readPlacement(b0) : null;
    // Which side you play is read from the board orientation. At the start of a game the board may be
    // turned around a moment after it appears, so this is checked every time, not only when moves change.
    const colorNow = b0 && isFlipped(b0) ? 'b' : 'w';
    const colorChanged = colorNow !== LIVE.userColor;
    // Same moves, same side and same pieces on the board: nothing to redo.
    if (key === LIVE.key && LIVE.game && !colorChanged && (LIVE.fallback ? pos0 === LIVE.game.placements[0] : true)) return;
    // Brand-new game with no moves yet: wait a moment so the board has settled in its final orientation
    // (otherwise the side to move could be taken for yours and arrows flash for the opponent).
    if (sans.length === 0) {
      if (!LIVE.emptySince) LIVE.emptySince = Date.now();
      const waited = Date.now() - LIVE.emptySince;
      if (waited < 900) { setTimeout(() => { try { liveTick(); } catch (_) {} }, 950 - waited); return; }
    } else LIVE.emptySince = 0;
    LIVE.key = key;
    let built = A.buildFromSans(sans);
    // Unreadable list, or a list that doesn't lead to the position on the board: trust the board.
    LIVE.fallback = built.plies.length !== sans.length ||
      (!!pos0 && !built.fens.some((f) => f.split(' ')[0] === pos0));
    if (LIVE.fallback) built = gameFromBoard(moveNodes().length || sans.length); // side to move from the count of listed moves
    if (!built) { LIVE.game = null; liveRender(); return; }
    built.placements = built.fens.map((f) => f.split(' ')[0]);
    LIVE.game = built;
    const b = findBoard();
    LIVE.userColor = b && isFlipped(b) ? 'b' : 'w';
    if (LIVE.evals.size > 400) { LIVE.evals.clear(); LIVE.top.clear(); LIVE.topFull.clear(); LIVE.human.clear(); }
    liveRequestNeeded();
    liveSync();
  }

  // Asks the engine for whatever the current position still needs. Safe to call again and again:
  // results already known or already requested are skipped.
  function liveRequestNeeded() {
    const g = LIVE.game;
    if (!g) return;
    const n = g.plies.length;
    const latest = g.fens[n];
    const over = new Chess(latest).game_over();
    const userTurn = !over && latest.split(' ')[1] === LIVE.userColor;
    const oppTurn = !over && !userTurn && !!S.settings.oppTurn;
    const lastMove = (color) => {
      for (let i = n; i >= 1; i--) if (g.plies[i - 1].color === color) return [g.fens[i - 1], g.fens[i]];
      return [null, null];
    };
    const [before, after] = lastMove(LIVE.userColor);
    const [oBefore, oAfter] = S.settings.oppTurn ? lastMove(LIVE.userColor === 'w' ? 'b' : 'w') : [null, null];
    liveCancelStale(new Set([latest, before, after, oBefore, oAfter].filter(Boolean)));
    if ((userTurn || oppTurn) && coachOn()) {
      if (wantEngine()) liveRequest('top', latest);
      if (wantHuman()) liveRequest('human', latest);
    }
    if (verdictsOn()) {
      liveRequest('eval', before);
      liveRequest('eval', after);
      liveRequest('eval', oBefore);
      liveRequest('eval', oAfter);
    }
    if (!((userTurn || oppTurn) && coachOn() && wantEngine())) liveRequest('eval', latest);
  }

  // Engine jobs that never came back (service worker restarted, engine hung): drop and ask again.
  function liveWatchdog() {
    if (!LIVE.active) return;
    const now = Date.now();
    let lost = false;
    for (const [id, job] of Object.entries(LIVE.jobs)) {
      if (now - job.t < 20000) continue;
      lost = true;
      try { LIVE.port && LIVE.port.postMessage({ cmd: 'stop', jobId: id }); } catch (_) {}
      LIVE.pending.delete(job.pkey);
      delete LIVE.jobs[id];
    }
    if (lost && LIVE.port) { try { LIVE.port.disconnect(); } catch (_) {} LIVE.port = null; }
    if (LIVE.game) liveRequestNeeded();
  }

  function liveSync() {
    const g = LIVE.game;
    const b = S.board = findBoard();
    if (!g || !b) { LIVE.viewPly = null; liveRender(); return; }
    const pl = readPlacement(b);
    let best = null;
    g.placements.forEach((p, i) => { if (p === pl && (best === null || i > best)) best = i; });
    LIVE.viewPly = best;
    liveRender();
  }

  // Position where it's your turn (only the latest position of the game, never while reviewing).
  function liveTurnFen() {
    const g = LIVE.game;
    if (!LIVE.active || !g || LIVE.viewPly !== g.fens.length - 1) return null;
    const fen = g.fens[LIVE.viewPly];
    if (fen.split(' ')[1] !== LIVE.userColor || new Chess(fen).game_over()) return null;
    return fen;
  }

  // Latest position when it's the opponent's turn (only if that option is on).
  function liveOppFen() {
    const g = LIVE.game;
    if (!S.settings.oppTurn || !LIVE.active || !g || LIVE.viewPly !== g.fens.length - 1) return null;
    const fen = g.fens[LIVE.viewPly];
    if (fen.split(' ')[1] === LIVE.userColor || new Chess(fen).game_over()) return null;
    return fen;
  }

  // The opponent's latest move, judged (only if that option is on).
  function oppState() {
    const g = LIVE.game;
    if (!S.settings.oppTurn || !LIVE.active || !g || LIVE.viewPly == null) return null;
    let j = LIVE.viewPly;
    while (j >= 1 && g.plies[j - 1].color === LIVE.userColor) j--;
    if (j < 1) return null;
    const ply = g.plies[j - 1];
    const m = A.classifyOne(g.fens[j - 1], LIVE.evals.get(g.fens[j - 1]), LIVE.evals.get(g.fens[j]), ply);
    return { j, ply, m, atMove: LIVE.viewPly === j };
  }

  // The user's most recent move at or before the position shown.
  function liveState() {
    const g = LIVE.game;
    if (!LIVE.active || !g || LIVE.viewPly == null) return null;
    let j = LIVE.viewPly;
    while (j >= 1 && g.plies[j - 1].color !== LIVE.userColor) j--;
    if (j < 1) return { j: 0 };
    const ply = g.plies[j - 1];
    const m = A.classifyOne(g.fens[j - 1], LIVE.evals.get(g.fens[j - 1]), LIVE.evals.get(g.fens[j]), ply);
    let pieceStillThere = true;
    if (LIVE.viewPly !== j) {
      const pc = new Chess(g.fens[LIVE.viewPly]).get(ply.to);
      pieceStillThere = !!pc && pc.color === LIVE.userColor;
    }
    return { j, ply, m, after: LIVE.evals.get(g.fens[j]), atMove: LIVE.viewPly === j,
      showBadge: LIVE.viewPly - j <= 1 && pieceStillThere };
  }

  function liveMarks() {
    const g = LIVE.game, out = [];
    g.plies.forEach((p, k) => {
      if (p.color !== LIVE.userColor && !S.settings.oppTurn) return;
      const m = A.classifyOne(g.fens[k], LIVE.evals.get(g.fens[k]), LIVE.evals.get(g.fens[k + 1]), p);
      out[k + 1] = m && m.cls;
    });
    return out;
  }


  // Normalized eval (White POV) seen from the side that moves in `fen`.
  function moverScore(fen, e) {
    if (!e) return null;
    const sign = fen.split(' ')[1] === 'w' ? 1 : -1;
    if (e.mate === 0) return { score: e.wcp * sign, label: e.wcp * sign > 0 ? 'Checkmate' : 'Mated' };
    if (e.mate !== null && e.mate !== undefined) {
      const l = { mate: e.mate * sign };
      return { score: lineScore(l), label: lineLabel(l) };
    }
    const l = { cp: e.cp * sign };
    return { score: lineScore(l), label: lineLabel(l) };
  }

  // The most likely human moves, each labeled with how likely a player of that level is to choose it.
  function humanTop(fen) {
    const hum = humanMoves(fen);
    if (!hum) return [];
    // Moves a player of that level would almost never choose are left out.
    return hum.slice(0, topN()).filter((m, i) => i === 0 || m.p >= 0.03)
      .map((m) => ({ ...m, label: Math.max(1, Math.round(m.p * 100)) + '%' }));
  }

  function suggestionLists(fen) {
    const n = topN();
    const eng = wantEngine() ? LIVE.top.get(fen) : null;
    const hum = wantHuman() && humanMoves(fen) ? humanTop(fen) : null;
    const best = moverScore(fen, LIVE.evals.get(fen));
    return { eng: eng ? eng.slice(0, n) : null, hum, best: best ? best.score : null, n };
  }

  function liveRender() {
    if (!LIVE.active) return;
    annotateNative();
    drawOverlay();
  }

  function pill(x, y, text, fill, color) {
    const w = Math.max(48, text.length * 13 + 14);
    return `<g><rect x="${x - w / 2}" y="${y - 15}" width="${w}" height="30" rx="15" fill="${fill}" stroke="rgba(0,0,0,.35)" stroke-width="2"/>` +
      `<text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="central" font-family="system-ui,sans-serif" font-weight="800" font-size="18" fill="${color}">${text}</text></g>`;
  }

  function liveDraw() {
    const b = S.board;
    const ok = LIVE.active && b && document.contains(b);
    // Verdicts (marks on played moves) can be turned off in the settings.
    const st = ok && verdictsOn() ? liveState() : null;
    const os = ok && verdictsOn() ? oppState() : null;
    const userFen = ok && coachOn() ? liveTurnFen() : null;
    const fen = userFen || (ok && coachOn() ? liveOppFen() : null);
    const lists = fen ? suggestionLists(fen) : null;
    const hasSug = lists && ((lists.eng && lists.eng.length) || (lists.hum && lists.hum.length));
    // The bar always follows the position on the board, whoever's turn it is; while the engine
    // works on a new position it keeps the last value instead of disappearing.
    const g = LIVE.game;
    const shownFen = ok && g && LIVE.viewPly != null ? g.fens[LIVE.viewPly] : null;
    const shownEval = shownFen ? LIVE.evals.get(shownFen) : null;
    if (shownEval) LIVE.barEval = shownEval;
    const barEval = ok && coachOn() ? shownEval || LIVE.barEval || null : null;
    if ((!st || !st.m) && (!os || !os.m) && !hasSug && !barEval) {
      el.overlay.style.display = 'none'; el.evalbar.style.display = 'none'; return;
    }
    const r = b.getBoundingClientRect();
    const flipped = isFlipped(b);
    Object.assign(el.overlay.style, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    let svg = '';
    if (st && st.m) {
      // No arrow with the move you should have played: during a game only the mark on the piece is shown.
      if (st.showBadge) svg += badge(st.ply.to, flipped, st.m.cls);
    }
    if (os && os.m && os.atMove) svg += badge(os.ply.to, flipped, os.m.cls);
    if (hasSug) {
      // Same size for every arrow: the best one is a darker shade of the same color.
      const sets = [];
      // Best moves: arrows only, no label (the best one is the darker arrow).
      if (lists.eng) sets.push({ moves: lists.eng, color: '#5aaee8', dark: '#1d5a8c', text: null, t: 0.62 });
      if (lists.hum) sets.push({ moves: lists.hum, color: '#b583e0', dark: '#5e2f86', text: (m) => m.label, t: 0.62 });
      const style = S.settings.style || 'arrows';
      for (const set of sets) {
        // Draw the best last so it sits on top of the others.
        [...set.moves.keys()].reverse().forEach((i) => {
          const m = set.moves[i], from = m.uci.slice(0, 2), to = m.uci.slice(2, 4), c = i === 0 ? set.dark : set.color;
          if (style === 'squares') svg += squareMark(from, to, flipped, c, i);
          else if (style === 'dashed') svg += arrow(from, to, flipped, c, 6, 0.9, true);
          else svg += arrow(from, to, flipped, c, 8, 0.85);
        });
      }
      // Labels after all arrows so they stay readable.
      for (const set of sets) if (set.text) set.moves.forEach((m, i) => {
        const [x1, y1] = squareXY(m.uci.slice(0, 2), flipped), [x2, y2] = squareXY(m.uci.slice(2, 4), flipped);
        const t = style === 'squares' ? 1 : set.t;
        svg += pill(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t + (style === 'squares' ? 28 : 0), set.text(m), i === 0 ? set.dark : set.color, '#fff');
      });
    }
    el.overlay.innerHTML = svg;
    // With suggestions off the evaluation bar is hidden too.
    drawEvalBar(barEval, r, flipped);
  }

  function liveStop() {
    LIVE.active = false;
    LIVE.key = null;
    LIVE.game = null;
    LIVE.viewPly = null;
    LIVE.evals.clear(); LIVE.top.clear(); LIVE.topFull.clear(); LIVE.human.clear();
    LIVE.barEval = null;
    LIVE.fallback = false;
    LIVE.emptySince = 0;
    LIVE.pending.clear();
    LIVE.jobs = {};
    if (LIVE.port) { try { LIVE.port.disconnect(); } catch (_) {} LIVE.port = null; }
    if (!S.game) clearNativeGlyphs();
    drawOverlay();
  }

  // ---------- Page watch loop ----------
  // Element in the Chess.com sidebar the panel is inserted above.
  function findSidebarAnchor() {
    if (SITE === 'lichess') return null; // Lichess: floating panel, its right column has no room
    const list = document.querySelector(MOVE_LIST_SEL);
    if (list) {
      const a = list.closest('.play-controller-scrollable, .move-list-wrapper, .sidebar-view-scrollable, [class*="scrollable"]') || list;
      if (a.parentElement && !a.closest('#cpa-panel-host')) return a;
    }
    const sb = document.querySelector('#board-layout-sidebar .sidebar-component, #board-layout-sidebar, .board-layout-sidebar');
    return sb && sb.firstElementChild ? sb.firstElementChild : null;
  }

  function setEmbedded(on) {
    el.panel.classList.toggle('embedded', on);
    panelHost.style.cssText = on
      ? 'display:block;position:relative;width:auto;height:auto;flex:none;z-index:1;'
      : 'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483000;';
  }

  const finishedById = {};
  const aiById = {};   // Lichess: is the opponent the Lichess computer?
  async function probeFinished(ref) {
    if (ref.key in finishedById) return;
    finishedById[ref.key] = null;
    if (ref.kind === 'lichess') {
      const j = await fetchLichess(ref);
      if (!j) { setTimeout(() => { delete finishedById[ref.key]; }, 5000); return; } // retry later
      const pw = j.players || {};
      aiById[ref.key] = !!((pw.white && pw.white.aiLevel) || (pw.black && pw.black.aiLevel));
      finishedById[ref.key] = j.status !== 'created' && j.status !== 'started';
      scheduleCheck();
      return;
    }
    for (const k of ref.kind ? [ref.kind] : ['live', 'daily']) {
      const d = await fetchGame(ref, k);
      if (!d) continue;
      const h = d.game.pgnHeaders || {};
      finishedById[ref.key] = d.game.isFinished === true || (!!h.Result && h.Result !== '*');
      scheduleCheck();
      return;
    }
    finishedById[ref.key] = false;
  }

  // Only offer the panel after a game ends: nothing appears while playing.
  function canOffer() {
    if (!findBoard()) return false;
    if (gameOverVisible()) return true;
    const ref = gameIdFromUrl();
    if (!ref) return false;
    if (!(ref.key in finishedById)) probeFinished(ref);
    return finishedById[ref.key] === true;
  }

  // The panel only appears for the analysis of a finished game; during games vs the computer
  // everything is shown on the board itself.
  function updateMount() {
    const anchor = findSidebarAnchor();
    el.panel.classList.remove('idle', 'live');
    el.title.textContent = 'Game analysis';
    el.fab.hidden = true;
    if (S.game && anchor) {
      if (panelHost.nextElementSibling !== anchor || panelHost.parentElement !== anchor.parentElement) {
        anchor.parentElement.insertBefore(panelHost, anchor);
      }
      setEmbedded(true);
      el.panel.hidden = false;
    } else if (S.game) {
      if (panelHost.parentElement !== document.body) document.body.appendChild(panelHost);
      setEmbedded(false);
      el.panel.hidden = false;
    } else {
      el.panel.hidden = true;
    }
    annotateNative();
  }
  const updateFab = updateMount;

  // ?!, ?, ?? marks directly in the Chess.com move list.
  function annotateNative() {
    let marks = null, total = 0;
    if (S.game && S.result) { marks = S.result.moves.map((m) => m && m.cls); total = S.game.plies.length; }
    else if (LIVE.active && LIVE.game && verdictsOn()) { marks = liveMarks(); total = LIVE.game.plies.length; }
    else if (LIVE.active) clearNativeGlyphs();
    const nodes = marks ? moveNodes() : [];
    const ok = nodes.length > 0 && nodes.length === total;
    el.panel.classList.toggle('native-list', ok);
    if (!ok) return;
    nodes.forEach((n, k) => {
      const c = marks[k + 1];
      const want = ['inaccuracy', 'mistake', 'blunder'].includes(c) ? c : null;
      let g = n.querySelector(':scope > .cpa-glyph');
      if (!want) { if (g) g.remove(); return; }
      if (g && g.dataset.c === want) return;
      if (!g) { g = document.createElement('span'); g.className = 'cpa-glyph'; n.appendChild(g); }
      g.dataset.c = want;
      g.title = CLS[want].label;
      g.textContent = CLS[want].glyph;
      g.style.cssText = `margin-left:3px;font-weight:800;font-size:.85em;color:${CLS[want].color};pointer-events:none;`;
    });
  }

  function clearNativeGlyphs() {
    document.querySelectorAll('.cpa-glyph').forEach((g) => g.remove());
    el.panel.classList.remove('native-list');
  }

  let lastUrl = location.href;
  let checkTimer = null;
  // The extension was reloaded or updated while this page stayed open: this copy of the script is orphaned.
  function orphaned() {
    if (S.orphaned) return true;
    let dead = false;
    try { dead = !(chrome.runtime && chrome.runtime.id); } catch (_) { dead = true; }
    if (!dead) return false;
    S.orphaned = true;
    clearInterval(checkInterval);
    el.overlay.style.display = 'none'; el.evalbar.style.display = 'none';
    toast('Board Coach was updated. Refresh this page to keep using it.');
    return true;
  }

  function check() {
    checkTimer = null;
    if (orphaned()) return;
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      const ref = gameIdFromUrl();
      if (S.game && (!ref || ref.key !== S.game.key) && !gameOverVisible()) {
        stopJob(); S.game = null; clearNativeGlyphs();
      }
    }
    // Bot games: a new game on the same page replaces the analysis of the previous one.
    if (isBotGamePage() && S.game && S.game.key.startsWith('dom-') && !S.running && !gameOverVisible() &&
        sansFromDom().length < S.game.plies.length) {
      stopJob(); S.game = null; S.dismissedUrl = null; clearNativeGlyphs();
    }
    // A new game against the computer on the same page: closing the previous analysis doesn't block this one.
    if (S.dismissedUrl && isBotGamePage() && !gameOverVisible() && sansFromDom().length < 2) S.dismissedUrl = null;
    watchBoard();
    try { liveTick(); liveWatchdog(); } catch (e) { console.error('[Board Coach]', e); }
    updateFab();
    if (!S.running && !S.game && S.dismissedUrl !== location.href && canOffer()) {
      const ref = gameIdFromPage();
      const key = ref ? ref.key : 'dom:' + sansFromDom().join(' ');
      if (!S.triggered.has(key) && (S.attempts[key] || 0) < 5) {
        S.triggered.add(key);
        S.attempts[key] = (S.attempts[key] || 0) + 1;
        start(false).then((ok) => { if (!ok) setTimeout(() => S.triggered.delete(key), 2500); });
      }
    }
    if (S.game || LIVE.active) {
      const r = S.board && document.contains(S.board) ? S.board.getBoundingClientRect() : null;
      const k = r ? `${r.left},${r.top},${r.width}` : '';
      if (k !== S.lastRect) { S.lastRect = k; drawOverlay(); }
    }
  }
  function scheduleCheck() { if (!checkTimer) checkTimer = setTimeout(check, 200); }

  new MutationObserver(scheduleCheck).observe(document.body, { childList: true, subtree: true });
  addEventListener('resize', () => drawOverlay());
  addEventListener('scroll', () => drawOverlay(), true);
  // Chrome keeps a page in its back/forward cache when you navigate away, and an open extension port
  // makes it complain ("The page keeping the extension port is moved into back/forward cache").
  // So the connections are closed when the page is hidden and reopened when it comes back.
  addEventListener('pagehide', () => {
    for (const port of [LIVE.port, S.port]) { try { port && port.disconnect(); } catch (_) {} }
    LIVE.port = null; LIVE.pending.clear(); LIVE.jobs = {};
    S.port = null; S.running = false;
  });
  addEventListener('pageshow', (e) => {
    if (!e.persisted || S.orphaned) return;
    try {
      if (S.game && !S.done) runAnalysis(S.game);
      LIVE.key = null;
      liveTick();
    } catch (err) { console.error('[Board Coach]', err); }
  });

  const checkInterval = setInterval(check, 1500);
  // Keeps the extension's background worker awake while a game is open.
  setInterval(() => { try { if (LIVE.port) LIVE.port.postMessage({ cmd: 'ping' }); } catch (_) {} }, 20000);
  check();
})();
