/**
 * Google Drive bridge — unit tests (mocked fetch) + privacy wiring checks.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');

describe('GoogleDriveBridge', () => {
  let drive;
  const originalFetch = global.fetch;

  beforeAll(async () => {
    drive = await import(pathToFileURL(path.join(ROOT, 'src/core/GoogleDriveBridge.js')).href);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    drive.clearDriveSession();
  });

  test('exports Drive helpers', () => {
    expect(typeof drive.uploadDriveFile).toBe('function');
    expect(typeof drive.downloadDriveFile).toBe('function');
    expect(typeof drive.saveBlobToDrive).toBe('function');
    expect(typeof drive.openMediaFileFromDrive).toBe('function');
    expect(drive.getDriveScope()).toMatch(/drive\.file/);
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
      // folder list
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

  test('Landing and Engineer expose Open/Save Drive controls', () => {
    expect(landingHtml).toMatch(/id="openDriveBtn"/);
    expect(landingHtml).toMatch(/id="saveDriveBtn"/);
    expect(engHtml).toMatch(/id="saveDriveBtn"/);
    expect(engHtml).toMatch(/Open from Drive/);
  });

  test('Landing/Engineer wire Drive handlers (not Process)', () => {
    expect(landingJs).toMatch(/onOpenFromDrive|openMediaFileFromDrive/);
    expect(landingJs).toMatch(/onSaveToDrive|saveBlobToDrive/);
    expect(appJs).toMatch(/_openFromGoogleDrive|_saveProcessedToGoogleDrive/);
    expect(firebase).toMatch(/signInWithGoogleDrive/);
    expect(firebase).toMatch(/drive\.file/);
  });

  test('MLWorker and StemSeparation do not import Drive bridge', () => {
    expect(mlWorker).not.toMatch(/GoogleDriveBridge/);
    expect(stem).not.toMatch(/GoogleDriveBridge/);
  });

  test('privacy copy present on Engineer save row', () => {
    expect(engHtml).toMatch(/Processing never uses Drive/i);
  });
});
