/**
 * VoiceIsolate Pro — Google Drive bridge (user-initiated file I/O only)
 *
 * Import/export audio files via Drive API v3 using a Google Identity Services
 * OAuth token client (drive.file scope only) plus the Google Picker.
 *
 * Config (GOOGLE_OAUTH_CLIENT_ID, GOOGLE_API_KEY, optional GOOGLE_APP_ID)
 * is read from window globals or GET /api/client-config (Vercel env).
 * If those values are missing, Drive buttons stay hidden.
 *
 * NEVER called from AudioWorklet, MLWorker, or Process. Processing stays local.
 *
 * Docs cited in this module:
 * - GIS token model: https://developers.google.com/identity/oauth2/web/guides/use-token-model
 * - GIS JS reference: https://developers.google.com/identity/oauth2/web/reference/js-reference
 * - Picker: https://developers.google.com/workspace/drive/picker/guides/web-picker
 * - Drive v3 uploads: https://developers.google.com/workspace/drive/api/guides/manage-uploads
 */
'use strict';

import { onDriveAccessToken, setDriveAccessToken } from './DriveSession.js';

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const APP_FOLDER_NAME = 'VoiceIsolate Pro';
const PICKER_SCRIPT = 'https://apis.google.com/js/api.js';
const GIS_SCRIPT = 'https://accounts.google.com/gsi/client';
/** Google's small-file threshold for multipart vs resumable uploads (bytes). */
const MULTIPART_MAX_BYTES = 5 * 1024 * 1024;
const DRIVE_UI_IDS = ['openDriveBtn', 'openDriveUploadBtn', 'saveDriveBtn', 'driveConfigStatus'];

/** @type {string|null} */
let _accessToken = null;
onDriveAccessToken((token) => { _accessToken = token; });
/** @type {string|null} */
let _appFolderId = null;
/** @type {Promise<void>|null} */
let _pickerLoader = null;
/** @type {Promise<void>|null} */
let _gisLoader = null;
/** @type {Promise<object>|null} */
let _clientConfigLoader = null;

/**
 * @returns {{ apiKey: string|null, clientId: string|null, appId: string|null }}
 */
export function getDriveConfig(globals) {
  const g = globals || (typeof globalThis !== 'undefined' ? globalThis : {});
  const apiKey = g.GOOGLE_API_KEY || null;
  const oauthClientId = g.GOOGLE_OAUTH_CLIENT_ID || g.GOOGLE_CLIENT_ID || null;
  const appId = g.GOOGLE_APP_ID || g.GOOGLE_CLOUD_PROJECT_NUMBER || null;
  return {
    apiKey: driveValuePresent(apiKey) ? String(apiKey).trim() : null,
    clientId: driveValuePresent(oauthClientId) ? String(oauthClientId).trim() : null,
    appId: resolvePickerAppId(appId),
  };
}

function driveValuePresent(value) {
  if (value == null) return false;
  const text = String(value).trim();
  return text.length > 0 && !text.includes('YOUR_');
}

/**
 * Picker setAppId needs the Cloud project *number*.
 * Accepts a bare number, or a Firebase-style app id `1:<projectNumber>:web:<hash>`.
 * @param {unknown} appId
 * @returns {string|null}
 */
export function resolvePickerAppId(appId) {
  if (!driveValuePresent(appId)) return null;
  const text = String(appId).trim();
  const firebase = text.match(/^\d+:(\d+):/);
  if (firebase) return firebase[1];
  if (/^\d+$/.test(text)) return text;
  return text;
}

/**
 * Names the env / window settings the owner must inject. Values are never returned.
 * GOOGLE_OAUTH_CLIENT_ID and GOOGLE_API_KEY are required for the GIS + Picker path.
 * GOOGLE_APP_ID (Cloud project number) is recommended for Picker.setAppId.
 */
