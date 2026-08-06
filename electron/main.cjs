'use strict';

/**
 * VoiceIsolate Pro — Electron Main Process
 * Master Blueprint v2.1 §VIII — hardened BrowserWindow + 100% offline packaged mode.
 *
 * Packaged apps serve the static build via the vip:// protocol (not file://) so
 * absolute paths like /app/models/*.onnx and /src/workers/*.js resolve locally
 * with COOP/COEP for SharedArrayBuffer — no network required for isolation.
 */
const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  protocol,
  net,
} = require('electron');
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const { pathToFileURL } = require('url');
const { spawn } = require('child_process');
const http = require('http');
const { autoUpdater } = require('electron-updater');
const { IPC } = require('./ipc-channels.cjs');

const ROOT = path.join(__dirname, '..');
const isDev = process.env.VIP_ELECTRON_DEV === '1' || !app.isPackaged;
const DEV_URL = process.env.VIP_DEV_URL || 'http://localhost:3000';

/** @type {import('child_process').ChildProcess|null} */
let samWorkerProc = null;
let samWorkerPort = Number(process.env.SAM_AUDIO_PORT || 8765) || 8765;

/** Essential ONNX assets for offline isolation (DEFAULT_ML_CHAIN + common fallbacks). */
const OFFLINE_MODELS = Object.freeze([
  {
    file: 'bsrnn_vocals.onnx',
    cacheKey: 'bsrnn_vocals:7edd7c51962e21086841b6c65ec1304deed75555e1bb05d64ec7c134a39c8141',
  },
  {
    file: 'rnnoise_suppressor.onnx',
    cacheKey: 'rnnoise:0bc4319f433f9b19411cbc1727f0b6eab83b3ccb89825d8229cbb28ccc3b62b6',
  },
  {
    file: 'silero_vad.onnx',
    cacheKey: 'vad:1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3',
  },
  {
    file: 'silero_vad_int8.onnx',
    cacheKey: 'vad_int8:16748abf8870b6e380fb3c56b662e2fd565504d28c30e6159a27017a569c8b05',
  },
]);

/** @type {BrowserWindow | null} */
let mainWindow = null;

// Must run before app is ready — privileges for fetch/Worker/wasm under vip://
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'vip',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
      bypassCSP: false,
    },
  },
]);

autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;

function sendUpdateStatus(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC.UPDATE_STATUS, payload);
  }
}

function setupAutoUpdater() {
  autoUpdater.on('checking-for-update', () => {
    sendUpdateStatus({ state: 'checking' });
  });
  autoUpdater.on('update-available', (info) => {
    sendUpdateStatus({ state: 'available', version: info.version, releaseNotes: info.releaseNotes });
  });
  autoUpdater.on('update-not-available', (info) => {
    sendUpdateStatus({ state: 'not-available', version: info.version });
  });
  autoUpdater.on('error', (err) => {
    sendUpdateStatus({ state: 'error', message: err?.message || String(err) });
  });
  autoUpdater.on('download-progress', (progress) => {
    sendUpdateStatus({
      state: 'downloading',
      percent: progress.percent,
      transferred: progress.transferred,
      total: progress.total,
    });
  });
  autoUpdater.on('update-downloaded', (info) => {
    sendUpdateStatus({ state: 'downloaded', version: info.version });
  });
}

/** Root of the static web build (public/ + src/ copy). */
function getStaticRoot() {
  if (app.isPackaged) {
    return path.join(app.getAppPath(), 'build');
  }
  return path.join(ROOT, 'build');
}

function modelCacheDir() {
  return path.join(app.getPath('userData'), 'models');
}

