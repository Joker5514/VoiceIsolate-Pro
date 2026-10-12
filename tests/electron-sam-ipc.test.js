/**
 * Electron SAM IPC channel contract (static).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('Electron SAM worker IPC', () => {
  test('channels include sam worker APIs', () => {
    const src = read('electron/ipc-channels.cjs');
    expect(src).toMatch(/SAM_WORKER_STATUS/);
    expect(src).toMatch(/SAM_WORKER_START/);
    expect(src).toMatch(/SAM_WORKER_STOP/);
    expect(src).toMatch(/SAM_WORKER_CAPABILITIES/);
    expect(src).toMatch(/SAM_WORKER_SEPARATE/);
    expect(src).toMatch(/SAM_WORKER_CANCEL/);
  });

  test('separation goes through the main-process loopback proxy (F16)', () => {
    const main = read('electron/main.cjs');
    expect(main).toMatch(/handleTrusted\(IPC\.SAM_WORKER_SEPARATE/);
    expect(main).toMatch(/handleTrusted\(IPC\.SAM_WORKER_CANCEL/);
    const proxy = read('electron/sam-proxy.cjs');
    expect(proxy).toMatch(/host: '127\.0\.0\.1'/);
    expect(proxy).not.toMatch(/Access-Control-Allow-Origin/);
    expect(read('electron/preload.cjs')).toMatch(/samWorkerSeparate/);
  });

  test('preload exposes only invoke wrappers', () => {
    const src = read('electron/preload.cjs');
    expect(src).toMatch(/samWorkerStatus/);
    expect(src).toMatch(/samWorkerStart/);
    expect(src).toMatch(/contextBridge\.exposeInMainWorld\('vipDesktop'/);
    expect(src).not.toMatch(/child_process/);
    expect(src).not.toMatch(/spawn\(/);
  });

  test('main binds worker to 127.0.0.1 only', () => {
    const src = read('electron/main.cjs');
    expect(src).toMatch(/127\.0\.0\.1/);
    expect(src).toMatch(/services.*sam-audio.*server\.py/);
    expect(src).toMatch(/contextIsolation:\s*true/);
    expect(src).toMatch(/nodeIntegration:\s*false/);
    expect(src).toMatch(/sandbox:\s*true/);
  });

  test('main production defaults require real SAM', () => {
    const src = read('electron/main.cjs');
    expect(src).toMatch(/SAM_AUDIO_PRODUCTION.*\|\|\s*['"]1['"]/);
    expect(src).toMatch(/SAM_AUDIO_ALLOW_MOCK.*\|\|\s*['"]0['"]/);
    expect(src).toMatch(/resolveFfmpegSharedBin|VIP_FFMPEG_SHARED_BIN/);
  });

  test('no shell exec from renderer-facing surfaces', () => {
    const preload = read('electron/preload.cjs');
    expect(preload).not.toMatch(/exec\(/);
    expect(preload).not.toMatch(/execFile/);
  });
});
