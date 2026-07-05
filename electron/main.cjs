'use strict';

/**
 * VoiceIsolate Pro — Electron Main Process
 * Master Blueprint v2.1 §VIII — hardened BrowserWindow configuration.
 */
const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
} = require('electron');
const path = require('path');
const fs = require('fs/promises');
const { IPC } = require('./ipc-channels.cjs');

const ROOT = path.join(__dirname, '..');
const isDev = process.env.VIP_ELECTRON_DEV === '1' || !app.isPackaged;
const DEV_URL = process.env.VIP_DEV_URL || 'http://localhost:3000';

/** @type {BrowserWindow | null} */
let mainWindow = null;

function modelCacheDir() {
  return path.join(app.getPath('userData'), 'models');
}

async function ensureModelCacheDir() {
  const dir = modelCacheDir();
  await fs.mkdir(dir, { recursive: true });
  return dir;
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
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev) {
    mainWindow.loadURL(DEV_URL);
    if (process.env.VIP_ELECTRON_DEVTOOLS === '1') {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
  } else {
    mainWindow.loadFile(path.join(ROOT, 'build', 'index.html'));
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
      title: 'Import Audio',
      properties: ['openFile'],
      filters: [
        { name: 'Audio', extensions: ['wav', 'mp3', 'flac', 'ogg', 'm4a', 'aac', 'webm'] },
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
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});