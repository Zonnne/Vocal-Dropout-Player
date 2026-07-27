'use strict';
/* global dropoutApi */

const FADE = 0.025;          // 25ms linear gain fades => click-free
const COS_FADE = 0.010;      // 10ms raised-cosine edges (smooth option)
const LOOKAHEAD_SEC = 2;     // schedule automation this far ahead
const TICK_MS = 100;

// Raised-cosine (Hann-shaped) ramp from `from` to `to` over n samples.
function raisedCosine(n, from, to) {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 1 : i / (n - 1);
    c[i] = from + (to - from) * (0.5 - 0.5 * Math.cos(Math.PI * t));
  }
  return c;
}

// ---------- DOM ----------
const $ = id => document.getElementById(id);
const overlay = $('drop-overlay');
const playBtn = $('play-btn'), seekEl = $('seek');
const timeCur = $('time-cur'), timeTotal = $('time-total');
const libStatus = $('lib-status'), browseBtn = $('browse-btn');
const transportEl = $('transport'), controlsEl = $('controls');
const vocalBadge = $('vocal-badge');
const durSlider = $('dur-slider'), freqSlider = $('freq-slider'), gapSlider = $('gap-slider');
const balSlider = $('bal-slider'), volSlider = $('vol-slider');
const durVal = $('dur-val'), freqVal = $('freq-val'), gapVal = $('gap-val');
const balVal = $('bal-val'), volVal = $('vol-val');
const fadeToggle = $('fade-toggle');
const libraryList = $('library-list'), libEmpty = $('lib-empty'), libTable = $('lib-table');
const libPager = $('lib-pager'), libPageInfo = $('lib-page-info');
const libPrev = $('lib-prev'), libNext = $('lib-next');
const poissonControls = $('poisson-controls'), lyricsControls = $('lyrics-controls');
const wptSlider = $('wpt-slider'), wptVal = $('wpt-val');
const timelineCanvas = $('dropout-timeline');

// ---------- Dropout timeline (only reveals dropouts already PLAYED — no spoilers) ----------
function drawTimeline() {
  const c = timelineCanvas;
  if (!c || !c.clientWidth) return;
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth, h = c.clientHeight;
  if (c.width !== Math.round(w * dpr)) c.width = Math.round(w * dpr);
  if (c.height !== Math.round(h * dpr)) c.height = Math.round(h * dpr);
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  if (!player.duration) return;
  g.fillStyle = 'rgba(248, 113, 113, 0.9)'; // --danger, matches VOCAL OUT badge
  for (const ev of player.dropoutHistory) {
    const x0 = (ev.start / player.duration) * w;
    const x1 = Math.max((ev.end / player.duration) * w, x0 + 2);
    g.beginPath();
    if (g.roundRect) g.roundRect(x0, 1, x1 - x0, h - 2, 2);
    else g.rect(x0, 1, x1 - x0, h - 2);
    g.fill();
  }
}
new ResizeObserver(() => drawTimeline()).observe(timelineCanvas);

