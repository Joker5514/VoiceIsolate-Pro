/**
 * VoiceIsolate Pro — Google Drive bridge (user-initiated file I/O only)
 *
 * Import/export audio files via Drive API v3 using a Google OAuth access token
 * (typically from Firebase GoogleAuthProvider with drive.file scope).
 *
 * NEVER called from AudioWorklet, MLWorker, or Process. Processing stays local.
 */
'use strict';

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const APP_FOLDER_NAME = 'VoiceIsolate Pro';
const PICKER_SCRIPT = 'https://apis.google.com/js/api.js';

/** @type {string|null} */
let _accessToken = null;
/** @type {string|null} */
let _appFolderId = null;
/** @type {Promise<void>|null} */
let _pickerLoader = null;

/**
 * @returns {{ apiKey: string|null, clientId: string|null, appId: string|null }}
 */
export function getDriveConfig() {
  const g = typeof globalThis !== 'undefined' ? globalThis : {};
  const apiKey = g.GOOGLE_API_KEY
    || g.FIREBASE_API_KEY
    || (typeof g.firebaseConfig === 'object' && g.firebaseConfig?.apiKey)
    || null;
  const oauthClientId = g.GOOGLE_OAUTH_CLIENT_ID || g.GOOGLE_CLIENT_ID || null;
  const appId = g.GOOGLE_APP_ID || g.FIREBASE_APP_ID || null;
  return {
    apiKey: apiKey && String(apiKey) !== 'YOUR_API_KEY' ? String(apiKey) : null,
    clientId: oauthClientId && !String(oauthClientId).includes('YOUR_') ? String(oauthClientId) : null,
    appId: appId && !String(appId).includes('YOUR_') ? String(appId) : null,
  };
}

export function isDriveConfigured() {
  const { apiKey } = getDriveConfig();
  // Picker needs API key; upload/download need access token (from Firebase).
  // Allow auth-only path when Firebase is configured even if Picker key missing
  // (import will fail until key is set; export can still work).
  const g = typeof globalThis !== 'undefined' ? globalThis : {};
  const firebaseReady = Boolean(
    g.FIREBASE_API_KEY && String(g.FIREBASE_API_KEY) !== 'YOUR_API_KEY',
  );
  return Boolean(apiKey || firebaseReady);
}

export function getDriveScope() {
  return DRIVE_SCOPE;
}

export function setAccessToken(token) {
  _accessToken = token ? String(token) : null;
}

export function getAccessToken() {
  return _accessToken;
}

export function clearDriveSession() {
  _accessToken = null;
  _appFolderId = null;
}

/**
 * Ensure we have a Google OAuth access token with Drive scope.
 * Prefers injected auth hook (Firebase), else uses cached token.
 * @param {{ force?: boolean, signIn?: () => Promise<{ accessToken?: string }> }} [opts]
 */
async function resolveDriveSignIn(explicit) {
  if (typeof explicit === 'function') return explicit;
  if (typeof globalThis !== 'undefined' && typeof globalThis.__vipSignInGoogleDrive === 'function') {
    return globalThis.__vipSignInGoogleDrive;
  }
  // Lazy-load Firebase Google Auth + Drive scopes (never from workers).
  try {
    await import('/app/firebase-config.js');
  } catch {
    try {
      await import('../../public/app/firebase-config.js');
    } catch { /* ignore */ }
  }
  if (typeof globalThis !== 'undefined' && typeof globalThis.__vipSignInGoogleDrive === 'function') {
    return globalThis.__vipSignInGoogleDrive;
  }
  return null;
}

export async function ensureGoogleDriveAuth(opts = {}) {
  if (!opts.force && _accessToken) return _accessToken;
  if (!opts.force && typeof globalThis !== 'undefined' && globalThis.__vipGoogleDriveAccessToken) {
    _accessToken = String(globalThis.__vipGoogleDriveAccessToken);
    return _accessToken;
  }
  const signIn = await resolveDriveSignIn(opts.signIn);
  if (!signIn) {
    throw new Error(
      'Google Drive sign-in is not available. Configure Firebase Google Auth with Drive scope.',
    );
  }
  const result = await signIn();
  const token = result?.accessToken || result?.credential?.accessToken || null;
  if (!token) {
    throw new Error('Google Drive sign-in did not return an access token. Re-consent Drive permission.');
  }
  setAccessToken(token);
  return token;
}

/**
 * @param {string} accessToken
 * @param {string} path
 * @param {RequestInit} [init]
 */