export function describeDriveConfiguration(globals) {
  const g = globals || (typeof globalThis !== 'undefined' ? globalThis : {});
  const cfg = getDriveConfig(g);
  const checks = [
    ['GOOGLE_OAUTH_CLIENT_ID', !!cfg.clientId],
    ['GOOGLE_API_KEY', !!cfg.apiKey],
  ];
  const missing = checks.filter(([, ok]) => !ok).map(([name]) => name);
  const optionalMissing = cfg.appId ? [] : ['GOOGLE_APP_ID'];
  const configured = missing.length === 0;
  const message = configured
    ? 'Google Drive is available. Sign-in uses your Google account with the drive.file scope only. Local WAV export does not need Drive. Processing stays on this device.'
    : `Google Drive is not configured. Missing: ${missing.join(', ')}. `
      + 'Local WAV export still works. The owner sets these in Vercel env or at runtime (never in git) — see docs/guides/GOOGLE_DRIVE.md.';
  return { configured, missing, optionalMissing, message };
}

export function isDriveConfigured(globals) {
  return describeDriveConfiguration(globals).configured;
}

/**
 * Apply public Drive credentials from GET /api/client-config.
 * Does not overwrite window values already injected (Electron / local overrides).
 * @param {object} data
 * @param {object} [globals]
 */
export function applyDriveClientConfig(data, globals) {
  const g = globals || (typeof globalThis !== 'undefined' ? globalThis : {});
  if (!data || typeof data !== 'object' || typeof g !== 'object') return getDriveConfig(g);
  if (!driveValuePresent(g.GOOGLE_OAUTH_CLIENT_ID) && !driveValuePresent(g.GOOGLE_CLIENT_ID)
      && driveValuePresent(data.googleOAuthClientId)) {
    g.GOOGLE_OAUTH_CLIENT_ID = String(data.googleOAuthClientId).trim();
  }
  if (!driveValuePresent(g.GOOGLE_API_KEY) && driveValuePresent(data.googleApiKey)) {
    g.GOOGLE_API_KEY = String(data.googleApiKey).trim();
  }
  if (!driveValuePresent(g.GOOGLE_APP_ID) && !driveValuePresent(g.GOOGLE_CLOUD_PROJECT_NUMBER)
      && driveValuePresent(data.googleAppId)) {
    g.GOOGLE_APP_ID = String(data.googleAppId).trim();
  }
  return getDriveConfig(g);
}

function clientConfigUrl() {
  let base = '';
  if (typeof globalThis !== 'undefined' && globalThis.VIP_API_BASE_URL) {
    const raw = String(globalThis.VIP_API_BASE_URL).trim();
    if (/^https:\/\/.+/i.test(raw)) base = raw.replace(/\/$/, '');
  }
  return `${base}/api/client-config`;
}

/**
 * Fetch browser-safe Drive credentials from /api/client-config (Vercel env)
 * and apply them. Failures leave Drive unconfigured (buttons stay hidden).
 * @param {{ fetch?: typeof fetch, force?: boolean }} [opts]
 */
export async function loadDriveClientConfig(opts = {}) {
  if (_clientConfigLoader && !opts.force) return _clientConfigLoader;
  const run = (async () => {
    const fetchFn = opts.fetch || (typeof fetch === 'function' ? fetch : null);
    if (fetchFn) {
      try {
        const res = await fetchFn(clientConfigUrl());
        if (res && res.ok) {
          const data = await res.json();
          applyDriveClientConfig(data);
        }
      } catch {
        // Unconfigured: feature flag hides the buttons. No throw, no console error.
      }
    }
    return describeDriveConfiguration();
  })();
  _clientConfigLoader = run;
  try {
    return await run;
  } finally {
    if (opts.force) _clientConfigLoader = null;
  }
}

/**
 * Hide Drive buttons when env/config is missing; show them when configured.
 * Does not alter upload/export layout besides the hidden attribute on Drive controls.
 * @param {{ configured?: boolean }} report
 * @param {Pick<Document, 'getElementById'|'querySelectorAll'>} [root]
 */