function fmt(t) {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
function setStatus(msg, cls = '') {
  libStatus.textContent = msg;
  libStatus.className = `lib-status ${cls}`;
}

// ---------- Dropout planner (mirror of src/dropout-planner.js, kept DOM-free) ----------
class DropoutPlanner {
  constructor(rng = Math.random) {
    this.rng = rng; this.durationSec = 1; this.perMinute = 10; this.minGapSec = 0; this.reset(0);
  }
  reset(now) { this.cursor = now; this.nextStart = null; this.events = []; }
  setParams({ durationSec, perMinute, minGapSec }) {
    if (durationSec !== undefined) this.durationSec = durationSec;
    if (perMinute !== undefined) this.perMinute = perMinute;
    if (minGapSec !== undefined) this.minGapSec = Math.max(0, minGapSec);
  }
  _gap() {
    // gap from previous dropout END, so observed onset rate ~= perMinute.
    // cycle = gap + duration  =>  E[gap] = 60/perMinute - duration
    const mean = Math.max(0.15, 60 / this.perMinute - this.durationSec);
    // cooldown floor: never closer than minGapSec between dropouts
    return Math.max(this.minGapSec, -Math.log(1 - this.rng()) * mean);
  }
  _dur() { return Math.min(3, Math.max(0.5, this.durationSec * (0.8 + 0.4 * this.rng()))); }
  plan(horizon) {
    if (!this.perMinute || this.perMinute <= 0) return [];
    if (this.nextStart === null) this.nextStart = Math.max(this.cursor, 0) + this._gap();
    const fresh = [];
    while (this.nextStart < horizon) {
      const dur = this._dur();
      const ev = { start: this.nextStart, end: this.nextStart + dur };
      this.events.push(ev); fresh.push(ev);
      this.nextStart = ev.end + this._gap();
    }
    this.cursor = horizon;
    return fresh;
  }
  isMutedAt(t) { return this.events.some(ev => t >= ev.start && t < ev.end); }
  pruneBefore(t) { this.events = this.events.filter(ev => ev.end >= t); }
}

// ---------- Lyrics planner (mirror of src/lyrics.js planLyricsDropouts) ----------
const LYRICS_MIN_GAP_WORDS = 3;
const MEAN_DROPOUT_LEN = 1.5; // 1 or 2 words, 50/50

function samplePoisson(lam, rng) {
  if (lam <= 0) return 0;
  const L = Math.exp(-lam);
  let k = 0, p = 1;
  do { k++; p *= rng(); } while (p > L);
  return k - 1;
}

function planLyricsDropouts(lines, { wordsPerTen, fromTime, duration, rng }) {
  const events = [];
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const words = line.words.filter(w => w.start < duration);
    const lineEnd = line.end == null ? Infinity : line.end; // JSON: Infinity -> null
    if (words.length < 3 || lineEnd <= fromTime) continue; // first two words are safe
    // expected muted words per line = wordsPerTen * n/10; ~1.5 words per dropout
    const k = samplePoisson(wordsPerTen * words.length / 10 / MEAN_DROPOUT_LEN, rng);
    if (k <= 0) continue;
    const chosen = [];
    let attempts = 0;
    while (chosen.length < k && attempts < 40) {
      attempts++;
      const idx = 2 + Math.floor(rng() * (words.length - 2));
      const len = Math.min(rng() < 0.5 ? 1 : 2, words.length - idx);
      const ok = chosen.every(c =>
        idx >= c.idx + c.len + LYRICS_MIN_GAP_WORDS || c.idx >= idx + len + LYRICS_MIN_GAP_WORDS);
      if (ok) chosen.push({ idx, len });
    }
    chosen.sort((a, b) => a.idx - b.idx);
    for (const c of chosen) {
      const start = words[c.idx].start;
      const next = words[c.idx + c.len];
      const end = Math.min(next ? next.start : lineEnd, duration);
      if (start < fromTime || !(end > start)) continue;
      events.push({ start, end });
    }
  }
  return events.sort((a, b) => a.start - b.start);
}

// Same interface as DropoutPlanner, but the whole song is planned at reset()
// from the lyrics timeline instead of incrementally from a time cursor.
class LyricsPlanner {
  constructor(rng = Math.random) {
    this.rng = rng; this.lines = []; this.duration = Infinity;
    this.wordsPerTen = 2; this.reset(0);
  }
  setLines(lines, duration) {
    this.lines = lines || [];
    this.duration = duration || Infinity;
  }
  setParams({ wordsPerTen }) {
    if (wordsPerTen !== undefined) this.wordsPerTen = wordsPerTen;
  }
  reset(now) {
    this.events = planLyricsDropouts(this.lines, {
      wordsPerTen: this.wordsPerTen,
      fromTime: Math.max(now, 0),
      duration: this.duration,
      rng: this.rng,
    });
    this.emitted = 0;
  }
  plan(horizon) {
    const fresh = [];
    while (this.emitted < this.events.length && this.events[this.emitted].start < horizon) {
      fresh.push(this.events[this.emitted++]);
    }
    return fresh;
  }
  isMutedAt(t) { return this.events.some(ev => t >= ev.start && t < ev.end); }
  pruneBefore(t) {
    // only drop already-emitted events so `emitted` stays valid
    let cut = 0;
    while (cut < this.emitted && this.events[cut].end < t) cut++;
    if (cut > 0) { this.events.splice(0, cut); this.emitted -= cut; }
  }
}

const dropoutPlanner = new DropoutPlanner();
const lyricsPlanner = new LyricsPlanner();