async function driveFetch(accessToken, path, init = {}) {
  const url = path.startsWith('http') ? path : `${DRIVE_API}${path}`;
  const headers = new Headers(init.headers || {});
  headers.set('Authorization', `Bearer ${accessToken}`);
  const res = await fetch(url, { ...init, headers });
  if (res.status === 401 || res.status === 403) {
    const err = new Error(`Google Drive auth failed (HTTP ${res.status}). Sign in again.`);
    err.code = 'DRIVE_AUTH';
    err.status = res.status;
    throw err;
  }
  if (!res.ok) {
    let detail = '';
    try { detail = await res.text(); } catch { /* ignore */ }
    throw new Error(`Google Drive request failed (HTTP ${res.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }
  return res;
}

/**
 * Find or create the app folder in the user's Drive (drive.file scope).
 * @param {string} accessToken
 */
export async function ensureAppFolder(accessToken) {
  if (_appFolderId) return _appFolderId;
  const q = encodeURIComponent(
    `name='${APP_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
  );
  const list = await driveFetch(
    accessToken,
    `/files?q=${q}&spaces=drive&fields=files(id,name)&pageSize=1`,
  );
  const data = await list.json();
  if (data.files?.[0]?.id) {
    _appFolderId = data.files[0].id;
    return _appFolderId;
  }
  const created = await driveFetch(accessToken, '/files?fields=id,name,webViewLink', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: APP_FOLDER_NAME,
      mimeType: 'application/vnd.google-apps.folder',
    }),
  });
  const folder = await created.json();
  _appFolderId = folder.id;
  return _appFolderId;
}

/**
 * Upload a Blob to Drive (multipart).
 * @param {object} opts
 * @param {string} opts.accessToken
 * @param {Blob} opts.blob
 * @param {string} opts.filename
 * @param {string} [opts.mimeType]
 * @param {string} [opts.parentId]
 */
export async function uploadDriveFile({
  accessToken,
  blob,
  filename,
  mimeType = 'application/octet-stream',
  parentId = null,
}) {
  if (!accessToken) throw new Error('Missing Google Drive access token');
  if (!(blob instanceof Blob)) throw new TypeError('uploadDriveFile expects a Blob');
  const name = String(filename || 'voiceisolate-export').slice(0, 180);
  const parent = parentId || await ensureAppFolder(accessToken);
  const metadata = {
    name,
    parents: parent ? [parent] : undefined,
  };
  const boundary = `vip_boundary_${Date.now().toString(36)}`;
  const metaPart = JSON.stringify(metadata);
  const preamble = [
    `--${boundary}\r\n`,
    'Content-Type: application/json; charset=UTF-8\r\n\r\n',
    `${metaPart}\r\n`,
    `--${boundary}\r\n`,
    `Content-Type: ${mimeType}\r\n\r\n`,
  ].join('');
  const closing = `\r\n--${boundary}--`;
  const body = new Blob([preamble, blob, closing], { type: `multipart/related; boundary=${boundary}` });

  const res = await driveFetch(
    accessToken,
    `${DRIVE_UPLOAD}?uploadType=multipart&fields=id,name,webViewLink,mimeType,size`,
    {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body,
    },
  );
  return res.json();
}

/**
 * Download file bytes from Drive.
 * @param {{ accessToken: string, fileId: string }} opts
 * @returns {Promise<Blob>}
 */
export async function downloadDriveFile({ accessToken, fileId }) {
  if (!accessToken) throw new Error('Missing Google Drive access token');
  if (!fileId) throw new Error('Missing Google Drive file id');
  const metaRes = await driveFetch(
    accessToken,
    `/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,size`,
  );
  const meta = await metaRes.json();
  const res = await driveFetch(
    accessToken,
    `/files/${encodeURIComponent(fileId)}?alt=media`,
  );
  const buf = await res.arrayBuffer();
  const mime = meta.mimeType || 'application/octet-stream';
  const blob = new Blob([buf], { type: mime });
  blob.__vipDriveName = meta.name || 'drive-file';
  blob.__vipDriveId = meta.id;
  return blob;
}

function loadPickerApi() {
  if (typeof globalThis === 'undefined') {
    return Promise.reject(new Error('Google Picker requires a browser'));
  }
  if (globalThis.gapi?.load) return Promise.resolve();
  if (_pickerLoader) return _pickerLoader;
  _pickerLoader = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${PICKER_SCRIPT}"]`);
    if (existing && globalThis.gapi) {
      resolve();
      return;
    }
    const s = document.createElement('script');
    s.src = PICKER_SCRIPT;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Failed to load Google Picker API script'));
    document.head.appendChild(s);
  }).then(() => new Promise((resolve, reject) => {
    if (!globalThis.gapi?.load) {
      reject(new Error('Google API script loaded but gapi.load missing'));
      return;
    }
    globalThis.gapi.load('picker', { callback: resolve, onerror: reject });
  }));
  return _pickerLoader;
}

/**
 * Open Google Picker for audio/video files.
 * @param {{ accessToken: string, apiKey?: string|null, appId?: string|null }} opts
 * @returns {Promise<{ id: string, name: string, mimeType: string }>}
 */
