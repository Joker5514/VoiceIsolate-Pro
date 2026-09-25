'use strict';

const fs = require('fs');
const path = require('path');
const {
  isAppUrl, isSafeExternalUrl, isAllowedAuthPopup, resolveInside,
} = require('../electron/navigation-policy.cjs');

describe('Electron navigation policy', () => {
  test('only the packaged app origin is trusted in production', () => {
    expect(isAppUrl('vip://app/index.html')).toBe(true);
    expect(isAppUrl('vip://app/app/index.html')).toBe(true);
    expect(isAppUrl('vip://other/index.html')).toBe(false);
    expect(isAppUrl('http://localhost:3000/app/')).toBe(false);
    expect(isAppUrl('https://evil.example/')).toBe(false);
    expect(isAppUrl('file:///C:/Windows/System32/calc.exe')).toBe(false);
    expect(isAppUrl('not a url')).toBe(false);
  });

  test('the dev-server origin is trusted only in development', () => {
    const dev = { isDev: true, devUrl: 'http://localhost:3000' };
    expect(isAppUrl('http://localhost:3000/app/', dev)).toBe(true);
    expect(isAppUrl('http://localhost:3001/app/', dev)).toBe(false);
    expect(isAppUrl('http://localhost.evil.example/', dev)).toBe(false);
  });

  test('openExternal is limited to web and mail links', () => {
    expect(isSafeExternalUrl('https://github.com/Joker5514/VoiceIsolate-Pro')).toBe(true);
    expect(isSafeExternalUrl('mailto:support@example.com')).toBe(true);
    for (const url of ['file:///etc/passwd', 'ms-msdt:/id', 'search-ms:query=x', 'javascript:alert(1)', 'smb://host/share', '']) {
      expect(isSafeExternalUrl(url)).toBe(false);
    }
  });

  test('auth popups require https and a Google/Firebase host', () => {
    expect(isAllowedAuthPopup('https://accounts.google.com/o/oauth2')).toBe(true);
    expect(isAllowedAuthPopup('https://vip.firebaseapp.com/__/auth/handler')).toBe(true);
    expect(isAllowedAuthPopup('http://accounts.google.com/')).toBe(false);
    expect(isAllowedAuthPopup('https://google.com.evil.example/')).toBe(false);
  });

  test('model-cache paths cannot escape the cache directory', () => {
    const dir = path.resolve('/tmp/vip-models');
    expect(resolveInside(dir, 'bsrnn/model.onnx')).toBe(path.join(dir, 'bsrnn', 'model.onnx'));
    for (const bad of ['../x', 'a/../../x', '/etc/passwd', 'C:\\Windows\\x', 'C:x', '', null, 42, { includes: () => false }, 'a\0b']) {
      expect(resolveInside(dir, bad)).toBeNull();
    }
    expect(resolveInside(dir, '.')).toBeNull();
  });
});

describe('Electron main process wiring', () => {
  const main = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');

  test('every IPC handler goes through the trusted-sender wrapper', () => {
    expect(main.match(/ipcMain\.handle\(/g)).toHaveLength(1);
    expect(main).toMatch(/function handleTrusted\(channel, fn\)[\s\S]*?isAppUrl\(senderUrl/);
  });

  test('the main window cannot navigate off the app origin', () => {
    expect(main).toMatch(/on\('will-navigate'[\s\S]*?isAppUrl\(url[\s\S]*?event\.preventDefault\(\)/);
  });

  test('shell.openExternal is always guarded by the scheme allowlist', () => {
    const calls = main.match(/[^\n]*shell\.openExternal\([^\n]*/g) || [];
    expect(calls.length).toBeGreaterThan(0);
    for (const line of calls) expect(line).toMatch(/isSafeExternalUrl\(url\)/);
  });
});

describe('Electron sandboxed preload', () => {
  const preload = fs.readFileSync(path.join(__dirname, '../electron/preload.cjs'), 'utf8');

  test('requires nothing but electron (sandboxed preloads cannot load local modules)', () => {
    const requires = [...preload.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    expect(requires).toEqual(['electron']);
  });

  test('inline channel map equals electron/ipc-channels.cjs', () => {
    const { IPC } = require('../electron/ipc-channels.cjs');
    const block = preload.match(/const IPC = Object\.freeze\((\{[\s\S]*?\})\);/)[1];
    const inline = new Function(`return (${block});`)();
    expect(inline).toEqual({ ...IPC });
  });
});
