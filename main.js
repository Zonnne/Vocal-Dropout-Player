'use strict';
const { app, BrowserWindow, ipcMain, dialog, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { parseLrc } = require('./src/lyrics');
const { findBackend, ensureBackend } = require('./src/backend');

function fileHash(filePath) {
  const st = fs.statSync(filePath);
  return crypto.createHash('sha1')
    .update(`${filePath}:${st.size}:${st.mtimeMs}`)
    .digest('hex')
    .slice(0, 16);
}

function findFileRecursive(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = findFileRecursive(p, name);
      if (hit) return hit;
    } else if (entry.name === name) {
      return p;
    }
  }
  return null;
}

function runDemucs(py, filePath, onProgress) {
  return new Promise((resolve, reject) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dropout-demucs-'));
    const args = ['-m', 'demucs', '--two-stems=vocals', '-o', tmpDir, filePath];
    const started = Date.now();
    const timer = setInterval(() => onProgress(Math.floor((Date.now() - started) / 1000)), 1000);
    const child = spawn(py, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderrTail = '';
    child.stderr.on('data', d => {
      stderrTail = (stderrTail + d.toString()).slice(-2000);
      onProgress(Math.floor((Date.now() - started) / 1000));
    });
    child.on('error', err => {
      clearInterval(timer);
      reject(err);
    });
    child.on('close', code => {
      clearInterval(timer);
      if (code !== 0) {
        return reject(new Error(`demucs exited with code ${code}: ${stderrTail.slice(-400)}`));
      }
      const vocals = findFileRecursive(tmpDir, 'vocals.wav');
      const noVocals = findFileRecursive(tmpDir, 'no_vocals.wav');
      if (!vocals || !noVocals) {
        return reject(new Error('demucs finished but stems were not found'));
      }
      resolve({ vocals, noVocals, tmpDir });
    });
  });
}

async function prepareStems(filePath, webContents) {
  const hash = fileHash(filePath);
  const dir = path.join(app.getPath('userData'), 'stems', hash);
  const vocals = path.join(dir, 'vocals.wav');
  const accompaniment = path.join(dir, 'accompaniment.wav');
  if (fs.existsSync(vocals) && fs.existsSync(accompaniment)) {
    upsertLibraryEntry(hash, filePath);
    return { vocals, accompaniment, hash, cached: true };
  }
  const py = await ensureBackend(app, prog => webContents.send('backend:progress', prog));
  const { vocals: v, noVocals, tmpDir } = await runDemucs(py, filePath, elapsed => {
    webContents.send('stems:progress', { elapsed });
  });
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(v, vocals);
  fs.copyFileSync(noVocals, accompaniment);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  upsertLibraryEntry(hash, filePath);
  return { vocals, accompaniment, hash, cached: false };
}

// ---------- Cached-song library (userData/library.json) ----------

function libraryPath() {
  return path.join(app.getPath('userData'), 'library.json');
}

function readLibrary() {
  try {
    const data = JSON.parse(fs.readFileSync(libraryPath(), 'utf8'));
    return Array.isArray(data.entries) ? data.entries : [];
  } catch (_) {
    return [];
  }
}

function writeLibrary(entries) {
  fs.writeFileSync(libraryPath(), JSON.stringify({ entries }, null, 2));
}

function stemsExist(hash) {
  const dir = path.join(app.getPath('userData'), 'stems', hash);
  return fs.existsSync(path.join(dir, 'vocals.wav')) &&
    fs.existsSync(path.join(dir, 'accompaniment.wav'));
}

function lyricsPath(hash) {
  return path.join(app.getPath('userData'), 'stems', hash, 'lyrics.json');
}

function validHash(hash) {
  return typeof hash === 'string' && /^[0-9a-f]{16}$/.test(hash);
}

function upsertLibraryEntry(hash, filePath) {
  const entries = readLibrary().filter(e => e.hash !== hash);
  entries.unshift({
    hash,
    name: path.basename(filePath),
    filePath,
    addedAt: Date.now(),
  });
  writeLibrary(entries);
}

function listLibrary() {
  return readLibrary()
    .filter(e => stemsExist(e.hash))
    .map(e => ({ ...e, hasLyrics: fs.existsSync(lyricsPath(e.hash)) }));
}

function removeLibraryEntry(hash) {
  if (!/^[0-9a-f]{16}$/.test(hash)) throw new Error('invalid hash');
  writeLibrary(readLibrary().filter(e => e.hash !== hash));
  fs.rmSync(path.join(app.getPath('userData'), 'stems', hash), { recursive: true, force: true });
}