export function applyDriveFeatureFlag(report, root) {
  const doc = root || (typeof document !== 'undefined' ? document : null);
  if (!doc || typeof doc.getElementById !== 'function') return report;
  const configured = !!report?.configured;
  const nodes = [];
  for (const id of DRIVE_UI_IDS) {
    const el = doc.getElementById(id);
    if (el) nodes.push(el);
  }
  if (typeof doc.querySelectorAll === 'function') {
    doc.querySelectorAll('[data-drive-ui]').forEach((el) => nodes.push(el));
  }
  const seen = new Set();
  for (const el of nodes) {
    if (seen.has(el)) continue;
    seen.add(el);
    el.hidden = !configured;
    if (typeof el.setAttribute === 'function') {
      if (!configured) el.setAttribute('aria-hidden', 'true');
      else if (typeof el.removeAttribute === 'function') el.removeAttribute('aria-hidden');
    }
  }
  return report;
}

export function getDriveScope() {
  return DRIVE_SCOPE;
}

export function getMultipartMaxBytes() {
  return MULTIPART_MAX_BYTES;
}

export function setAccessToken(token) {
  setDriveAccessToken(token);
}

export function getAccessToken() {
  return _accessToken;
}

export function clearDriveSession() {
  _appFolderId = null;
  _clientConfigLoader = null;
  setDriveAccessToken(null);
}

function loadScript(src, cacheKey, getReady) {
  if (typeof globalThis === 'undefined') {
    return Promise.reject(new Error('Google Drive requires a browser'));
  }
  if (getReady()) return Promise.resolve();
  if (cacheKey()) return cacheKey();
  const loader = new Promise((resolve, reject) => {
    if (getReady()) {
      resolve();
      return;
    }
    if (typeof document === 'undefined') {
      reject(new Error('Google Drive requires a document to load scripts'));
      return;
    }
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)), { once: true });
      if (getReady()) resolve();
      return;
    }
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });
  return loader;
}

function loadGisClient() {
  if (globalThis.google?.accounts?.oauth2?.initTokenClient) return Promise.resolve();
  if (_gisLoader) return _gisLoader;
  _gisLoader = loadScript(GIS_SCRIPT, () => _gisLoader, () => !!globalThis.google?.accounts?.oauth2?.initTokenClient)
    .then(() => {
      if (!globalThis.google?.accounts?.oauth2?.initTokenClient) {
        throw new Error('Google Identity Services loaded but initTokenClient is missing');
      }
    })
    .catch((err) => {
      _gisLoader = null;
      throw err;
    });
  return _gisLoader;
}

function loadPickerApi() {
  if (globalThis.gapi?.load && globalThis.google?.picker) return Promise.resolve();
  if (_pickerLoader) return _pickerLoader;
  _pickerLoader = loadScript(PICKER_SCRIPT, () => _pickerLoader, () => !!globalThis.gapi?.load)
    .then(() => new Promise((resolve, reject) => {
      if (!globalThis.gapi?.load) {
        reject(new Error('Google API script loaded but gapi.load missing'));
        return;
      }
      if (globalThis.google?.picker) {
        resolve();
        return;
      }
      globalThis.gapi.load('picker', { callback: resolve, onerror: reject });
    }))
    .catch((err) => {
      _pickerLoader = null;
      throw err;
    });
  return _pickerLoader;
}

function cancelledError(message) {
  const err = new Error(message || 'Cancelled');
  err.code = 'CANCELLED';
  return err;
}

/**
 * Request a GIS access token with ONLY the drive.file scope.
 * https://developers.google.com/identity/oauth2/web/guides/use-token-model
 * @param {{ force?: boolean, oauth2?: object, clientId?: string }} [opts]
 * @returns {Promise<string>}
 */
