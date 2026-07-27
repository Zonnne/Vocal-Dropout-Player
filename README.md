# Vocal Dropout Player

<p>
  <img src="build/icon.png" width="128" align="right" alt="App icon">
</p>

**Karaoke roulette for your music library.** Drop in any song and Vocal
Dropout Player splits it into vocals + instrumental with on-device AI
([Demucs](https://github.com/adefossez/demucs)), plays them in perfect sync —
and then randomly mutes the singer. Test whether *you* can keep the melody
going when the vocal drops out. No accounts, no cloud, no subscriptions.

---

## Download

Grab the latest build from
[**Releases**](https://github.com/Zonnne/Vocal-Dropout-Player/releases):

| Platform | File | Notes |
|---|---|---|
| macOS (Apple Silicon) | `…-arm64.dmg` | M1/M2/M3/M4 Macs |
| macOS (Intel) | `….dmg` | Intel Macs |
| Windows | `…Setup ….exe` | Installer (recommended) |
| Windows (portable) | `…-win.zip` | Unzip & run, no install |

### "App can't be opened" / SmartScreen warnings

The builds are **unsigned** (no paid Apple/Microsoft certificates), so your OS
will warn you once:

- **macOS**: right-click the app → **Open** → **Open** again. That's it, forever.
- **Windows**: click **More info** → **Run anyway**.

### First launch: one-time audio-engine setup

On first run the app downloads its AI audio engine (standalone Python +
Demucs + PyTorch, **~2GB**) in the background — you'll see live progress in
the window. This happens **once**; after that everything works fully offline.
The first song you add also downloads the separation model (~80MB).

## How to use

1. **Add a song** — drag & drop an audio file anywhere onto the window, or
   click **Add song…** (mp3 / wav / flac / ogg / m4a).
2. **Wait a moment** — the first play of each song separates vocals from
   instrumental (a few seconds to ~2 min depending on song length). The
   result is **cached**, so next time it's instant. Separated songs live in
   your library list — click any row to play it again, no source file needed.
3. **Turn the knobs**:
   - **Dropout duration** (0.5–3s) — how long the singer vanishes
   - **Dropout frequency** (0–60/min) — how often it happens
   - **Min gap** (0–10s) — cooldown so two dropouts never crowd each other
4. **Watch the timeline** — the strip above the seek bar stamps every dropout
   *as you hear it*. It never reveals the future: no spoilers, no cheating.
5. Extras: **spacebar** play/pause, seek bar, vocal/instrumental balance
   (practice with less vocal help!), master volume, smooth-edge toggle.

Dropouts are **genuinely random** (Poisson-distributed) — you'll never learn
the pattern, because there isn't one.

### Lyrics mode (advanced)

Attach a **character-timed `.lrc`** file (LDDC/karaoke style, where every word
or character has a timestamp) via the 📄 icon in a song's row. The sliders
switch to a single **Dropout intensity** control: how many words per 10 get
muted. Each dropout mutes 1–2 consecutive words, the first 2 words of every
line are always safe, and muted words keep a 3-word gap.

## Troubleshooting

- **"Audio engine setup failed"** — usually a network hiccup during the ~2GB
  download. Restart the app; it retries from scratch.
- **Separation is slow** — the AI runs on your CPU. A 4-minute song takes
  roughly 30s–2min. It only happens once per song.
- **Where's my stuff stored?** Separated stems, lyrics, and the audio engine
  live in the app's data folder (`~/Library/Application Support/vocal-dropout-player`
  on macOS, `%APPDATA%/vocal-dropout-player` on Windows). Deleting a song from
  the library frees its stems; deleting the whole folder is a clean uninstall.

## For developers

Build from source (macOS/Linux/Windows):

```bash
git clone https://github.com/Zonnne/Vocal-Dropout-Player.git
cd Vocal-Dropout-Player
npm install
npm start        # run the app
npm test         # statistical tests for the dropout planners
```

The Demucs backend is auto-installed on first run — no system Python needed
(during development, a venv at `../demucs-venv` is used if present).

Package distributables:

```bash
./scripts/dist.sh          # mac arm64+intel dmg + windows exe/zip
./scripts/dist.sh intel    # individual targets: mac | arm64 | intel | win
```

Set `CSC_NAME`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`
beforehand for signed & notarized macOS builds.

Under the hood: Electron + Web Audio API (sample-accurate, click-free gain
automation), Poisson dropout scheduler (`src/dropout-planner.js`), Demucs
`htdemucs` two-stem separation.

---

Made with 🎵 and a mild disregard for vocalists' job security.
