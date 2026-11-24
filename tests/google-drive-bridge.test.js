/**
 * Google Drive bridge — unit tests (mocked GIS, Picker, and fetch) + UI/privacy wiring.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

function fakeDoc(ids) {
  const els = {};
  for (const id of ids) {
    els[id] = {
      id,
      hidden: true,
      attrs: {},
      setAttribute(name, value) { this.attrs[name] = String(value); },
      removeAttribute(name) { delete this.attrs[name]; },
    };
  }
  return {
    elements: els,
    getElementById: (id) => els[id] || null,
    querySelectorAll: () => [],
  };
}

function mockPicker(google, { action = 'picked', doc = { id: 'file1', name: 'clip.wav', mimeType: 'audio/wav' } } = {}) {
  const Response = { ACTION: 'action', DOCUMENTS: 'docs' };
  const Action = { PICKED: 'picked', CANCEL: 'cancel' };
  const Document = { ID: 'id', NAME: 'name', MIME_TYPE: 'mimeType' };
  const calls = { setOAuthToken: [], setDeveloperKey: [], setAppId: [], setVisible: [] };
  class DocsView {
    constructor() { this._mime = ''; }
    setIncludeFolders() { return this; }
    setSelectFolderEnabled() { return this; }
    setMimeTypes(m) { this._mime = m; return this; }
  }
  class PickerBuilder {
    constructor() { this._cb = null; }
    addView() { return this; }
    setOAuthToken(t) { calls.setOAuthToken.push(t); return this; }
    setDeveloperKey(k) { calls.setDeveloperKey.push(k); return this; }
    setAppId(id) { calls.setAppId.push(id); return this; }
    setTitle() { return this; }
    setCallback(cb) { this._cb = cb; return this; }
    build() {
      const cb = this._cb;
      return {
        setVisible(v) {
          calls.setVisible.push(v);
          const payload = action === 'picked'
            ? { action: Action.PICKED, docs: [doc] }
            : { action: Action.CANCEL };
          queueMicrotask(() => cb(payload));
        },
      };
    }
  }
  google.picker = {
    DocsView, PickerBuilder, ViewId: { DOCS: 'docs' }, Response, Action, Document,
  };
  return calls;
}

describe('GoogleDriveBridge', () => {
  let drive;
  const originalFetch = global.fetch;
  const originalGoogle = globalThis.google;

  beforeAll(async () => {
    drive = await import(pathToFileURL(path.join(ROOT, 'src/core/GoogleDriveBridge.js')).href);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    drive.clearDriveSession();
    delete globalThis.GOOGLE_OAUTH_CLIENT_ID;
    delete globalThis.GOOGLE_CLIENT_ID;
    delete globalThis.GOOGLE_API_KEY;
    delete globalThis.GOOGLE_APP_ID;
    delete globalThis.FIREBASE_API_KEY;
    globalThis.google = originalGoogle;
  });

  test('exports Drive helpers', () => {
    expect(typeof drive.uploadDriveFile).toBe('function');
    expect(typeof drive.downloadDriveFile).toBe('function');
    expect(typeof drive.saveBlobToDrive).toBe('function');
    expect(typeof drive.openMediaFileFromDrive).toBe('function');
    expect(typeof drive.requestDriveAccessToken).toBe('function');
    expect(typeof drive.applyDriveFeatureFlag).toBe('function');
    expect(drive.getDriveScope()).toBe(DRIVE_SCOPE);
  });

  test('flag-off hides Drive buttons; flag-on shows them', () => {
    const doc = fakeDoc(['openDriveBtn', 'saveDriveBtn', 'openDriveUploadBtn', 'driveConfigStatus']);
    drive.applyDriveFeatureFlag({ configured: false }, doc);
    expect(doc.elements.openDriveBtn.hidden).toBe(true);
    expect(doc.elements.saveDriveBtn.hidden).toBe(true);
    expect(doc.elements.openDriveUploadBtn.hidden).toBe(true);
    expect(doc.elements.driveConfigStatus.hidden).toBe(true);
    expect(doc.elements.openDriveBtn.attrs['aria-hidden']).toBe('true');

    drive.applyDriveFeatureFlag({ configured: true }, doc);
    expect(doc.elements.openDriveBtn.hidden).toBe(false);
    expect(doc.elements.saveDriveBtn.hidden).toBe(false);
    expect(doc.elements.openDriveUploadBtn.hidden).toBe(false);
    expect(doc.elements.openDriveBtn.attrs['aria-hidden']).toBeUndefined();
  });

  test('describeDriveConfiguration requires GIS client id and API key only', () => {
    const empty = drive.describeDriveConfiguration({});
    expect(empty.configured).toBe(false);
    expect(empty.missing).toEqual(['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_API_KEY']);
    expect(empty.optionalMissing).toEqual(['GOOGLE_APP_ID']);
    expect(empty.message).toMatch(/Local WAV export still works/);
    expect(JSON.stringify(empty)).not.toMatch(/sk_|secret/i);

    const secret = 'super-secret-drive-value';
    const ready = drive.describeDriveConfiguration({
      GOOGLE_OAUTH_CLIENT_ID: '123.apps.googleusercontent.com',
      GOOGLE_API_KEY: secret,
      GOOGLE_APP_ID: '9876543210',
    });
    expect(ready.configured).toBe(true);
    expect(ready.missing).toEqual([]);
    expect(JSON.stringify(ready)).not.toContain(secret);
    // Firebase leftovers must not be required.
    expect(ready.missing).not.toContain('FIREBASE_API_KEY');
  });

  test('Firebase-only window settings do not enable Drive', () => {
    const report = drive.describeDriveConfiguration({
      FIREBASE_API_KEY: 'AIzaSyFake',
      FIREBASE_AUTH_DOMAIN: 'app.firebaseapp.com',
      FIREBASE_PROJECT_ID: 'voiceisolate',
      FIREBASE_APP_ID: '1:999:web:abc',
    });
    expect(report.configured).toBe(false);
    expect(report.missing).toEqual(['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_API_KEY']);
  });

  test('applyDriveClientConfig fills missing window values and does not overwrite', () => {
    const g = { GOOGLE_API_KEY: 'already-set' };
    drive.applyDriveClientConfig({
      googleOAuthClientId: 'cid.apps.googleusercontent.com',
      googleApiKey: 'from-server',
      googleAppId: '555',
    }, g);
    expect(g.GOOGLE_OAUTH_CLIENT_ID).toBe('cid.apps.googleusercontent.com');
    expect(g.GOOGLE_API_KEY).toBe('already-set');
    expect(g.GOOGLE_APP_ID).toBe('555');
  });

  test('loadDriveClientConfig applies /api/client-config and treats fetch failure as flag-off', async () => {
    const calls = [];
    const okFetch = async (url) => {
      calls.push(String(url));
      return {
        ok: true,
        json: async () => ({
          googleOAuthClientId: 'cid.apps.googleusercontent.com',
          googleApiKey: 'dev-key',
          googleAppId: '42',
        }),
      };
    };
    const report = await drive.loadDriveClientConfig({ fetch: okFetch, force: true });
    expect(calls[0]).toMatch(/\/api\/client-config$/);
    expect(report.configured).toBe(true);
    expect(globalThis.GOOGLE_OAUTH_CLIENT_ID).toBe('cid.apps.googleusercontent.com');

    delete globalThis.GOOGLE_OAUTH_CLIENT_ID;
    delete globalThis.GOOGLE_API_KEY;
    delete globalThis.GOOGLE_APP_ID;
    const failed = await drive.loadDriveClientConfig({
      fetch: async () => { throw new Error('network down'); },
      force: true,
    });
    expect(failed.configured).toBe(false);
  });

  test('resolvePickerAppId extracts the project number from a Firebase-style app id', () => {
    expect(drive.resolvePickerAppId('1:9876543210:web:deadbeef')).toBe('9876543210');
    expect(drive.resolvePickerAppId('9876543210')).toBe('9876543210');
    expect(drive.resolvePickerAppId('')).toBeNull();
    expect(drive.resolvePickerAppId('YOUR_APP_ID')).toBeNull();
  });

  test('requestDriveAccessToken uses only the drive.file scope', async () => {
    const configs = [];
    const oauth2 = {
      initTokenClient(config) {
        configs.push(config);
        return {
          requestAccessToken() {
            config.callback({
              access_token: 'tok_gis',
              scope: DRIVE_SCOPE,
              token_type: 'Bearer',
            });
          },
        };
      },
      hasGrantedAllScopes: (response, scope) => response.scope === scope && scope === DRIVE_SCOPE,
    };
    const token = await drive.requestDriveAccessToken({
      oauth2,
      clientId: 'cid.apps.googleusercontent.com',
    });
    expect(token).toBe('tok_gis');
    expect(configs).toHaveLength(1);
    expect(configs[0].client_id).toBe('cid.apps.googleusercontent.com');
    expect(configs[0].scope).toBe(DRIVE_SCOPE);
    expect(String(configs[0].scope)).not.toMatch(/drive\.readonly|auth\/drive[^. ]|drive\.metadata/);
    expect(configs[0].include_granted_scopes).toBe(false);
    expect(drive.getAccessToken()).toBe('tok_gis');
  });

  test('requestDriveAccessToken maps popup close and access_denied to CANCELLED', async () => {
    const closed = {
      initTokenClient(config) {
        return {
          requestAccessToken() { config.error_callback({ type: 'popup_closed' }); },
        };
      },
    };
    await expect(drive.requestDriveAccessToken({
      oauth2: closed,
      clientId: 'cid.apps.googleusercontent.com',
    })).rejects.toMatchObject({ code: 'CANCELLED' });

    const denied = {
      initTokenClient(config) {
        return {
          requestAccessToken() { config.callback({ error: 'access_denied' }); },
        };
      },
    };
    await expect(drive.requestDriveAccessToken({
      oauth2: denied,
      clientId: 'cid.apps.googleusercontent.com',
    })).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  test('requestDriveAccessToken rejects when drive.file was not granted', async () => {
    const oauth2 = {
      initTokenClient(config) {
        return {
          requestAccessToken() {
            config.callback({ access_token: 'tok', scope: 'openid' });
          },
        };
      },
      hasGrantedAllScopes: () => false,
    };
    await expect(drive.requestDriveAccessToken({
      oauth2,
      clientId: 'cid.apps.googleusercontent.com',
    })).rejects.toMatchObject({ code: 'DRIVE_AUTH' });
    expect(drive.getAccessToken()).toBeNull();
  });

  test('uploadDriveFile posts multipart body with Authorization', async () => {
    const calls = [];
    global.fetch = async (url, init = {}) => {
      calls.push({ url: String(url), init });
      if (String(url).includes('uploadType=multipart')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: 'file1', name: 'out.wav', webViewLink: 'https://drive.google.com/file/d/file1' }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ files: [{ id: 'folder1', name: 'VoiceIsolate Pro' }] }),
      };
    };

    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' });
    const meta = await drive.uploadDriveFile({
      accessToken: 'tok_test',
      blob,
      filename: 'out.wav',
      mimeType: 'audio/wav',
      parentId: 'folder1',
    });
    expect(meta.id).toBe('file1');
    const upload = calls.find((c) => c.url.includes('uploadType=multipart'));
    expect(upload).toBeTruthy();
    expect(upload.init.method).toBe('POST');
    expect(upload.init.headers.get('Authorization')).toBe('Bearer tok_test');
    expect(String(upload.init.headers.get('Content-Type'))).toMatch(/multipart\/related/);
    expect(upload.url).toMatch(/upload\/drive\/v3\/files\?uploadType=multipart/);
  });

  test('uploadDriveFile uses resumable upload for files larger than 5 MB', async () => {
    const calls = [];
    global.fetch = async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method, headers: init.headers, body: init.body });
      if (String(url).includes('uploadType=resumable')) {
        return {
          ok: true,
          status: 200,
          headers: { get: (name) => (String(name).toLowerCase() === 'location' ? 'https://www.googleapis.com/upload/drive/v3/files?upload_id=sess1' : null) },
          json: async () => ({}),
        };
      }
      if (String(url).includes('upload_id=sess1')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: 'big1', name: 'big.wav', size: String(drive.getMultipartMaxBytes() + 1) }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ files: [{ id: 'folder1' }] }) };
    };

    const size = drive.getMultipartMaxBytes() + 1;
    const blob = new Blob([new Uint8Array(size)], { type: 'audio/wav' });
    const meta = await drive.uploadDriveFile({
      accessToken: 'tok_test',
      blob,
      filename: 'big.wav',
      mimeType: 'audio/wav',
      parentId: 'folder1',
    });
    expect(meta.id).toBe('big1');
    const init = calls.find((c) => c.url.includes('uploadType=resumable'));
    expect(init).toBeTruthy();
    expect(init.method).toBe('POST');
    expect(init.headers.get('Authorization')).toBe('Bearer tok_test');
    expect(init.headers.get('X-Upload-Content-Type')).toBe('audio/wav');
    expect(init.headers.get('Content-Type')).toMatch(/application\/json/);
    const put = calls.find((c) => c.url.includes('upload_id=sess1'));
    expect(put.method).toBe('PUT');
    expect(put.body).toBe(blob);
    expect(calls.some((c) => c.url.includes('uploadType=multipart'))).toBe(false);
  });

  test('downloadDriveFile returns blob and throws DRIVE_AUTH on 401', async () => {
    global.fetch = async (url) => {
      if (String(url).includes('alt=media')) {
        return {
          ok: false,
          status: 401,
          text: async () => 'unauthorized',
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: 'f1', name: 'a.wav', mimeType: 'audio/wav' }),
      };
    };
    await expect(drive.downloadDriveFile({ accessToken: 'tok', fileId: 'f1' }))
      .rejects.toMatchObject({ code: 'DRIVE_AUTH' });
  });

  test('openMediaFileFromDrive delivers picked file bytes as a File for ingest', async () => {
    globalThis.GOOGLE_API_KEY = 'dev-key';
    globalThis.GOOGLE_OAUTH_CLIENT_ID = 'cid.apps.googleusercontent.com';
    globalThis.google = globalThis.google || {};
    mockPicker(globalThis.google, {
      action: 'picked',
      doc: { id: 'picked1', name: 'from-drive.wav', mimeType: 'audio/wav' },
    });
    globalThis.gapi = { load: (name, opts) => opts.callback() };

    const bytes = new Uint8Array([9, 8, 7, 6]);
    global.fetch = async (url) => {
      if (String(url).includes('alt=media')) {
        return {
          ok: true,
          status: 200,
          blob: async () => new Blob([bytes], { type: 'audio/wav' }),
        };
      }
      if (String(url).includes('/files/picked1')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: 'picked1', name: 'from-drive.wav', mimeType: 'audio/wav', size: '4' }),
        };
      }
      throw new Error(`unexpected fetch ${url}`);
    };

    const file = await drive.openMediaFileFromDrive({ accessToken: 'tok_in' });
    expect(file.name).toBe('from-drive.wav');
    expect(file.type).toBe('audio/wav');
    const got = new Uint8Array(await file.arrayBuffer());
    expect(Array.from(got)).toEqual([9, 8, 7, 6]);
  });

  test('pickDriveMediaFile rejects with CANCELLED when the user closes the picker', async () => {
    globalThis.GOOGLE_API_KEY = 'dev-key';
    globalThis.google = globalThis.google || {};
    mockPicker(globalThis.google, { action: 'cancel' });
    globalThis.gapi = { load: (name, opts) => opts.callback() };
    await expect(drive.pickDriveMediaFile({ accessToken: 'tok' }))
      .rejects.toMatchObject({ code: 'CANCELLED' });
  });

  test('ensureGoogleDriveAuth reads the closure token, not window', async () => {
    const session = await import(pathToFileURL(path.join(ROOT, 'src/core/DriveSession.js')).href);
    globalThis.__vipGoogleDriveAccessToken = 'window-token-must-not-be-used';
    drive.clearDriveSession();
    globalThis.__vipGoogleDriveAccessToken = 'window-token-must-not-be-used';
    await expect(drive.ensureGoogleDriveAuth()).rejects.toThrow(/not configured|not available/i);
    expect(globalThis.__vipGoogleDriveAccessToken).toBe('window-token-must-not-be-used');
    session.setDriveAccessToken('closure-token');
    expect(globalThis.__vipGoogleDriveAccessToken).toBeUndefined();
    await expect(drive.ensureGoogleDriveAuth()).resolves.toBe('closure-token');
    expect(drive.getAccessToken()).toBe('closure-token');
    drive.clearDriveSession();
    expect(drive.getAccessToken()).toBeNull();
    expect(session.getDriveAccessToken()).toBeNull();
  });

  test('blobToFile preserves name', () => {
    const blob = new Blob(['abc'], { type: 'audio/wav' });
    const file = drive.blobToFile(blob, 'clip.wav', 'audio/wav');
    expect(file.name).toBe('clip.wav');
  });
});

describe('Drive UI wiring (structural)', () => {
  const landingHtml = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const engHtml = fs.readFileSync(path.join(ROOT, 'public/app/index.html'), 'utf8');
  const landingJs = fs.readFileSync(path.join(ROOT, 'public/landing.js'), 'utf8');
  const appJs = fs.readFileSync(path.join(ROOT, 'public/app/app.js'), 'utf8');
  const firebase = fs.readFileSync(path.join(ROOT, 'public/app/firebase-config.js'), 'utf8');
  const mlWorker = fs.readFileSync(path.join(ROOT, 'src/workers/MLWorker.js'), 'utf8');
  const stem = fs.readFileSync(path.join(ROOT, 'src/pipeline/StemSeparation.js'), 'utf8');
  const envExample = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  const clientConfig = fs.readFileSync(path.join(ROOT, 'api-routes/client-config.js'), 'utf8');

  test('Landing and Engineer expose Open/Save Drive controls', () => {
    expect(landingHtml).toMatch(/id="openDriveBtn"/);
    expect(landingHtml).toMatch(/id="saveDriveBtn"/);
    expect(engHtml).toMatch(/id="saveDriveBtn"/);
    expect(engHtml).toMatch(/Open from Drive/);
  });

  test('Drive buttons ship hidden so a missing env flag does not show them', () => {
    expect(landingHtml).toMatch(/id="openDriveBtn"[^>]*\bhidden\b/);
    expect(landingHtml).toMatch(/id="saveDriveBtn"[^>]*\bhidden\b/);
    expect(engHtml).toMatch(/id="openDriveBtn"[^>]*\bhidden\b/);
    expect(engHtml).toMatch(/id="openDriveUploadBtn"[^>]*\bhidden\b/);
    expect(engHtml).toMatch(/id="saveDriveBtn"[^>]*\bhidden\b/);
  });

  test('Landing/Engineer wire Drive handlers (not Process) and load env config', () => {
    expect(landingJs).toMatch(/onOpenFromDrive|openMediaFileFromDrive/);
    expect(landingJs).toMatch(/onSaveToDrive|saveBlobToDrive/);
    expect(landingJs).toMatch(/loadDriveClientConfig/);
    expect(landingJs).toMatch(/applyDriveFeatureFlag/);
    expect(landingJs).toMatch(/ingestFrom\(file\)/);
    expect(appJs).toMatch(/_openFromGoogleDrive|_saveProcessedToGoogleDrive/);
    expect(appJs).toMatch(/loadDriveClientConfig/);
    expect(appJs).toMatch(/applyDriveFeatureFlag/);
    expect(appJs).toMatch(/this\.handleFile\(file\)/);
    expect(firebase).toMatch(/drive\.file/);
  });

  test('MLWorker and StemSeparation do not import Drive bridge', () => {
    expect(mlWorker).not.toMatch(/GoogleDriveBridge/);
    expect(stem).not.toMatch(/GoogleDriveBridge/);
  });

  test('privacy copy present on Engineer save row', () => {
    expect(engHtml).toMatch(/Processing never uses Drive/i);
  });

  test('Drive access token is not assigned on window', () => {
    expect(firebase).not.toMatch(/__vipGoogleDriveAccessToken\s*=/);
    expect(firebase).toMatch(/setDriveAccessToken/);
    const bridge = fs.readFileSync(path.join(ROOT, 'src/core/GoogleDriveBridge.js'), 'utf8');
    expect(bridge).not.toMatch(/__vipGoogleDriveAccessToken/);
    expect(bridge).toMatch(/setDriveAccessToken/);
    expect(bridge).toMatch(/initTokenClient/);
    expect(bridge).toMatch(/include_granted_scopes: false/);
    expect(bridge).toMatch(/https:\/\/www\.googleapis\.com\/auth\/drive\.file/);
  });

  test('.env.example documents Drive placeholders and client-config reads them', () => {
    expect(envExample).toMatch(/GOOGLE_OAUTH_CLIENT_ID=/);
    expect(envExample).toMatch(/GOOGLE_API_KEY=/);
    expect(envExample).toMatch(/GOOGLE_APP_ID=/);
    expect(clientConfig).toMatch(/GOOGLE_OAUTH_CLIENT_ID/);
    expect(clientConfig).toMatch(/GOOGLE_API_KEY/);
    expect(clientConfig).toMatch(/GOOGLE_APP_ID/);
    expect(clientConfig).toMatch(/googleOAuthClientId/);
  });
});
