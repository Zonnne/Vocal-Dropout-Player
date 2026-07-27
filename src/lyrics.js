'use strict';
/**
 * Word-by-word (character-by-character) lyrics support.
 *
 * parseLrc: parses LDDC-style LRC where EVERY character carries its own
 * timestamp:  [mm:ss.mmm]字[mm:ss.mmm]字...
 * Spaces and punctuation tokens (e.g. " ", "-", "：") are used for timing
 * but excluded from the word list — for Chinese lyrics one word = one
 * character. Word end = next token's start (or the line's end); a line's
 * end = the next line's start (Infinity for the last line).
 *
 * planLyricsDropouts: the rate is expressed as WORDS PER 10 WORDS — how many
 * muted words to expect per 10 words of lyrics. Behind the scenes it is
 * still Poisson: for a line of n words, the dropout count is
 * k ~ Poisson(wordsPerTen * n / 10 / 1.5), where 1.5 is the mean dropout
 * length (1 or 2 words, 50/50). Each dropout mutes 1 or 2 consecutive
 * words, never the first two words of a line, and any two dropouts in a
 * line keep a minimum gap measured in WORDS between the end of one and
 * the start of the next.
 */

const MIN_GAP_WORDS = 3;
const MEAN_DROPOUT_LEN = 1.5; // 1 or 2 words, 50/50

const TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]([^[]*)/g;
const WORD_CHAR = /[㐀-䶿一-鿿A-Za-z0-9]/;

function parseTime(m, s, frac) {
  // ".5" -> 0.5s, ".05" -> 0.05s, ".638" -> 0.638s
  const f = frac ? Number('0.' + frac.padEnd(3, '0').slice(0, 3)) : 0;
  return Number(m) * 60 + Number(s) + f;
}

function parseLrc(text) {
  const lines = [];
  for (const rawLine of text.split(/\r?\n/)) {
    TAG.lastIndex = 0;
    const tokens = [];
    let m;
    while ((m = TAG.exec(rawLine))) {
      tokens.push({ start: parseTime(m[1], m[2], m[3]), text: m[4] });
    }
    if (!tokens.length) continue; // metadata ([ti:...], [ar:...]) or blank
    const words = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i].text.trim();
      if (t && WORD_CHAR.test(t)) {
        words.push({
          text: t,
          start: tokens[i].start,
          end: i + 1 < tokens.length ? tokens[i + 1].start : null,
        });
      }
    }
    if (words.length) lines.push({ start: tokens[0].start, words });
  }
  for (let i = 0; i < lines.length; i++) {
    const lineEnd = i + 1 < lines.length ? lines[i + 1].start : Infinity;
    lines[i].end = lineEnd;
    for (const w of lines[i].words) {
      if (w.end === null || w.end > lineEnd) w.end = lineEnd;
    }
  }
  return { lines };
}

/** Knuth's algorithm: sample a Poisson-distributed count with mean lam. */
function samplePoisson(lam, rng) {
  if (lam <= 0) return 0;
  const L = Math.exp(-lam);
  let k = 0, p = 1;
  do { k++; p *= rng(); } while (p > L);
  return k - 1;
}

/**
 * Plan dropout events for a whole song's lyrics.
 * Returns [{ start, end, line, word, len }] sorted by start, where
 * `word`/`len` are the index/length (in words) inside `line` — kept for
 * testability; the scheduler only needs start/end.
 */
function planLyricsDropouts(lines, {
  wordsPerTen = 2,
  minGapWords = MIN_GAP_WORDS,
  fromTime = 0,
  duration = Infinity,
  rng = Math.random,
} = {}) {
  const events = [];
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const words = line.words.filter(w => w.start < duration);
    const lineEnd = line.end == null ? Infinity : line.end; // JSON turns Infinity into null
    if (words.length < 3 || lineEnd <= fromTime) continue; // first two words are always safe
    // rate per line: expected muted words = wordsPerTen * n/10, and each
    // dropout covers ~1.5 words on average
    const k = samplePoisson(wordsPerTen * words.length / 10 / MEAN_DROPOUT_LEN, rng);
    if (k <= 0) continue;

    const chosen = [];
    let attempts = 0;
    while (chosen.length < k && attempts < 40) {
      attempts++;
      const idx = 2 + Math.floor(rng() * (words.length - 2));
      const len = Math.min(rng() < 0.5 ? 1 : 2, words.length - idx);
      const ok = chosen.every(c =>
        idx >= c.idx + c.len + minGapWords || c.idx >= idx + len + minGapWords);
      if (ok) chosen.push({ idx, len });
    }
    chosen.sort((a, b) => a.idx - b.idx);

    for (const c of chosen) {
      const start = words[c.idx].start;
      const next = words[c.idx + c.len];
      const end = Math.min(next ? next.start : lineEnd, duration);
      if (start < fromTime || !(end > start)) continue;
      events.push({ start, end, line: li, word: c.idx, len: c.len });
    }
  }
  return events.sort((a, b) => a.start - b.start);
}

module.exports = { parseLrc, planLyricsDropouts, samplePoisson, MIN_GAP_WORDS, MEAN_DROPOUT_LEN };