// ---------- Player ----------
const player = {
  ctx: null, buffers: null, duration: 0,
  master: null, vocalBalance: null, vocalDrop: null, instBalance: null,
  sources: null, startCtxTime: 0, startOffset: 0, playing: false,
  planner: dropoutPlanner,
  tickTimer: null,
  dropoutHistory: [],   // dropouts the listener has actually heard (start <= playhead)

  ensureCtx() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
      this.vocalBalance = this.ctx.createGain();
      this.vocalDrop = this.ctx.createGain();
      this.instBalance = this.ctx.createGain();
      this.vocalBalance.connect(this.vocalDrop).connect(this.master);
      this.instBalance.connect(this.master);
      this.applyMix();
    }
  },

  applyMix() {
    if (!this.ctx) return;
    const bal = balSlider.value / 100;              // 0..1 vocal level
    this.vocalBalance.gain.value = bal;
    this.instBalance.gain.value = 1;
    this.master.gain.value = volSlider.value / 100;
  },

  // Switch between the time-based (Poisson sliders) and lyrics-based planner.
  setLyrics(lyrics) {
    if (lyrics && lyrics.lines && lyrics.lines.length) {
      lyricsPlanner.setLines(lyrics.lines, this.duration);
      lyricsPlanner.setParams({ wordsPerTen: Number(wptSlider.value) });
      this.planner = lyricsPlanner;
    } else {
      this.planner = dropoutPlanner;
    }
    poissonControls.classList.toggle('hidden', this.planner === lyricsPlanner);
    lyricsControls.classList.toggle('hidden', this.planner !== lyricsPlanner);
    this.planner.reset(this.position());
    this.rescheduleFromHere();
    dropoutApi.fitWindow();
  },

  async load(vocalsAB, instAB) {
    this.ensureCtx();
    this.stopSources();
    const [v, i] = await Promise.all([
      this.ctx.decodeAudioData(vocalsAB),
      this.ctx.decodeAudioData(instAB),
    ]);
    this.buffers = { vocals: v, inst: i };
    this.duration = Math.max(v.duration, i.duration);
    this.startOffset = 0;
    this.playing = false;
    this.planner.reset(0);
    this.dropoutHistory = [];
    drawTimeline();
    playBtn.disabled = false;
    seekEl.disabled = false;
    playBtn.textContent = '▶';
    timeTotal.textContent = fmt(this.duration);
    this.updateTransport(0);
  },

  position() {
    if (!this.ctx) return 0;
    if (!this.playing) return this.startOffset;
    return Math.min(this.duration, this.ctx.currentTime - this.startCtxTime);
  },

  stopSources() {
    if (this.sources) {
      for (const s of Object.values(this.sources)) {
        try { s.onended = null; s.stop(); } catch (_) { /* already stopped */ }
        s.disconnect();
      }
      this.sources = null;
    }
  },

  startSources(offset) {
    this.stopSources();
    const t = this.ctx.currentTime + 0.05;
    const mk = (buf, chain) => {
      const s = this.ctx.createBufferSource();
      s.buffer = buf;
      s.connect(chain);
      s.start(t, Math.min(offset, buf.duration - 0.01));
      return s;
    };
    this.sources = {
      vocals: mk(this.buffers.vocals, this.vocalBalance),
      inst: mk(this.buffers.inst, this.instBalance),
    };
    this.sources.inst.onended = () => {
      if (this.playing && this.position() >= this.duration - 0.1) this.onEnded();
    };
    this.startCtxTime = t - offset;
    this.startOffset = offset;
  },

  play() {
    if (!this.buffers || this.playing) return;
    this.ensureCtx();
    this.ctx.resume();
    this.playing = true;
    this.startSources(this.startOffset);
    this.rescheduleFromHere(true);
    playBtn.textContent = '⏸';
    this.startTick();
  },

  pause() {
    if (!this.playing) return;
    this.startOffset = this.position();
    this.playing = false;
    this.stopSources();
    this.cancelAutomation();
    playBtn.textContent = '▶';
  },

  seek(frac) {
    const pos = frac * this.duration;
    const wasPlaying = this.playing;
    if (wasPlaying) { this.pause(); }
    this.startOffset = pos;
    this.planner.reset(pos);
    if (wasPlaying) this.play();
    this.updateTransport(pos);
  },

  onEnded() {
    this.playing = false;
    this.startOffset = 0;
    this.planner.reset(0);
    playBtn.textContent = '▶';
    this.updateTransport(0);
    vocalBadge.classList.add('hidden');
  },

  cancelAutomation() {
    if (!this.ctx) return;
    const g = this.vocalDrop.gain;
    g.cancelScheduledValues(this.ctx.currentTime);
    g.setValueAtTime(1, this.ctx.currentTime);
  },

  // Re-plan dropouts from current position; used on play, param change.
  rescheduleFromHere(freshStart = false) {
    if (!this.playing) return;
    const now = this.ctx.currentTime;
    const pos = this.position();
    const g = this.vocalDrop.gain;
    g.cancelScheduledValues(now);
    const muted = this.planner.isMutedAt(pos);
    this.planner.reset(pos);
    if (muted && !freshStart) {
      // end the in-flight dropout gracefully
      g.setValueAtTime(0, now);
      g.linearRampToValueAtTime(1, now + 0.3);
    } else {
      g.setValueAtTime(1, now);
    }
    vocalBadge.classList.add('hidden');
  },

  scheduleEvent(ev) {
    const g = this.vocalDrop.gain;
    const t0 = this.startCtxTime + ev.start;
    const t1 = this.startCtxTime + ev.end;
    if (fadeToggle.checked) {
      // 10ms raised-cosine edges: smoother than linear, no spectral splash
      const fade = Math.min(COS_FADE, (t1 - t0) / 2);
      const n = Math.max(2, Math.round(fade * this.ctx.sampleRate));
      g.setValueAtTime(1, t0);
      g.setValueCurveAtTime(raisedCosine(n, 1, 0), t0, fade);
      g.setValueCurveAtTime(raisedCosine(n, 0, 1), t1 - fade, fade);
    } else {
      const fade = Math.min(FADE, (t1 - t0) / 2);
      g.setValueAtTime(1, t0);
      g.linearRampToValueAtTime(0, t0 + fade);
      g.setValueAtTime(0, t1 - fade);
      g.linearRampToValueAtTime(1, t1);
    }
  },

  tick() {
    if (!this.playing) return;
    const pos = this.position();
    for (const ev of this.planner.plan(pos + LOOKAHEAD_SEC)) this.scheduleEvent(ev);
    // reveal dropouts once their start passes the playhead — future stays hidden
    for (const ev of this.planner.events) {
      if (!ev._shown && ev.start <= pos) {
        ev._shown = true;
        this.dropoutHistory.push({ start: ev.start, end: ev.end });
      }
    }
    drawTimeline();
    this.planner.pruneBefore(pos - 1);
    vocalBadge.classList.toggle('hidden', !this.planner.isMutedAt(pos));
    this.updateTransport(pos);
  },

  startTick() {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
  },

  updateTransport(pos) {
    timeCur.textContent = fmt(pos);
    if (this.duration > 0 && document.activeElement !== seekEl) {
      seekEl.value = Math.round((pos / this.duration) * 1000);
    }
  },
};

