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

  test('no shell exec from renderer-facing surfaces', () => {
    const preload = read('electron/preload.cjs');
    expect(preload).not.toMatch(/exec\(/);
    expect(preload).not.toMatch(/execFile/);
  });
});