export async function pickDriveMediaFile(opts) {
  const accessToken = opts.accessToken;
  if (!accessToken) throw new Error('Missing Google Drive access token');
  const cfg = getDriveConfig();
  const apiKey = opts.apiKey || cfg.apiKey;
  if (!apiKey) {
    throw new Error('Google developer key required for Drive Picker (see docs/guides/GOOGLE_DRIVE.md).');
  }
  await loadPickerApi();
  const google = globalThis.google;
  if (!google?.picker) throw new Error('Google Picker unavailable');

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      fn();
    };
    const view = new google.picker.DocsView(google.picker.ViewId.DOCS)
      .setIncludeFolders(false)
      .setSelectFolderEnabled(false)
      .setMimeTypes([
        'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/wave',
        'audio/ogg', 'audio/flac', 'audio/aac', 'audio/mp4', 'audio/m4a',
        'audio/webm', 'audio/*',
        'video/mp4', 'video/webm', 'video/quicktime', 'video/*',
      ].join(','));

    const builder = new google.picker.PickerBuilder()
      .addView(view)
      .setOAuthToken(accessToken)
      .setDeveloperKey(apiKey)
      .setTitle('Open audio or video from Google Drive')
      .setCallback((data) => {
        const action = data[google.picker.Response.ACTION];
        if (action === google.picker.Action.PICKED) {
          const doc = data[google.picker.Response.DOCUMENTS]?.[0];
          if (!doc) {
            finish(() => reject(new Error('No file selected from Google Drive')));
            return;
          }
          finish(() => resolve({
            id: doc[google.picker.Document.ID],
            name: doc[google.picker.Document.NAME] || 'drive-file',
            mimeType: doc[google.picker.Document.MIME_TYPE] || 'application/octet-stream',
          }));
        } else if (action === google.picker.Action.CANCEL) {
          const err = new Error('Drive picker cancelled');
          err.code = 'CANCELLED';
          finish(() => reject(err));
        }
      });

    const appId = opts.appId || cfg.appId;
    if (appId) builder.setAppId(String(appId).replace(/:.*/, '') || appId);

    const picker = builder.build();
    picker.setVisible(true);
  });
}

/**
 * Pick + download into a File suitable for existing ingest handlers.
 * @param {{ accessToken?: string, signIn?: Function }} [opts]
 * @returns {Promise<File>}
 */
export async function openMediaFileFromDrive(opts = {}) {
  const token = opts.accessToken || await ensureGoogleDriveAuth({ signIn: opts.signIn });
  let picked;
  try {
    picked = await pickDriveMediaFile({ accessToken: token });
  } catch (err) {
    if (err?.code === 'DRIVE_AUTH') {
      const retryToken = await ensureGoogleDriveAuth({ force: true, signIn: opts.signIn });
      picked = await pickDriveMediaFile({ accessToken: retryToken });
      const blob = await downloadDriveFile({ accessToken: retryToken, fileId: picked.id });
      return blobToFile(blob, picked.name, picked.mimeType);
    }
    throw err;
  }
  try {
    const blob = await downloadDriveFile({ accessToken: token, fileId: picked.id });
    return blobToFile(blob, picked.name, picked.mimeType);
  } catch (err) {
    if (err?.code === 'DRIVE_AUTH') {
      const retryToken = await ensureGoogleDriveAuth({ force: true, signIn: opts.signIn });
      const blob = await downloadDriveFile({ accessToken: retryToken, fileId: picked.id });
      return blobToFile(blob, picked.name, picked.mimeType);
    }
    throw err;
  }
}

/**
 * @param {Blob} blob
 * @param {string} name
 * @param {string} [mimeType]
 */
export function blobToFile(blob, name, mimeType) {
  const type = mimeType || blob.type || 'application/octet-stream';
  try {
    return new File([blob], name || 'drive-file', { type, lastModified: Date.now() });
  } catch {
    // Older WebViews: Fake File-like Blob
    const f = blob.slice(0, blob.size, type);
    Object.defineProperty(f, 'name', { value: name || 'drive-file' });
    Object.defineProperty(f, 'lastModified', { value: Date.now() });
    return f;
  }
}

/**
 * Upload export blob with auth retry.
 * @param {{ blob: Blob, filename: string, mimeType?: string, signIn?: Function, accessToken?: string }} opts
 */
export async function saveBlobToDrive(opts) {
  const token = opts.accessToken || await ensureGoogleDriveAuth({ signIn: opts.signIn });
  try {
    return await uploadDriveFile({
      accessToken: token,
      blob: opts.blob,
      filename: opts.filename,
      mimeType: opts.mimeType || opts.blob.type || 'application/octet-stream',
    });
  } catch (err) {
    if (err?.code === 'DRIVE_AUTH') {
      const retry = await ensureGoogleDriveAuth({ force: true, signIn: opts.signIn });
      return uploadDriveFile({
        accessToken: retry,
        blob: opts.blob,
        filename: opts.filename,
        mimeType: opts.mimeType || opts.blob.type || 'application/octet-stream',
      });
    }
    throw err;
  }
}

export default {
  DRIVE_SCOPE,
  getDriveConfig,
  isDriveConfigured,
  getDriveScope,
  setAccessToken,
  getAccessToken,
  clearDriveSession,
  ensureGoogleDriveAuth,
  ensureAppFolder,
  uploadDriveFile,
  downloadDriveFile,
  pickDriveMediaFile,
  openMediaFileFromDrive,
  saveBlobToDrive,
  blobToFile,
};