// ---------- File loading ----------
let progressOff = null;
let activeHash = null;   // library hash of the currently loaded song

function beginLoad(name) {
  browseBtn.classList.add('hidden');   // status text takes over the space
  // NOTE: current playback keeps going — the switch happens in finishLoad
  if (progressOff) progressOff();
  progressOff = null;
  setStatus(name);
}

function endLoad() {
  browseBtn.classList.remove('hidden');
}

async function finishLoad(result, name, t0) {
  const { vocals, accompaniment, hash, cached } = result;
  // cached loads are instant — no need for a status line; only report fresh separations
  setStatus(cached ? '' : `${name} — separated in ${Math.round((Date.now() - t0) / 1000)}s ✓`, cached ? '' : 'ok');
  const [vAB, iAB, lyrics] = await Promise.all([
    dropoutApi.readFile(vocals),
    dropoutApi.readFile(accompaniment),
    hash ? dropoutApi.getLyrics(hash) : null,
  ]);
  const wasPlaying = player.playing;
  await player.load(vAB, iAB);
  player.setLyrics(lyrics); // pick planner (lyrics vs time-based) now that duration is known
  if (wasPlaying) player.play(); // swap seamlessly into the new song
  activeHash = hash || null;
  transportEl.classList.remove('hidden');
  controlsEl.classList.remove('hidden');
  libPage = 0; // newly added/active song is at the top of the list
  renderLibrary();
  dropoutApi.fitWindow();
}

async function handleFile(filePath) {
  if (!filePath) return;
  const name = filePath.split('/').pop();
  beginLoad(name);
  progressOff = dropoutApi.onProgress(({ elapsed }) => {
    setStatus(`${name} — separating… ${elapsed}s (first run downloads the model)`);
  });

  try {
    const t0 = Date.now();
    await finishLoad(await dropoutApi.prepareStems(filePath), name, t0);
  } catch (err) {
    setStatus(err.message || String(err), 'error');
  } finally {
    if (progressOff) { progressOff(); progressOff = null; }
    endLoad();
  }
}

