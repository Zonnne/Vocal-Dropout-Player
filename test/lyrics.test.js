'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { parseLrc, planLyricsDropouts, MIN_GAP_WORDS } = require('../src/lyrics');

// deterministic PRNG (mulberry32)
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`  ✓ ${name}`); }

console.log('lyrics tests');

const SAMPLE = [
  '[ti:测试]', '[ar:tester]', '',
  '[00:01.000]你[00:01.500]好[00:02.000]世[00:02.500]界',
  '[00:03.000]再[00:03.500]见',
  '[00:04.00]a[00:04.50]b[00:05.00]c[00:05.50]d',
].join('\n');

test('parser: skips metadata, extracts word times', () => {
  const { lines } = parseLrc(SAMPLE);
  assert.strictEqual(lines.length, 3);
  assert.deepStrictEqual(lines[0].words.map(w => w.text), ['你', '好', '世', '界']);
  assert.strictEqual(lines[0].start, 1);
  assert.strictEqual(lines[0].words[1].start, 1.5);
});

test('parser: word end = next token start, line end = next line start', () => {
  const { lines } = parseLrc(SAMPLE);
  assert.strictEqual(lines[0].words[0].end, 1.5);
  assert.strictEqual(lines[0].words[3].end, 3);   // last word ends at next line
  assert.strictEqual(lines[0].end, 3);
  assert.strictEqual(lines[2].end, Infinity);      // last line open-ended
});

test('parser: fractional seconds parse correctly (.5 = half second)', () => {
  const { lines } = parseLrc(SAMPLE);
  assert.strictEqual(lines[2].words[0].start, 4);
  assert.strictEqual(lines[2].words[1].start, 4.5);
});

test('parser: spaces and punctuation are not words', () => {
  const { lines } = parseLrc('[00:01.00]词[00:02.00]：[00:03.00]许[00:04.00] [00:05.00]嵩');
  assert.deepStrictEqual(lines[0].words.map(w => w.text), ['词', '许', '嵩']);
  assert.strictEqual(lines[0].words[0].end, 2); // 词 ends where "：" starts
});

test('parser: handles the real sample.lrc', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'sample.lrc'), 'utf8');
  const { lines } = parseLrc(text);
  assert.ok(lines.length > 40, `only ${lines.length} lines`);
  for (const line of lines) {
    for (let i = 1; i < line.words.length; i++) {
      assert.ok(line.words[i].start >= line.words[i - 1].start, 'word times monotonic');
    }
  }
});

function fakeLines(nLines, wordsPerLine) {
  const lines = [];
  let t = 0;
  for (let i = 0; i < nLines; i++) {
    const words = [];
    for (let j = 0; j < wordsPerLine; j++) { words.push({ text: 'x', start: t, end: t + 0.3 }); t += 0.3; }
    lines.push({ start: words[0].start, end: t + 2, words });
    t += 2;
  }
  return lines;
}

test('wordsPerTen=0 produces no events', () => {
  const ev = planLyricsDropouts(fakeLines(100, 10), { wordsPerTen: 0, rng: mulberry32(1) });
  assert.strictEqual(ev.length, 0);
});

test('never mutes the first two words of a line', () => {
  const ev = planLyricsDropouts(fakeLines(200, 8), { wordsPerTen: 4, rng: mulberry32(2) });
  assert.ok(ev.length > 0);
  for (const e of ev) assert.ok(e.word >= 2, `word index ${e.word} < 2`);
});

test('dropouts are 1-2 words and keep the min word gap per line', () => {
  const ev = planLyricsDropouts(fakeLines(300, 12), { wordsPerTen: 4, rng: mulberry32(3) });
  assert.ok(ev.length > 0);
  for (const e of ev) assert.ok(e.len === 1 || e.len === 2, `bad len ${e.len}`);
  const byLine = {};
  for (const e of ev) (byLine[e.line] = byLine[e.line] || []).push(e);
  for (const list of Object.values(byLine)) {
    for (let i = 1; i < list.length; i++) {
      const gap = list[i].word - (list[i - 1].word + list[i - 1].len);
      assert.ok(gap >= MIN_GAP_WORDS, `gap ${gap} < ${MIN_GAP_WORDS} words`);
    }
  }
});

test('muted words per 10 words ~= wordsPerTen (Poisson underneath)', () => {
  const wpt = 1;
  const N = 20000, WPL = 30;
  // long lines + low density so placement (min word gap) almost never caps the draw
  const ev = planLyricsDropouts(fakeLines(N, WPL), { wordsPerTen: wpt, rng: mulberry32(4) });
  const mutedWords = ev.reduce((a, e) => a + e.len, 0);
  const perTen = mutedWords / (N * WPL) * 10;
  assert.ok(Math.abs(perTen - wpt) / wpt < 0.05, `${perTen.toFixed(3)} vs ${wpt} per 10 words`);
});

test('lines shorter than 3 words never dropout', () => {
  const ev = planLyricsDropouts(fakeLines(50, 2), { wordsPerTen: 4, rng: mulberry32(5) });
  assert.strictEqual(ev.length, 0);
});

test('events respect fromTime and duration', () => {
  const lines = fakeLines(50, 10); // line i words span [i*2.3, i*2.3+3)
  const ev = planLyricsDropouts(lines, {
    wordsPerTen: 4, fromTime: 20, duration: 40, rng: mulberry32(6),
  });
  assert.ok(ev.length > 0);
  for (const e of ev) {
    assert.ok(e.start >= 20, `start ${e.start} < fromTime`);
    assert.ok(e.end <= 40, `end ${e.end} > duration`);
  }
});

console.log(`\n${passed} tests passed`);