export async function requestDriveAccessToken(opts = {}) {
  const cfg = getDriveConfig();
  const clientId = opts.clientId || cfg.clientId;
  if (!clientId) {
    throw new Error(
      'Google Drive is not configured (missing GOOGLE_OAUTH_CLIENT_ID). See docs/guides/GOOGLE_DRIVE.md.',
    );
  }
  const oauth2 = opts.oauth2 || (await loadGisClient(), globalThis.google?.accounts?.oauth2);
  if (!oauth2?.initTokenClient) {
    throw new Error('Google Identity Services token client is not available.');
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      fn();
    };
    const client = oauth2.initTokenClient({
      client_id: clientId,
      scope: DRIVE_SCOPE,
      include_granted_scopes: false,
      prompt: opts.force ? 'consent' : '',
      callback: (response) => {
        if (response?.error) {
          const denied = response.error === 'access_denied' || response.error === 'popup_closed';
          const err = denied
            ? cancelledError(response.error_description || 'Google sign-in cancelled')
            : new Error(response.error_description || `Google sign-in failed (${response.error})`);
          if (!denied) err.code = 'DRIVE_AUTH';
          finish(() => reject(err));
          return;
        }
        const token = response?.access_token;
        if (!token) {
          finish(() => reject(new Error('Google Drive sign-in did not return an access token.')));
          return;
        }
        const granted = typeof oauth2.hasGrantedAllScopes === 'function'
          ? oauth2.hasGrantedAllScopes(response, DRIVE_SCOPE)
          : String(response.scope || DRIVE_SCOPE).split(/\s+/).includes(DRIVE_SCOPE);
        if (!granted) {
          const err = new Error('Google Drive permission was not granted (drive.file scope required).');
          err.code = 'DRIVE_AUTH';
          finish(() => reject(err));
          return;
        }
        setAccessToken(token);
        finish(() => resolve(token));
      },
      error_callback: (error) => {
        const type = error?.type || error?.message || 'popup_closed';
        const cancelled = type === 'popup_closed' || type === 'popup_closed_by_user';
        const err = cancelled
          ? cancelledError('Google sign-in cancelled')
          : new Error(`Google sign-in failed (${type})`);
        if (!cancelled) err.code = 'DRIVE_AUTH';
        finish(() => reject(err));
      },
    });
    if (!client || typeof client.requestAccessToken !== 'function') {
      finish(() => reject(new Error('Google Identity Services token client is not available.')));
      return;
    }
    client.requestAccessToken(opts.force ? { prompt: 'consent' } : { prompt: '' });
  });
}

/**
 * Ensure we have a Google OAuth access token with Drive scope.
 * Prefers a cached token, then GIS token client. An explicit signIn hook is
 * test-only / override; it is not used in production UI.
 * @param {{ force?: boolean, signIn?: () => Promise<{ accessToken?: string }>, oauth2?: object }} [opts]
 */