async function handleCached(entry) {
  if (entry.hash === activeHash) return;
  beginLoad(entry.name);
  try {
    await finishLoad(await dropoutApi.loadCached(entry.hash), entry.name, Date.now());
  } catch (err) {
    setStatus(err.message || String(err), 'error');
    renderLibrary();
  } finally {
    endLoad();
  }
}

// ---------- Cached-song library ----------
const LIB_PAGE_SIZE = 5;
let libEntries = [];
let libPage = 0;

function fmtDate(ts) {
  return new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

async function renderLibrary({ fit = true } = {}) {
  libEntries = await dropoutApi.listLibrary();
  const pages = Math.max(1, Math.ceil(libEntries.length / LIB_PAGE_SIZE));
  libPage = Math.min(Math.max(libPage, 0), pages - 1);
  const slice = libEntries.slice(libPage * LIB_PAGE_SIZE, (libPage + 1) * LIB_PAGE_SIZE);

  libraryList.textContent = '';
  libEmpty.classList.toggle('hidden', libEntries.length > 0);
  libTable.classList.toggle('hidden', libEntries.length === 0);
  for (const entry of slice) {
    const tr = document.createElement('tr');
    tr.className = 'lib-item' + (entry.hash === activeHash ? ' active' : '');
    const name = document.createElement('td');
    name.className = 'lib-name';
    name.textContent = entry.name;
    name.title = entry.filePath || entry.name;
    const date = document.createElement('td');
    date.className = 'lib-date';
    date.textContent = fmtDate(entry.addedAt);
    const act = document.createElement('td');
    act.className = 'lib-act';
    const lyr = document.createElement('button');
    lyr.className = 'lib-lyrics' + (entry.hasLyrics ? ' on' : '');
    // inline SVG "document with music note" — crisp at any scale, follows button color
    lyr.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
      + '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>'
      + '<path d="M14 2v6h6"/>'
      + '<circle cx="10" cy="16.5" r="1.8"/>'
      + '<path d="M11.8 16.5V10.8c1.5.2 2.7 1 3.2 2.5"/></svg>';
    lyr.title = entry.hasLyrics ? 'Lyrics attached — click to replace' : 'Attach word-by-word lyrics (.lrc)';
    lyr.addEventListener('click', async e => {
      e.stopPropagation();
      try {
        const res = await dropoutApi.pickLyrics(entry.hash);
        if (!res) return; // cancelled
        setStatus(`${entry.name} — lyrics attached (${res.lineCount} lines) ✓`, 'ok');
        if (entry.hash === activeHash) player.setLyrics(await dropoutApi.getLyrics(entry.hash));
        renderLibrary({ fit: false });
      } catch (err) {
        setStatus(err.message || String(err), 'error');
      }
    });
    const remove = document.createElement('button');
    remove.className = 'lib-remove';
    remove.textContent = '✕';
    remove.title = 'Remove from cache';
    remove.addEventListener('click', async e => {
      e.stopPropagation();
      await dropoutApi.removeFromLibrary(entry.hash);
      renderLibrary();
    });
    act.append(lyr, remove);
    tr.append(name, date, act);
    tr.addEventListener('click', () => handleCached(entry));
    libraryList.appendChild(tr);
  }
  // once paginated, pad with invisible rows so the table height never jumps
  if (libEntries.length > LIB_PAGE_SIZE) {
    for (let i = slice.length; i < LIB_PAGE_SIZE; i++) {
      const tr = document.createElement('tr');
      tr.className = 'lib-item lib-filler';
      // match real row metrics exactly (incl. the remove button) so the
      // table height never changes between pages
      tr.innerHTML = '<td class="lib-name">&nbsp;</td><td class="lib-date"></td>' +
        '<td class="lib-act"><button class="lib-remove" tabindex="-1">✕</button></td>';
      libraryList.appendChild(tr);
    }
  }

  libPager.classList.toggle('hidden', pages <= 1);
  libPageInfo.textContent = `${libPage + 1} / ${pages}`;
  libPrev.disabled = libPage === 0;
  libNext.disabled = libPage >= pages - 1;
  if (fit) dropoutApi.fitWindow();
}

// page switches never change layout height (filler rows), so skip re-fitting
libPrev.addEventListener('click', () => { libPage--; renderLibrary({ fit: false }); });
libNext.addEventListener('click', () => { libPage++; renderLibrary({ fit: false }); });

// ---------- UI wiring ----------
$('browse-btn').addEventListener('click', async () => handleFile(await dropoutApi.openFile()));

['dragenter', 'dragover'].forEach(ev =>
  document.addEventListener(ev, e => { e.preventDefault(); overlay.classList.add('on'); }));
['dragleave', 'drop'].forEach(ev =>
  document.addEventListener(ev, e => {
    e.preventDefault();
    if (ev === 'dragleave' && e.relatedTarget) return;
    overlay.classList.remove('on');
  }));
document.addEventListener('drop', e => {
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) handleFile(dropoutApi.getPathForFile(f));
});

