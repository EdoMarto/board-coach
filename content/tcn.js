// Decodes the compact "TCN" format Chess.com uses to store move lists.
// Each move is two characters: from-square and to-square (promotion is encoded in the second).
var CPA_TCN = (function () {
  const T = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!?{~}(^)[_]@#$,./&-*++=';

  function decode(str) {
    const moves = [];
    for (let i = 0; i + 1 < str.length; i += 2) {
      const m = {};
      const o = T.indexOf(str[i]);
      let s = T.indexOf(str[i + 1]);
      if (o < 0 || s < 0) throw new Error('Invalid TCN');
      if (s > 63) {
        m.promotion = 'qnrbkp'[Math.floor((s - 64) / 3)];
        s = o + (o < 16 ? -8 : 8) + ((s - 1) % 3) - 1;
      }
      if (o > 75) {
        m.drop = 'qnrbkp'[o - 79];
      } else {
        m.from = T[o % 8] + (Math.floor(o / 8) + 1);
      }
      m.to = T[s % 8] + (Math.floor(s / 8) + 1);
      moves.push(m);
    }
    return moves;
  }

  return { decode };
})();

if (typeof module !== 'undefined') module.exports = CPA_TCN;