export async function ensureGoogleDriveAuth(opts = {}) {
  if (!opts.force && _accessToken) return _accessToken;
  if (typeof opts.signIn === 'function') {
    const result = await opts.signIn();
    const token = result?.accessToken || result?.credential?.accessToken || result || null;
    const value = token && typeof token === 'string' ? token : null;
    if (!value) {
      throw new Error('Google Drive sign-in did not return an access token. Re-consent Drive permission.');
    }
    setAccessToken(value);
    return value;
  }
  return requestDriveAccessToken(opts);
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

async function uploadDriveFileMultipart({ accessToken, blob, filename, mimeType, parent }) {
  const metadata = {
    name: filename,
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

async function uploadDriveFileResumable({ accessToken, blob, filename, mimeType, parent }) {
  const metadata = {
    name: filename,
    parents: parent ? [parent] : undefined,
  };
  const init = await driveFetch(
    accessToken,
    `${DRIVE_UPLOAD}?uploadType=resumable&fields=id,name,webViewLink,mimeType,size`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': mimeType,
        'X-Upload-Content-Length': String(blob.size),
      },
      body: JSON.stringify(metadata),
    },
  );
  const location = init.headers?.get?.('Location') || init.headers?.get?.('location');
  if (!location) {
    throw new Error('Drive resumable upload did not return a session URI');
  }
  const put = await driveFetch(accessToken, location, {
    method: 'PUT',
    headers: {
      'Content-Type': mimeType,
    },
    body: blob,
  });
  return put.json();
}

/**
 * Upload a Blob to Drive. Multipart for files ≤ 5 MB; resumable above that.
 * https://developers.google.com/workspace/drive/api/guides/manage-uploads
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
  const args = { accessToken, blob, filename: name, mimeType, parent };
  if (blob.size > MULTIPART_MAX_BYTES) {
    return uploadDriveFileResumable(args);
  }
  return uploadDriveFileMultipart(args);
}

/**
 * Download file bytes from Drive (alt=media) into a Blob for local ingest.
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
  const raw = typeof res.blob === 'function' ? await res.blob() : new Blob([await res.arrayBuffer()]);
  const mime = meta.mimeType || raw.type || 'application/octet-stream';
  const blob = raw.type === mime ? raw : new Blob([raw], { type: mime });
  blob.__vipDriveName = meta.name || 'drive-file';
  blob.__vipDriveId = meta.id;
  return blob;
}

/**
 * Open Google Picker for audio/video files.
 * https://developers.google.com/workspace/drive/picker/guides/web-picker
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
          finish(() => reject(cancelledError('Drive picker cancelled')));
        }
      });

    const appId = resolvePickerAppId(opts.appId) || cfg.appId;
    if (appId) builder.setAppId(appId);

    const picker = builder.build();
    picker.setVisible(true);
  });
}

/**
 * Pick + download into a File suitable for existing ingest handlers
 * (handleFile / ingestFrom). Large files then follow the same windowed
 * ingest path as local uploads.
 * @param {{ accessToken?: string, signIn?: Function, oauth2?: object }} [opts]
 * @returns {Promise<File>}
 */
export async function openMediaFileFromDrive(opts = {}) {
  const token = opts.accessToken || await ensureGoogleDriveAuth({ signIn: opts.signIn, oauth2: opts.oauth2 });
  let picked;
  try {
    picked = await pickDriveMediaFile({ accessToken: token });
  } catch (err) {
    if (err?.code === 'DRIVE_AUTH') {
      const retryToken = await ensureGoogleDriveAuth({ force: true, signIn: opts.signIn, oauth2: opts.oauth2 });
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
      const retryToken = await ensureGoogleDriveAuth({ force: true, signIn: opts.signIn, oauth2: opts.oauth2 });
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
 * @param {{ blob: Blob, filename: string, mimeType?: string, signIn?: Function, accessToken?: string, oauth2?: object }} opts
 */
export async function saveBlobToDrive(opts) {
  const token = opts.accessToken || await ensureGoogleDriveAuth({ signIn: opts.signIn, oauth2: opts.oauth2 });
  try {
    return await uploadDriveFile({
      accessToken: token,
      blob: opts.blob,
      filename: opts.filename,
      mimeType: opts.mimeType || opts.blob.type || 'application/octet-stream',
    });
  } catch (err) {
    if (err?.code === 'DRIVE_AUTH') {
      const retry = await ensureGoogleDriveAuth({ force: true, signIn: opts.signIn, oauth2: opts.oauth2 });
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
  MULTIPART_MAX_BYTES,
  getDriveConfig,
  resolvePickerAppId,
  describeDriveConfiguration,
  isDriveConfigured,
  applyDriveClientConfig,
  loadDriveClientConfig,
  applyDriveFeatureFlag,
  getDriveScope,
  getMultipartMaxBytes,
  setAccessToken,
  getAccessToken,
  clearDriveSession,
  requestDriveAccessToken,
  ensureGoogleDriveAuth,
  ensureAppFolder,
  uploadDriveFile,
  downloadDriveFile,
  pickDriveMediaFile,
  openMediaFileFromDrive,
  saveBlobToDrive,
  blobToFile,
};