async function ensureModelCacheDir() {
  const dir = modelCacheDir();
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Copy bundled ONNX weights into {userData}/models so MLWorker desktop cache
 * hits disk without any network fetch (even if vip:// path resolution differs).
 */
async function seedBundledModels() {
  const modelsSrc = path.join(getStaticRoot(), 'app', 'models');
  if (!fsSync.existsSync(modelsSrc)) {
    console.warn('[electron] Bundled models folder missing:', modelsSrc);
    return { seeded: 0, skipped: 0 };
  }
  const cacheDir = await ensureModelCacheDir();
  let seeded = 0;
  let skipped = 0;
  for (const entry of OFFLINE_MODELS) {
    const src = path.join(modelsSrc, entry.file);
    if (!fsSync.existsSync(src)) {
      console.warn('[electron] Offline model not bundled:', entry.file);
      continue;
    }
    const safe = entry.cacheKey.replace(/[^a-zA-Z0-9._-]/g, '_');
    const dest = path.join(cacheDir, `${safe}.onnx`);
    try {
      if (fsSync.existsSync(dest) && fsSync.statSync(dest).size > 0) {
        skipped += 1;
        continue;
      }
      await fs.copyFile(src, dest);
      seeded += 1;
    } catch (err) {
      console.warn('[electron] Failed to seed model', entry.file, err?.message || err);
    }
  }
  console.info(`[electron] Offline models: seeded=${seeded} skipped=${skipped}`);
  return { seeded, skipped };
}

/**
 * Resolve a vip:// URL to a path under the static root.
 * vip://app/index.html → build/index.html
 * vip://app/app/models/x.onnx → build/app/models/x.onnx
 */
function resolveVipPath(requestUrl) {
  let u;
  try {
    u = new URL(requestUrl);
  } catch {
    return null;
  }
  if (u.protocol !== 'vip:') return null;
  let pathname = decodeURIComponent(u.pathname || '/');
  // hostname is "app" for vip://app/...
  if (pathname.startsWith('/')) pathname = pathname.slice(1);
  if (!pathname || pathname.endsWith('/')) pathname = `${pathname}index.html`;
  const root = path.resolve(getStaticRoot());
  const full = path.resolve(path.join(root, pathname));
  if (!full.startsWith(root + path.sep) && full !== root) {
    return null;
  }
  return full;
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.wasm': 'application/wasm',
    '.onnx': 'application/octet-stream',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.woff2': 'font/woff2',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.mp4': 'video/mp4',
  };
  return map[ext] || 'application/octet-stream';
}

function registerVipProtocol() {
  protocol.handle('vip', async (request) => {
    const filePath = resolveVipPath(request.url);
    if (!filePath) {
      return new Response('Not found', { status: 404 });
    }
    try {
      await fs.access(filePath);
    } catch {
      return new Response(`Not found: ${request.url}`, { status: 404 });
    }
    // Use net.fetch(file://) for range/stream support on large ONNX files.
    const fileUrl = pathToFileURL(filePath).href;
    const res = await net.fetch(fileUrl, { method: request.method });
    const headers = new Headers(res.headers);
    headers.set('Content-Type', contentTypeFor(filePath));
    // COOP/COEP required for SharedArrayBuffer (worklets / OLA).
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
    headers.set('Cross-Origin-Resource-Policy', 'same-origin');
    headers.set('X-Content-Type-Options', 'nosniff');
    // Cache models/wasm aggressively offline; keep HTML/JS fresher for updates.
    if (/\.(onnx|wasm)$/i.test(filePath)) {
      headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    } else {
      headers.set('Cache-Control', 'no-cache');
    }
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs'),
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // Keep users offline-capable: only open external when online & user-initiated.
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev) {
    mainWindow.loadURL(DEV_URL);
    if (process.env.VIP_ELECTRON_DEVTOOLS === '1') {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
  } else {
    // vip:// — not file:// — so absolute app paths and fetch() work offline.
    mainWindow.loadURL('vip://app/index.html');
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function registerIpc() {
  ipcMain.handle(IPC.PLATFORM, () => process.platform);
  ipcMain.handle(IPC.APP_VERSION, () => app.getVersion());

  ipcMain.handle(IPC.OPEN_FILE, async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: 'Import Audio or Video',
      properties: ['openFile'],
      filters: [
        {
          name: 'Audio & Video',
          extensions: [
            'wav', 'wave', 'mp3', 'flac', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'webm', 'weba',
            'aiff', 'aif', 'caf', 'wma', 'mka', 'm4b', 'm4r', 'amr', 'ac3', 'eac3',
            'mp4', 'm4v', 'mov', 'mkv', 'avi', 'ogv', '3gp', '3g2', 'wmv', 'mpeg', 'mpg',
            'ts', 'm2ts', 'mts', 'flv', 'f4v', 'asf',
          ],
        },
        {
          name: 'Video',
          extensions: [
            'mp4', 'm4v', 'mov', 'mkv', 'avi', 'ogv', '3gp', '3g2', 'wmv', 'mpeg', 'mpg',
            'webm', 'ts', 'm2ts', 'mts', 'flv', 'f4v', 'asf',
          ],
        },
        {
          name: 'Audio',
          extensions: [
            'wav', 'wave', 'mp3', 'flac', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'webm', 'weba',
            'aiff', 'aif', 'caf', 'wma', 'mka', 'm4b', 'm4r', 'amr', 'ac3', 'eac3',
          ],
        },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (canceled || filePaths.length === 0) {
      return { canceled: true };
    }
    const filePath = filePaths[0];
    const data = await fs.readFile(filePath);
    return {
      canceled: false,
      filePath,
      buffer: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
    };
  });

  ipcMain.handle(IPC.SAVE_FILE, async (_evt, opts) => {
    const defaultName = (opts && opts.defaultName) || 'voiceisolate-export.wav';
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Export Audio',
      defaultPath: defaultName,
      filters: (opts && opts.filters) || [
        { name: 'WAV', extensions: ['wav'] },
        { name: 'MP3', extensions: ['mp3'] },
      ],
    });
    if (canceled || !filePath) return { canceled: true };

    const buffer = Buffer.from(opts.buffer);
    await fs.writeFile(filePath, buffer);
    return { canceled: false, filePath };
  });

  ipcMain.handle(IPC.MODEL_CACHE_PATH, async () => ensureModelCacheDir());

  ipcMain.handle(IPC.READ_MODEL_CACHE, async (_evt, relativePath) => {
    if (!relativePath || relativePath.includes('..')) return null;
    const full = path.join(await ensureModelCacheDir(), relativePath);
    try {
      const data = await fs.readFile(full);
      return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    } catch {
      return null;
    }
  });

  ipcMain.handle(IPC.WRITE_MODEL_CACHE, async (_evt, opts) => {
    const rel = opts && opts.relativePath;
    if (!rel || rel.includes('..')) return { ok: false, bytes: 0 };
    const dir = await ensureModelCacheDir();
    const full = path.join(dir, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    const buf = Buffer.from(opts.buffer);
    await fs.writeFile(full, buf);
    return { ok: true, bytes: buf.byteLength };
  });

  ipcMain.handle(IPC.UPDATE_CHECK, async () => {
    if (!app.isPackaged) {
      return { ok: false, reason: 'dev' };
    }
    if (!net.isOnline()) {
      return { ok: false, reason: 'offline' };
    }
    const result = await autoUpdater.checkForUpdates();
    return { ok: true, updateInfo: result?.updateInfo?.version || null };
  });

  ipcMain.handle(IPC.UPDATE_DOWNLOAD, async () => {
    if (!app.isPackaged) return { ok: false, reason: 'dev' };
    if (!net.isOnline()) return { ok: false, reason: 'offline' };
    await autoUpdater.downloadUpdate();
    return { ok: true };
  });

  ipcMain.handle(IPC.UPDATE_INSTALL, () => {
    if (!app.isPackaged) return { ok: false, reason: 'dev' };
    autoUpdater.quitAndInstall();
    return { ok: true };
  });

  // ── Local SAM-Audio worker (Option B) ───────────────────────────────────
  ipcMain.handle(IPC.SAM_WORKER_STATUS, async () => {
    const running = !!(samWorkerProc && !samWorkerProc.killed);
    const baseUrl = `http://127.0.0.1:${samWorkerPort}`;
    let healthy = false;
    if (running) {
      healthy = await probeSamHealth(baseUrl);
    }
    return {
      running,
      healthy,
      baseUrl,
      port: samWorkerPort,
      mode: process.env.SAM_AUDIO_MODE || 'local-worker',
      browserSam: false,
    };
  });

  ipcMain.handle(IPC.SAM_WORKER_START, async (_evt, opts) => {
    const port = Number(opts?.port || process.env.SAM_AUDIO_PORT || 8765) || 8765;
    if (samWorkerProc && !samWorkerProc.killed) {
      return { ok: true, already: true, baseUrl: `http://127.0.0.1:${samWorkerPort}` };
    }
    const script = resolveSamWorkerScript();
    if (!script || !fsSync.existsSync(script)) {
      return { ok: false, reason: 'worker-script-missing', tried: script };
    }
    const python = resolveSamPython();
    try {
      samWorkerPort = port;
      samWorkerProc = spawn(
        python,
        [script, '--host', '127.0.0.1', '--port', String(port)],
        {
          cwd: path.dirname(script),
          env: {
            ...process.env,
            SAM_AUDIO_MODE: process.env.SAM_AUDIO_MODE || 'local-worker',
            SAM_AUDIO_HOST: '127.0.0.1',
            SAM_AUDIO_PORT: String(port),
            SAM_AUDIO_MODEL: process.env.SAM_AUDIO_MODEL || 'facebook/sam-audio-small',
          },
          stdio: ['ignore', 'ignore', 'pipe'],
          windowsHide: true,
        },
      );
      samWorkerProc.on('exit', () => {
        samWorkerProc = null;
      });
      samWorkerProc.stderr?.on('data', (buf) => {
        // Avoid logging potential secrets; only short process noise.
        const line = String(buf).trim().slice(0, 200);
        if (line) console.info('[electron][sam-worker]', line);
      });
      // Brief wait for listen
      await new Promise((r) => setTimeout(r, 400));
      const baseUrl = `http://127.0.0.1:${port}`;
      const healthy = await probeSamHealth(baseUrl);
      return { ok: true, baseUrl, healthy };
    } catch (err) {
      samWorkerProc = null;
      return { ok: false, reason: err?.message || 'spawn-failed' };
    }
  });

  ipcMain.handle(IPC.SAM_WORKER_STOP, async () => {
    if (samWorkerProc && !samWorkerProc.killed) {
      try {
        samWorkerProc.kill();
      } catch { /* ignore */ }
      samWorkerProc = null;
    }
    return { ok: true };
  });

  ipcMain.handle(IPC.SAM_WORKER_CAPABILITIES, async () => {
    const baseUrl = `http://127.0.0.1:${samWorkerPort}`;
    try {
      const body = await httpGetJson(`${baseUrl}/capabilities`);
      return { ok: true, capabilities: body, baseUrl };
    } catch (err) {
      return { ok: false, reason: err?.message || 'unreachable', baseUrl };
    }
  });
}

/** Packaged Electron: process.resourcesPath/sam-audio; dev: repo services/sam-audio */
function resolveSamWorkerScript() {
  const candidates = [
    process.env.SAM_AUDIO_WORKER_SCRIPT,
    path.join(process.resourcesPath || '', 'sam-audio', 'server.py'),
    path.join(ROOT, 'services', 'sam-audio', 'server.py'),
    path.join(ROOT, 'build', 'sam-audio', 'server.py'),
  ].filter(Boolean);
  for (const c of candidates) {
    if (fsSync.existsSync(c)) return c;
  }
  return candidates[candidates.length - 1] || null;
}

function resolveSamPython() {
  if (process.env.SAM_AUDIO_PYTHON) return process.env.SAM_AUDIO_PYTHON;
  if (process.env.PYTHON) return process.env.PYTHON;
  const pointers = [
    path.join(process.resourcesPath || '', 'sam-audio', '.python-path'),
    path.join(ROOT, 'services', 'sam-audio', '.python-path'),
    path.join(ROOT, '.venv-sam', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
  ];
  for (const p of pointers) {
    try {
      if (p.endsWith('python') || p.endsWith('python.exe')) {
        if (fsSync.existsSync(p)) return p;
      } else if (fsSync.existsSync(p)) {
        const line = fsSync.readFileSync(p, 'utf8').trim();
        if (line && fsSync.existsSync(line)) return line;
      }
    } catch { /* continue */ }
  }
  return process.platform === 'win32' ? 'python' : 'python3';
}

function probeSamHealth(baseUrl) {
  return httpGetJson(`${baseUrl}/health`)
    .then((b) => !!b.ok)
    .catch(() => false);
}

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 2000 }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
  });
}

app.whenReady().then(async () => {
  registerVipProtocol();
  setupAutoUpdater();
  registerIpc();

  // Seed filesystem model cache before UI loads so offline ML never waits on fetch.
  try {
    await seedBundledModels();
  } catch (err) {
    console.warn('[electron] Model seed failed (non-fatal):', err?.message || err);
  }

  createWindow();

  // Auto-update is optional — never blocks offline use.
  if (
    app.isPackaged
    && process.env.VIP_SKIP_AUTO_UPDATE !== '1'
    && net.isOnline()
  ) {
    autoUpdater.checkForUpdates().catch((err) => {
      console.warn('[electron] Auto-update check failed:', err?.message || err);
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (samWorkerProc && !samWorkerProc.killed) {
    try { samWorkerProc.kill(); } catch { /* ignore */ }
    samWorkerProc = null;
  }
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (samWorkerProc && !samWorkerProc.killed) {
    try { samWorkerProc.kill(); } catch { /* ignore */ }
    samWorkerProc = null;
  }
});
