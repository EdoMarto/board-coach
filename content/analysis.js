// Pure functions: game building, eval normalization, move classification.
var CPA_ANALYSIS = (function () {
  const ChessCtor = typeof Chess !== 'undefined' ? Chess : require('../lib/chess.js').Chess;
  const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  // Applies a {from,to,promotion} move; handles castling encoded as "king takes rook".
  function applyMove(chess, mv) {
    let r = chess.move({ from: mv.from, to: mv.to, promotion: mv.promotion || 'q' });
    if (r) return r;
    const piece = chess.get(mv.from);
    const target = chess.get(mv.to);
    if (piece && piece.type === 'k' && target && target.type === 'r' && target.color === piece.color) {
      const file = mv.to[0] > mv.from[0] ? 'g' : 'c';
      r = chess.move({ from: mv.from, to: file + mv.from[1] });
    }
    return r;
  }

  function buildFromMoves(moves, startFen) {
    const chess = new ChessCtor(startFen || START_FEN);
    const fens = [chess.fen()];
    const plies = [];
    for (const mv of moves) {
      if (mv.drop) throw new Error('Unsupported variant');
      const r = applyMove(chess, mv);
      if (!r) throw new Error('Illegal move: ' + mv.from + mv.to);
      plies.push({ san: r.san, from: r.from, to: r.to, color: r.color, uci: r.from + r.to + (r.promotion || '') });
      fens.push(chess.fen());
    }
    return { fens, plies };
  }

  function buildFromSans(sans, startFen) {
    const chess = new ChessCtor(startFen || START_FEN);
    const fens = [chess.fen()];
    const plies = [];
    for (const san of sans) {
      const r = chess.move(san, { sloppy: true });
      if (!r) break;
      plies.push({ san: r.san, from: r.from, to: r.to, color: r.color, uci: r.from + r.to + (r.promotion || '') });
      fens.push(chess.fen());
    }
    return { fens, plies };
  }

  // Evaluation normalized to White's point of view.
  function normalize(fen, res) {
    if (!res) return null;
    const stm = fen.split(' ')[1];
    const sign = stm === 'w' ? 1 : -1;
    let cp = null, mate = null, wcp;
    if (res.mate !== null && res.mate !== undefined) {
      if (res.mate === 0) {
        mate = 0;
        wcp = stm === 'w' ? -10000 : 10000;
      } else {
        mate = res.mate * sign;
        wcp = mate > 0 ? 10000 - mate * 10 : -10000 - mate * 10;
      }
    } else {
      cp = (res.cp || 0) * sign;
      wcp = cp;
    }
    return { cp, mate, wcp, best: res.best && res.best !== '(none)' ? res.best : null, pv: res.pv || [], stm };
  }

  function winChance(wcp) {
    const c = Math.max(-1000, Math.min(1000, wcp));
    return 2 / (1 + Math.exp(-0.00368208 * c)) - 1; // from -1 (Black wins) to +1 (White wins)
  }

  function moveAccuracy(winBefore, winAfter) {
    const loss = Math.max(0, (winBefore - winAfter) * 50); // in percentage points
    return Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * loss) - 3.1669));
  }

  function legalCount(fen) {
    return new ChessCtor(fen).moves().length;
  }

  function uciToSan(fen, uci) {
    if (!uci || uci.length < 4) return null;
    const c = new ChessCtor(fen);
    const r = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || 'q' });
    return r ? r.san : null;
  }

  function pvToSan(fen, pv, max) {
    const c = new ChessCtor(fen);
    const out = [];
    for (const u of pv.slice(0, max || 6)) {
      const r = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] || 'q' });
      if (!r) break;
      out.push(r.san);
    }
    return out;
  }

  // evals[i] = normalized eval of the position after i plies (evals[0] = starting position)
  // Judges a single move: position before, its eval, eval after, and the move played.
  function classifyOne(fenBefore, before, after, ply) {
    if (!before || !after) return null;
    const wb = winChance(before.wcp), wa = winChance(after.wcp);
    const pov = ply.color === 'w' ? 1 : -1;
    const drop = (wb - wa) * pov;
    let cls;
    if (legalCount(fenBefore) === 1) cls = 'forced';
    else if (before.best && before.best === ply.uci) cls = 'best';
    else if (drop >= 0.3) cls = 'blunder';
    else if (drop >= 0.2) cls = 'mistake';
    else if (drop >= 0.1) cls = 'inaccuracy';
    else cls = 'good';
    return {
      cls,
      drop,
      accuracy: moveAccuracy(wb * pov, wa * pov),
      bestSan: cls === 'best' || cls === 'forced' ? null : uciToSan(fenBefore, before.best),
      bestUci: before.best,
      bestEval: before,
      line: pvToSan(fenBefore, before.pv, 6)
    };
  }

  function classify(game, evals) {
    const res = [];
    const acc = { w: [], b: [] };
    const counts = {
      w: { best: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0, forced: 0 },
      b: { best: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0, forced: 0 }
    };
    for (let i = 1; i < game.fens.length; i++) {
      const ply = game.plies[i - 1];
      const m = classifyOne(game.fens[i - 1], evals[i - 1], evals[i], ply);
      res[i] = m;
      if (!m) continue;
      counts[ply.color][m.cls]++;
      acc[ply.color].push(m.accuracy);
    }
    const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
    return { moves: res, accuracy: { w: avg(acc.w), b: avg(acc.b) }, counts };
  }

  // short = compact form for the narrow evaluation bar ("M2"); otherwise "Mate in 2".
  function formatEval(e, short) {
    if (!e) return '…';
    if (e.mate !== null && e.mate !== undefined) {
      if (e.mate === 0) return e.wcp > 0 ? '1-0' : '0-1';
      return short ? 'M' + Math.abs(e.mate) : 'Mate in ' + Math.abs(e.mate);
    }
    const v = e.cp / 100;
    return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1);
  }

  // ----- Human move model -----
  // Estimates how likely a player of a given Elo is to choose each legal move. Not recorded human data.
  // Weak players: pick by simple habits (captures, checks, centre, development), often miss that a piece
  // can be taken, and are noisy. Strong players: follow the engine's shallow search with a narrow spread.
  const VAL = { p: 100, n: 300, b: 320, r: 500, q: 900, k: 0 };
  const HUMAN_PARAMS = { blindTo: 2200, noise: 0.2, noiseTo: 2000, spread: 900, spreadDecay: 450, openingT: 0.85 };

  function hash01(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return ((h >>> 0) % 100000) / 100000;
  }

  // Rough "what a beginner likes" score of a move, in centipawns.
  function habitScore(chess, mv, opening) {
    let h = VAL[mv.captured] || 0;
    if (mv.san.includes('+')) h += 60;
    if (mv.san.includes('#')) h += 2000;
    if (mv.promotion) h += 700;
    const f = mv.to.charCodeAt(0) - 97, r = +mv.to[1] - 1;
    if ((f === 3 || f === 4) && (r === 3 || r === 4)) h += 40;
    else if (f >= 2 && f <= 5 && r >= 2 && r <= 5) h += 20;
    if (opening && (mv.piece === 'n' || mv.piece === 'b') && mv.from[1] === (mv.color === 'w' ? '1' : '8')) h += 50;
    if (/[kq]/.test(mv.flags)) h += 60;
    // Beginners only half-notice that the moved piece can be captured.
    chess.move({ from: mv.from, to: mv.to, promotion: mv.promotion });
    const hanging = chess.moves({ verbose: true }).some((o) => o.to === mv.to && /c|e/.test(o.flags));
    chess.undo();
    if (hanging && VAL[mv.piece] > (VAL[mv.captured] || 0)) h -= 0.5 * VAL[mv.piece];
    return h;
  }

  // raw: Map(uci -> score of that move from the mover's point of view, in cp).
  function humanDistribution(fen, raw, elo, params) {
    const P = Object.assign({}, HUMAN_PARAMS, params || {});
    const chess = new ChessCtor(fen);
    const moves = chess.moves({ verbose: true }).filter((m) => !(m.promotion && m.promotion !== 'q'));
    const opening = +fen.split(' ')[5] <= 12;
    let best = -Infinity;
    for (const v of raw.values()) if (v > best) best = v;
    const alpha = Math.max(0, Math.min(1, (elo - 400) / (P.blindTo - 400)));
    const amp = Math.max(0, P.noiseTo - elo) * P.noise;
    const T = 10 + P.spread * Math.exp(-elo / P.spreadDecay);
    const rows = [];
    for (const mv of moves) {
      const uci = mv.from + mv.to + (mv.promotion || '');
      const sc = raw.get(uci);
      if (sc === undefined) continue;
      rows.push({ mv, uci, eng: Math.max(sc - best, -2000), habit: alpha < 1 ? habitScore(chess, mv, opening) : 0 });
    }
    if (!rows.length) return [];
    const maxHabit = Math.max(...rows.map((r) => r.habit));
    for (const r of rows) {
      const rel = alpha * r.eng + (1 - alpha) * (r.habit - maxHabit);
      r.score = rel + (hash01(fen + r.uci) * 2 - 1) * amp;
    }
    const top = Math.max(...rows.map((r) => r.score));
    const out = rows.map((r) => {
      const mv = r.mv;
      let w = Math.exp((r.score - top) / (opening ? T * P.openingT : T));
      if (/[kq]/.test(mv.flags)) w *= 1.5; else if (mv.piece === 'k') w *= 0.6;
      // Opening habits: develop knights and bishops, push centre pawns; rarely edge pawns, early queen or king walks.
      if (opening) {
        const back = mv.color === 'w' ? '1' : '8';
        if (mv.piece === 'n' && mv.from[1] === back) w *= /[ah]/.test(mv.to[0]) ? 0.4 : 3;
        else if (mv.piece === 'b' && mv.from[1] === back) w *= 2;
        else if (mv.piece === 'p' && /[cde]/.test(mv.from[0]) && !/[ce]/.test(mv.flags)) w *= 2;
        else if (mv.piece === 'p' && /[abgh]/.test(mv.from[0])) w *= 0.35;
        else if (mv.piece === 'q') w *= 0.5;
        else if (mv.piece === 'r' || mv.piece === 'k') w *= 0.4;
      }
      return { uci: r.uci, san: mv.san, w };
    });
    const sum = out.reduce((a, x) => a + x.w, 0) || 1;
    out.forEach((x) => { x.p = x.w / sum; });
    return out.sort((a, b) => b.p - a.p);
  }

  // Dynamic difficulty: the imitated player makes more mistakes when you are ahead and fewer when you are behind.
  // advantageCp is from your point of view; maxShift is the largest Elo change (0 turns it off).
  function adaptElo(elo, advantageCp, maxShift) {
    const a = Math.max(-2000, Math.min(2000, advantageCp));
    return Math.max(400, Math.min(2800, Math.round(elo - maxShift * Math.tanh(a / 250))));
  }

  return { START_FEN, buildFromMoves, buildFromSans, normalize, winChance, classify, classifyOne, formatEval, uciToSan, humanDistribution, adaptElo };
})();

if (typeof module !== 'undefined') module.exports = CPA_ANALYSIS;
