'use strict';

/**
 * VoiceIsolate Pro — Electron Preload (secure IPC bridge)
 *
 * REQUIRED security posture (Blueprint v2.1 §VIII):
 *   contextIsolation: true
 *   nodeIntegration: false
 *   sandbox: true
 *
 * Renderer receives only the whitelisted API below via contextBridge.
 */
const { contextBridge, ipcRenderer } = require('electron');
const { IPC } = require('./ipc-channels.cjs');

const vipDesktop = Object.freeze({
  /** @returns {Promise<'win32'|'darwin'|'linux'>} */
  platform: () => ipcRenderer.invoke(IPC.PLATFORM),

  /** @returns {Promise<string>} */
  getAppVersion: () => ipcRenderer.invoke(IPC.APP_VERSION),

  /**
   * Open native file picker for audio import.
   * @returns {Promise<{ canceled: boolean, filePath?: string, buffer?: ArrayBuffer }>}
   */
  openFile: () => ipcRenderer.invoke(IPC.OPEN_FILE),

  /**
   * Save processed audio via native dialog.
   * @param {{ defaultName: string, buffer: ArrayBuffer, filters?: { name: string, extensions: string[] }[] }} opts
   * @returns {Promise<{ canceled: boolean, filePath?: string }>}
   */
  saveFile: (opts) => ipcRenderer.invoke(IPC.SAVE_FILE, opts),

  /** @returns {Promise<string>} Absolute path to on-disk model cache directory. */
  getModelCachePath: () => ipcRenderer.invoke(IPC.MODEL_CACHE_PATH),

  /**
   * Read a cached model blob by relative filename.
   * @param {string} relativePath
   * @returns {Promise<ArrayBuffer|null>}
   */
  readModelCache: (relativePath) => ipcRenderer.invoke(IPC.READ_MODEL_CACHE, relativePath),

  /**
   * Write a model blob to the filesystem cache.
   * @param {{ relativePath: string, buffer: ArrayBuffer }} opts
   * @returns {Promise<{ ok: boolean, bytes: number }>}
   */
  writeModelCache: (opts) => ipcRenderer.invoke(IPC.WRITE_MODEL_CACHE, opts),

  /** @returns {Promise<{ ok: boolean, reason?: string, updateInfo?: string|null }>} */
  checkForUpdates: () => ipcRenderer.invoke(IPC.UPDATE_CHECK),

  /** @returns {Promise<{ ok: boolean, reason?: string }>} */
  downloadUpdate: () => ipcRenderer.invoke(IPC.UPDATE_DOWNLOAD),

  /** @returns {Promise<{ ok: boolean, reason?: string }>} */
  installUpdate: () => ipcRenderer.invoke(IPC.UPDATE_INSTALL),

  /**
   * Subscribe to auto-update status events from the main process.
   * @param {(status: object) => void} callback
   * @returns {() => void} unsubscribe
   */
  onUpdateStatus: (callback) => {
    const handler = (_evt, status) => callback(status);
    ipcRenderer.on(IPC.UPDATE_STATUS, handler);
    return () => ipcRenderer.removeListener(IPC.UPDATE_STATUS, handler);
  },

  /** Local SAM-Audio worker status (never exposes shell/python paths to UI logs). */
  samWorkerStatus: () => ipcRenderer.invoke(IPC.SAM_WORKER_STATUS),
  /** @param {{ port?: number }=} opts */
  samWorkerStart: (opts) => ipcRenderer.invoke(IPC.SAM_WORKER_START, opts || {}),
  samWorkerStop: () => ipcRenderer.invoke(IPC.SAM_WORKER_STOP),
  samWorkerCapabilities: () => ipcRenderer.invoke(IPC.SAM_WORKER_CAPABILITIES),
});

contextBridge.exposeInMainWorld('vipDesktop', vipDesktop);