function loadCachedStems(hash) {
  if (!/^[0-9a-f]{16}$/.test(hash)) throw new Error('invalid hash');
  const dir = path.join(app.getPath('userData'), 'stems', hash);
  const vocals = path.join(dir, 'vocals.wav');
  const accompaniment = path.join(dir, 'accompaniment.wav');
  if (!fs.existsSync(vocals) || !fs.existsSync(accompaniment)) {
    throw new Error('cached stems not found — they may have been deleted');
  }
  return { vocals, accompaniment, hash, cached: true };
}

// Resize the window so all content is visible without scrolling.
async function fitWindow(win) {
  if (!win || win.isDestroyed()) return;
  try {
    const [h, w] = await win.webContents.executeJavaScript(
      '[document.documentElement.scrollHeight, document.documentElement.scrollWidth]');
    const area = screen.getDisplayMatching(win.getBounds()).workAreaSize;
    win.setContentSize(
      Math.min(Math.max(w, 700), area.width),
      Math.min(Math.max(h + 4, 540), area.height));
  } catch (_) { /* window mid-navigation; ignore */ }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 860,
    height: 640,
    minWidth: 700,
    minHeight: 540,
    backgroundColor: '#121216',
    title: 'Vocal Dropout Player',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.on('did-finish-load', () => fitWindow(win));
}

app.whenReady().then(() => {
  // Track the audio-engine setup so late-opening windows get the current state.
  let backendState = findBackend(app)
    ? { ready: true, message: '' }
    : { ready: false, message: 'Setting up audio engine…' };

  const broadcast = prog => {
    backendState = { ready: prog.stage === 'done', message: prog.message };
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('backend:progress', prog);
  };

  ipcMain.handle('backend:status', () => backendState);
  ipcMain.handle('backend:ensure', e => {
    return ensureBackend(app, prog => { broadcast(prog); e.sender.send('backend:progress', prog); })
      .then(() => true);
  });

  // Start the one-time download in the background right at launch.
  if (!findBackend(app)) {
    ensureBackend(app, broadcast).catch(err => {
      backendState = { ready: false, message: `Audio engine setup failed: ${err.message}` };
      broadcast({ stage: 'error', message: backendState.message });
    });
  }

  ipcMain.handle('dialog:openFile', async () => {
    const res = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'flac', 'ogg', 'm4a'] }],
    });
    return res.canceled ? null : res.filePaths[0];
  });

  ipcMain.handle('stems:prepare', (e, filePath) => prepareStems(filePath, e.sender));

  ipcMain.handle('library:list', () => listLibrary());
  ipcMain.handle('library:remove', (e, hash) => { removeLibraryEntry(hash); return listLibrary(); });
  ipcMain.handle('stems:loadCached', (e, hash) => loadCachedStems(hash));
  ipcMain.handle('window:fit', e => fitWindow(BrowserWindow.fromWebContents(e.sender)));

  ipcMain.handle('lyrics:pick', async (e, hash) => {
    if (!validHash(hash)) throw new Error('invalid hash');
    const dir = path.join(app.getPath('userData'), 'stems', hash);
    if (!fs.existsSync(dir)) throw new Error('song is not in the cache');
    const res = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Lyrics', extensions: ['lrc', 'txt'] }],
    });
    if (res.canceled) return null;
    const parsed = parseLrc(fs.readFileSync(res.filePaths[0], 'utf8'));
    if (!parsed.lines.length) {
      throw new Error('no word-by-word timestamps found in that file');
    }
    fs.writeFileSync(lyricsPath(hash), JSON.stringify(parsed));
    return { name: path.basename(res.filePaths[0]), lineCount: parsed.lines.length };
  });

  ipcMain.handle('lyrics:get', (e, hash) => {
    if (!validHash(hash)) return null;
    try {
      return JSON.parse(fs.readFileSync(lyricsPath(hash), 'utf8'));
    } catch (_) {
      return null;
    }
  });

  ipcMain.handle('file:read', (e, p) => {
    const allowed = path.join(app.getPath('userData'), 'stems');
    const resolved = path.resolve(p);
    if (!resolved.startsWith(path.resolve(allowed))) {
      throw new Error('read outside stem cache is not allowed');
    }
    return fs.readFileSync(resolved);
  });

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
