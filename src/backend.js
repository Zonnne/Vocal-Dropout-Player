'use strict';
/**
 * Backend manager — the demucs separation engine.
 *
 * Resolution order:
 *  1. dev venv at ../../work/demucs-venv (relative to the app root) — used
 *     during development, absent in the packaged app
 *  2. downloaded runtime in <userData>/backend (standalone CPython + venv
 *     with demucs), installed on first run by ensureBackend()
 *
 * ensureBackend() downloads python-build-standalone (~50MB), creates a venv
 * and pip-installs demucs (large one-time download, pulls PyTorch). Progress
 * is reported via onProgress({ stage, message, percent? }).
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');

const PYTHON_URLS = {
  'darwin-arm64': 'https://github.com/astral-sh/python-build-standalone/releases/download/20260718/cpython-3.12.13%2B20260718-aarch64-apple-darwin-install_only.tar.gz',
  'darwin-x64': 'https://github.com/astral-sh/python-build-standalone/releases/download/20260718/cpython-3.12.13%2B20260718-x86_64-apple-darwin-install_only.tar.gz',
  'win32-x64': 'https://github.com/astral-sh/python-build-standalone/releases/download/20260718/cpython-3.12.13%2B20260718-x86_64-pc-windows-msvc-install_only.tar.gz',
};
// demucs 4.1.0 fails to declare numpy and pip alone gives you a broken
// install (ModuleNotFoundError: numpy on `demucs -h`), so pin it explicitly.
// Verified in a clean venv: numpy is the ONLY missing piece — mp3 decode
// works via sphn, no torchaudio needed.
const DEMUCS_PIN = ['demucs==4.1.0', 'numpy'];

function backendDir(app) {
  return path.join(app.getPath('userData'), 'backend');
}

function downloadedPython(app) {
  // venv layout differs on Windows (Scripts/ instead of bin/)
  return process.platform === 'win32'
    ? path.join(backendDir(app), 'venv', 'Scripts', 'python.exe')
    : path.join(backendDir(app), 'venv', 'bin', 'python');
}

function devPython() {
  // src/backend.js is one level deeper than main.js: app root is ../..
  return path.resolve(__dirname, '..', '..', '..', 'work', 'demucs-venv', 'bin', 'python');
}

/** Path to a working python-with-demucs, or null if not installed yet. */
function findBackend(app) {
  if (fs.existsSync(devPython())) return devPython();
  const py = downloadedPython(app);
  if (fs.existsSync(py) && fs.existsSync(path.join(backendDir(app), 'OK'))) return py;
  return null;
}

function downloadOnce(url, dest, onPercent) {
  return new Promise((resolve, reject) => {
    const follow = (u, redirects) => {
      if (redirects > 5) return reject(new Error('too many redirects'));
      https.get(u, { headers: { 'User-Agent': 'vocal-dropout-player' } }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return follow(res.headers.location, redirects + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`download failed: HTTP ${res.statusCode}`));
        }
        const total = Number(res.headers['content-length'] || 0);
        let got = 0;
        const out = fs.createWriteStream(dest);
        res.on('data', chunk => {
          got += chunk.length;
          if (total > 0) onPercent(got / total);
        });
        res.pipe(out);
        out.on('finish', () => out.close(resolve));
        out.on('error', reject);
        res.on('error', reject);
      }).on('error', reject);
    };
    follow(url, 0);
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Download with retries — this connection path has proven flaky. */
async function download(url, dest, onPercent, attempts = 4) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await downloadOnce(url, dest, onPercent);
    } catch (err) {
      lastErr = err;
      fs.rmSync(dest, { force: true }); // don't keep a truncated file
      if (i < attempts) await sleep(2000 * i);
    }
  }
  throw lastErr;
}

function run(cmd, args, onLine) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    const onData = d => {
      tail = (tail + d.toString()).slice(-2000);
      const line = d.toString().trim().split(/\r?\n|\r/).filter(Boolean).pop();
      if (line && onLine) onLine(line.slice(0, 100));
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', reject);
    child.on('close', code => {
      code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} exited with code ${code}: ${tail.slice(-300)}`));
    });
  });
}

let inflight = null; // memoized bootstrap promise

function ensureBackend(app, onProgress = () => {}) {
  const ready = findBackend(app);
  if (ready) return Promise.resolve(ready);
  if (inflight) return inflight;

  const url = PYTHON_URLS[`${process.platform}-${process.arch}`];
  if (!url) return Promise.reject(new Error(`no python runtime available for ${process.platform}-${process.arch}`));
  const dir = backendDir(app);
  const tarball = path.join(dir, 'python.tar.gz');
  // python-build-standalone layout: unix has bin/python3, windows has python.exe at root
  const runtimePython = process.platform === 'win32'
    ? path.join(dir, 'python', 'python.exe')
    : path.join(dir, 'python', 'bin', 'python3');
  const venvPy = downloadedPython(app);

  inflight = (async () => {
    fs.rmSync(dir, { recursive: true, force: true }); // clear any partial install
    fs.mkdirSync(dir, { recursive: true });
    try {
      onProgress({ stage: 'python', message: 'Downloading Python runtime… 0%' });
      await download(url, tarball, p => onProgress({
        stage: 'python', percent: p,
        message: `Downloading Python runtime… ${Math.round(p * 100)}%`,
      }));

      onProgress({ stage: 'extract', message: 'Extracting Python runtime…' });
      await run('tar', ['-xzf', tarball, '-C', dir]);
      fs.rmSync(tarball, { force: true });

      onProgress({ stage: 'venv', message: 'Creating Python environment…' });
      await run(runtimePython, ['-m', 'venv', path.join(dir, 'venv')]);

      onProgress({ stage: 'demucs', message: 'Installing Demucs (large one-time download)…' });
      // `python -m pip` instead of the pip script — portable across unix/windows venv layouts
      await run(venvPy, ['-m', 'pip', 'install', '--upgrade', 'pip']);
      await run(venvPy, ['-m', 'pip', 'install', ...DEMUCS_PIN], line => onProgress({
        stage: 'demucs',
        message: `Installing Demucs (one-time)… ${line}`,
      }));

      onProgress({ stage: 'verify', message: 'Verifying installation…' });
      await run(venvPy, ['-m', 'demucs', '-h']);
      fs.writeFileSync(path.join(dir, 'OK'), new Date().toISOString());
      onProgress({ stage: 'done', message: 'Audio engine ready ✓' });
      return venvPy;
    } catch (err) {
      fs.rmSync(dir, { recursive: true, force: true }); // don't keep a broken install
      inflight = null; // allow retry on next attempt
      throw err;
    }
  })();
  return inflight;
}

module.exports = { findBackend, ensureBackend, download };
