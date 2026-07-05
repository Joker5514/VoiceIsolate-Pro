/**
 * VoiceIsolate Pro — Desktop Bridge (Layer 1: Core)
 *
 * Thin adapter over Electron preload API (`window.vipDesktop`). No Node access,
 * no DOM manipulation — only detects the shell and marshals IPC payloads.
 *
 * Used by FileIngestion (import) and ExportControls (export) when running
 * inside the Electron renderer.
 */
'use strict';

/**
 * @returns {boolean} true when the secure Electron preload bridge is present
 */
export function isDesktopShell() {
  return typeof globalThis !== 'undefined'
    && globalThis.vipDesktop != null
    && typeof globalThis.vipDesktop.openFile === 'function';
}

/**
 * @returns {Promise<'win32'|'darwin'|'linux'|null>}
 */
export async function getDesktopPlatform() {
  if (!isDesktopShell()) return null;
  return globalThis.vipDesktop.platform();
}

/**
 * Open the native file picker and return a browser File object.
 * @returns {Promise<File|null>} null when canceled or unavailable
 */
export async function pickAudioFile() {
  if (!isDesktopShell()) return null;

  const result = await globalThis.vipDesktop.openFile();
  if (!result || result.canceled || !result.buffer) return null;

  const name = basenameFromPath(result.filePath) || 'import';
  const mime = mimeFromFilename(name);
  return new File([result.buffer], name, { type: mime });
}

/**
 * Save a blob via the native save dialog (Electron main process).
 * @param {Blob} blob
 * @param {object} opts
 * @param {string} opts.defaultName
 * @param {{ name: string, extensions: string[] }[]} [opts.filters]
 * @returns {Promise<{ canceled: boolean, filePath?: string }>}
 */
export async function saveExportBlob(blob, opts) {
  if (!isDesktopShell()) {
    return { canceled: true };
  }
  if (!blob || typeof blob.arrayBuffer !== 'function') {
    throw new TypeError('[VIP][DesktopBridge] saveExportBlob expects a Blob.');
  }
  const defaultName = opts?.defaultName || 'voiceisolate-export.wav';
  const buffer = await blob.arrayBuffer();
  return globalThis.vipDesktop.saveFile({
    defaultName,
    buffer,
    filters: opts?.filters,
  });
}

/**
 * Build save-dialog filters from a filename extension.
 * @param {string} filename
 * @returns {{ name: string, extensions: string[] }[]}
 */
export function filtersForFilename(filename) {
  const ext = (filename.split('.').pop() || 'wav').toLowerCase();
  if (ext === 'mp3') {
    return [{ name: 'MP3 Audio', extensions: ['mp3'] }];
  }
  return [{ name: 'WAV Audio', extensions: ['wav'] }];
}

/**
 * @param {string} [filePath]
 * @returns {string}
 */
function basenameFromPath(filePath) {
  if (!filePath || typeof filePath !== 'string') return '';
  const parts = filePath.split(/[/\\]/);
  return parts[parts.length - 1] || '';
}

/**
 * @param {string} name
 * @returns {string}
 */
function mimeFromFilename(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  const map = {
    wav: 'audio/wav',
    mp3: 'audio/mpeg',
    flac: 'audio/flac',
    ogg: 'audio/ogg',
    m4a: 'audio/mp4',
    aac: 'audio/aac',
    webm: 'audio/webm',
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    mkv: 'video/x-matroska',
  };
  return map[ext] || '';
}