playBtn.addEventListener('click', () => (player.playing ? player.pause() : player.play()));
document.addEventListener('keydown', e => {
  if (e.code === 'Space' && !e.target.matches('input,button')) {
    e.preventDefault();
    player.playing ? player.pause() : player.play();
  }
});
seekEl.addEventListener('change', () => player.seek(seekEl.value / 1000));

// Dropout math: one cycle = duration + gap, so the observed rate is
// 60 / (duration + meanGap) per minute. The cooldown floor must fit inside
// the mean gap or it silently overrides the frequency slider, hence the
// invariant:  duration + minGap <= 60 / frequency.
// Moving one slider clamps the others (the touched slider always wins).
function applyDropoutParams() {
  const D = Number(durSlider.value), F = Number(freqSlider.value), G = Number(gapSlider.value);
  durVal.textContent = `${D.toFixed(1)}s`;
  freqVal.textContent = F === 0 ? 'off' : `${F} /min`;
  gapVal.textContent = G === 0 ? 'off' : `${G.toFixed(1)}s`;
  player.planner.setParams({ durationSec: D, perMinute: F, minGapSec: G });
  player.rescheduleFromHere();
}

function floorTo(v, step) { return Math.floor(v / step) * step; }

function enforceConstraints(changed) {
  let D = Number(durSlider.value), F = Number(freqSlider.value), G = Number(gapSlider.value);
  if (F > 0) {
    const budget = 60 / F; // seconds per dropout cycle
    if (changed === 'freq') {
      if (D > budget) { D = Math.max(0.5, floorTo(budget, 0.1)); durSlider.value = D; }
      if (G > budget - D) { G = Math.max(0, floorTo(budget - D, 0.5)); gapSlider.value = G; }
    } else if (changed === 'dur') {
      if (D >= budget) {
        // duration alone eats the whole cycle: drop cooldown, lower frequency
        G = 0; gapSlider.value = 0;
        F = Math.max(1, Math.floor(60 / D)); freqSlider.value = F;
      } else if (G > budget - D) {
        G = Math.max(0, floorTo(budget - D, 0.5)); gapSlider.value = G;
      }
    } else if (changed === 'gap') {
      if (D + G > budget) {
        F = Math.max(1, Math.floor(60 / (D + G))); freqSlider.value = F;
      }
    }
  }
  applyDropoutParams();
}

durSlider.addEventListener('input', () => enforceConstraints('dur'));
freqSlider.addEventListener('input', () => enforceConstraints('freq'));
gapSlider.addEventListener('input', () => enforceConstraints('gap'));
wptSlider.addEventListener('input', () => {
  const v = Number(wptSlider.value);
  wptVal.textContent = `${v} word${v > 1 ? 's' : ''} /10`;
  lyricsPlanner.setParams({ wordsPerTen: v });
  player.rescheduleFromHere();
});
fadeToggle.addEventListener('change', () => player.rescheduleFromHere());
balSlider.addEventListener('input', () => { balVal.textContent = `${balSlider.value}%`; player.applyMix(); });
volSlider.addEventListener('input', () => { volVal.textContent = `${volSlider.value}%`; player.applyMix(); });

// ---------- Init ----------
player.planner.setParams({ minGapSec: Number(gapSlider.value) });
renderLibrary();

// Audio-engine (demucs) one-time setup runs in the background at launch;
// surface its progress where separation progress also appears.
dropoutApi.onBackendProgress(prog => {
  setStatus(prog.message, prog.stage === 'error' ? 'error' : prog.stage === 'done' ? 'ok' : '');
});
dropoutApi.backendStatus().then(st => {
  if (!st.ready) setStatus(st.message || 'Setting up audio engine…');
});
