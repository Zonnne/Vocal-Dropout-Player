'use strict';
const assert = require('assert');
const { DropoutPlanner } = require('../src/dropout-planner');

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

console.log('dropout-planner tests');

test('perMinute=0 produces no events', () => {
  const p = new DropoutPlanner(mulberry32(1));
  p.setParams({ perMinute: 0, durationSec: 1 });
  assert.strictEqual(p.plan(10000).length, 0);
});

test('no overlapping dropouts', () => {
  const p = new DropoutPlanner(mulberry32(42));
  p.setParams({ perMinute: 60, durationSec: 3 }); // worst case: dense + long
  p.plan(3600);
  for (let i = 1; i < p.events.length; i++) {
    assert.ok(p.events[i].start >= p.events[i - 1].end,
      `overlap: ${p.events[i - 1].end} > ${p.events[i].start}`);
  }
});

test('durations within [0.5, 3.0]', () => {
  const p = new DropoutPlanner(mulberry32(7));
  p.setParams({ perMinute: 30, durationSec: 3 }); // max base + jitter must clamp
  p.plan(3600);
  assert.ok(p.events.length > 100);
  for (const ev of p.events) {
    const d = ev.end - ev.start;
    assert.ok(d >= 0.5 - 1e-9 && d <= 3.0 + 1e-9, `bad duration ${d}`);
  }
});

test('mean gap from dropout end ~= 60/perMinute - duration', () => {
  const perMin = 10, dur = 1;
  const p = new DropoutPlanner(mulberry32(123));
  p.setParams({ perMinute: perMin, durationSec: dur });
  p.plan(36000); // 10h => ~6000 events
  const gaps = [];
  for (let i = 1; i < p.events.length; i++) gaps.push(p.events[i].start - p.events[i - 1].end);
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const expected = 60 / perMin - dur; // gap is sampled from dropout END
  assert.ok(Math.abs(mean - expected) / expected < 0.05,
    `mean gap ${mean.toFixed(2)}s vs expected ${expected}s`);
});

test('event count matches frequency over long horizon', () => {
  const perMin = 12;
  const p = new DropoutPlanner(mulberry32(99));
  p.setParams({ perMinute: perMin, durationSec: 1 });
  const H = 36000;
  p.plan(H);
  const expected = (perMin / 60) * H;
  assert.ok(Math.abs(p.events.length - expected) / expected < 0.06,
    `count ${p.events.length} vs expected ~${expected}`);
});

test('plan() is idempotent across growing horizons', () => {
  const p = new DropoutPlanner(mulberry32(5));
  p.setParams({ perMinute: 20, durationSec: 1 });
  const a = p.plan(100);
  const b = p.plan(100); // same horizon => nothing new
  assert.strictEqual(b.length, 0);
  const c = p.plan(200);
  assert.strictEqual(p.events.length, a.length + c.length);
});

test('reset() clears state and re-plans from given time', () => {
  const p = new DropoutPlanner(mulberry32(5));
  p.setParams({ perMinute: 30, durationSec: 1 });
  p.plan(500);
  p.reset(1000);
  assert.strictEqual(p.events.length, 0);
  p.plan(1100);
  assert.ok(p.events.every(ev => ev.start >= 1000));
});

test('isMutedAt reflects planned events', () => {
  const p = new DropoutPlanner(mulberry32(11));
  p.setParams({ perMinute: 60, durationSec: 1 });
  p.plan(600);
  const ev = p.events[0];
  assert.ok(p.isMutedAt((ev.start + ev.end) / 2));
  assert.ok(!p.isMutedAt(ev.end + 0.001));
});

test('minGapSec cooldown is enforced between dropouts', () => {
  const p = new DropoutPlanner(mulberry32(2024));
  p.setParams({ perMinute: 60, durationSec: 1, minGapSec: 5 });
  p.plan(3600);
  assert.ok(p.events.length > 10);
  for (let i = 1; i < p.events.length; i++) {
    const gap = p.events[i].start - p.events[i - 1].end;
    assert.ok(gap >= 5 - 1e-9, `gap ${gap} below 5s cooldown`);
  }
});

test('minGapSec=0 (default) leaves Poisson gaps untouched', () => {
  const p = new DropoutPlanner(mulberry32(123));
  p.setParams({ perMinute: 10, durationSec: 1 });
  p.plan(36000);
  const gaps = [];
  for (let i = 1; i < p.events.length; i++) gaps.push(p.events[i].start - p.events[i - 1].end);
  // Exponential gaps can be arbitrarily small — without a floor some gap < 1s
  assert.ok(gaps.some(g => g < 1), 'expected at least one sub-1s gap without cooldown');
});

test('cooldown lowers the observed dropout rate', () => {
  const mk = seed => {
    const p = new DropoutPlanner(mulberry32(seed));
    p.setParams({ perMinute: 30, durationSec: 1 });
    return p;
  };
  const plain = mk(77); plain.plan(36000);
  const cooled = mk(77); cooled.setParams({ minGapSec: 5 }); cooled.plan(36000);
  assert.ok(cooled.events.length < plain.events.length,
    `cooled ${cooled.events.length} not below plain ${plain.events.length}`);
});

console.log(`\n${passed} tests passed`);
