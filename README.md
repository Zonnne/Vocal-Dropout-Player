# Vocal Dropout Player

Desktop music player that splits any song into vocals + instrumental with AI
(Demucs), plays them in perfect sync, and randomly mutes the vocals —
like a karaoke / groove-practice mode where the singer unpredictably drops out.

## Features

- **Add songs** via the "Add song…" button or drag & drop anywhere on the window (mp3/wav/flac/ogg/m4a)
- **AI stem separation** via [Demucs](https://github.com/adefossez/demucs) running locally
- **Stem cache** — each song is separated only once; re-opening is instant
- **Cached-song library** — previously separated songs are listed in a paginated
  table (5 per page) and can be replayed or removed with one click (no source file needed)
- **Random vocal dropouts** — NOT periodic. Dropout timing follows a Poisson
  process (exponentially distributed gaps), so mutes feel unpredictable:
  - **Slider 1 — Dropout duration**: 0.5s – 3.0s (each mute gets ±20% jitter, clamped to the slider range)
  - **Slider 2 — Dropout frequency**: 0 – 60 dropouts/minute (0 = off). The observed rate matches the slider: gaps are sampled from the end of the previous dropout with mean `60/rate − duration`.
  - **Slider 3 — Min gap (cooldown)**: 0 – 10s minimum silence between dropouts, so two mutes never land uncomfortably close. Default 5s.
  - The three are linked by `duration + minGap ≤ 60/frequency` (one cycle = duration + gap). The UI enforces it: moving one slider clamps the others, so the cooldown can never silently override the frequency.
- Sample-accurate, click-free muting via Web Audio gain automation
  (25ms linear fades; optional 10ms raised-cosine edges via the
  "Smooth mute edges" toggle, on by default)
- **Word-by-word lyrics mode** — attach a character-timed `.lrc` (LDDC style:
  `[mm:ss.mmm]字[mm:ss.mmm]字…`) to any cached song via the 🎤 icon in its row.
  With lyrics attached, the three dropout sliders are replaced by a single
  **Dropout intensity** slider — **muted words per 10 words** (1–4, default 2):
  - Rate is applied per line: k ~ Poisson(`wordsPerTen × n/10 ÷ 1.5`) for an n-word line
  - Each dropout mutes **1–2 consecutive words** (mean 1.5)
  - The **first 2 words** of every line are never muted
  - Dropouts in a line keep a **3-word minimum gap** (gap unit = words)
  - Spaces/punctuation tokens are timed but never chosen as dropout targets
- Live slider adjustment mid-playback, seek, play/pause (spacebar),
  vocal/instrumental balance, master volume, "VOCAL OUT" indicator

## Setup

```bash
# 1. Demucs backend (one-time; also runnable via ../setup_demucs.sh)
python3.12 -m venv ../demucs-venv        # any python >= 3.9 works
../demucs-venv/bin/pip install demucs    # pulls PyTorch (~2GB)

# 2. App
npm install
npm start
```

The app auto-detects the venv at `../demucs-venv/bin/python` (relative to this
folder). If it's missing, it installs its own backend into the Electron
`userData` dir on first launch (standalone CPython + `demucs==4.1.0`, no
system Python needed) and shows progress in the UI.

First separation of a song downloads the Demucs model (~80MB) and takes
~30s–2min on CPU. Stems are cached in the Electron `userData/stems/` dir.

## Distributing

```bash
npm run dist   # -> dist/Vocal Dropout Player-1.0.0-arm64.dmg
```

The DMG contains only the Electron app (~100MB, Apple Silicon). On a user's
machine, first launch downloads the audio engine (standalone Python + Demucs
+ PyTorch) in the background with live progress; everything after that works
offline. No Apple Developer account is used: the build is unsigned (ad-hoc
signed for arm64), so users must **right-click → Open** once to get past
Gatekeeper. For Intel Macs, build on/for x64 (`--x64`) so the matching
Python runtime gets downloaded.

## Tests

```bash
npm test   # statistical tests for the Poisson dropout planner
```

## How the dropout scheduler works

`src/dropout-planner.js` is a pure, DOM-free module. Onsets form a Poisson
process: each gap is `-ln(1-U) * mean` with `mean = 60/perMinute - duration`
(sampled from the previous dropout's *end*, so onsets never overlap and the
observed rate still matches the slider), floored at `minGapSec` so dropouts
keep a cooldown distance. The renderer runs a 100ms lookahead
scheduler that plans 2s ahead and programs fades on the vocal gain node —
`linearRampToValueAtTime` (25ms) by default, or 10ms raised-cosine curves via
`setValueCurveAtTime` when "Smooth mute edges" is on. Seeking or moving a
slider cancels future automation and re-plans from the current position.

## Packaging / distribution

```bash
./scripts/dist.sh          # build everything (mac arm64+intel dmg, windows exe+zip)
./scripts/dist.sh intel    # intel dmg only   (also: mac | arm64 | win)
```

Artifacts land in `dist/`. The script auto-repairs the electron binary if npm
blocked its postinstall. Set `CSC_NAME` / `APPLE_ID` /
`APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` env vars beforehand for
signed + notarized macOS builds. Windows builds are unsigned (SmartScreen
warning: "More info → Run anyway").
