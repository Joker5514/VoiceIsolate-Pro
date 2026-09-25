'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  authDomain, isAppUrl, isSafeExternalUrl, isAllowedAuthPopup, isAllowedAuthNavigation, resolveInside, resolveInsideReal,
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

  test('auth popups open only on the app auth domain or Google accounts', () => {
    expect(isAllowedAuthPopup('https://accounts.google.com/o/oauth2')).toBe(true);
    expect(isAllowedAuthPopup('https://voiceisolate-pro.firebaseapp.com/__/auth/handler')).toBe(true);
    expect(isAllowedAuthPopup('http://accounts.google.com/')).toBe(false);
    expect(isAllowedAuthPopup('https://google.com.evil.example/')).toBe(false);
    // Anyone can publish to another Firebase project or a user-content host.
    expect(isAllowedAuthPopup('https://attacker.firebaseapp.com/')).toBe(false);
    expect(isAllowedAuthPopup('https://x.googleusercontent.com/')).toBe(false);
  });

  test('the auth domain comes from main-process config, validated, with a safe default', () => {
    const saved = process.env.VIP_FIREBASE_AUTH_DOMAIN;
    try {
      delete process.env.VIP_FIREBASE_AUTH_DOMAIN;
      expect(authDomain()).toBe('voiceisolate-pro.firebaseapp.com');
      process.env.VIP_FIREBASE_AUTH_DOMAIN = 'Custom-App.firebaseapp.com';
      expect(authDomain()).toBe('custom-app.firebaseapp.com');
      expect(isAllowedAuthPopup('https://custom-app.firebaseapp.com/__/auth/handler')).toBe(true);
      expect(isAllowedAuthPopup('https://voiceisolate-pro.firebaseapp.com/__/auth/handler')).toBe(false);
      for (const bad of ['https://evil.example', 'evil.example/path', 'a b.com', '']) {
        process.env.VIP_FIREBASE_AUTH_DOMAIN = bad;
        expect(authDomain()).toBe('voiceisolate-pro.firebaseapp.com');
      }
    } finally {
      if (saved === undefined) delete process.env.VIP_FIREBASE_AUTH_DOMAIN;
      else process.env.VIP_FIREBASE_AUTH_DOMAIN = saved;
    }
  });

  test('main hands the auth domain to the preload and the renderer prefers it', () => {
    const main = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
    const preload = fs.readFileSync(path.join(__dirname, '../electron/preload.cjs'), 'utf8');
    const firebase = fs.readFileSync(path.join(__dirname, '../public/app/firebase-config.js'), 'utf8');
    expect(main).toContain('additionalArguments: [`--vip-firebase-auth-domain=${authDomain()}`]');
    expect(preload).toContain("const AUTH_DOMAIN_ARG = '--vip-firebase-auth-domain=';");
    expect(preload).toMatch(/const vipDesktop = Object\.freeze\(\{[\s\S]*?firebaseAuthDomain,/);
    expect(firebase).toContain('authDomain: window.vipDesktop?.firebaseAuthDomain || window.FIREBASE_AUTH_DOMAIN');
  });

  test('an open auth popup may only move within the OAuth flow', () => {
    expect(isAllowedAuthNavigation('https://accounts.google.com/signin')).toBe(true);
    expect(isAllowedAuthNavigation('https://voiceisolate-pro.firebaseapp.com/__/auth/handler')).toBe(true);
    expect(isAllowedAuthNavigation('https://evil.example/')).toBe(false);
    expect(isAllowedAuthNavigation('http://accounts.google.com/')).toBe(false);
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

describe('Electron model cache symlinks', () => {
  const fsp = fs.promises;
  let root;
  let cache;
  let outside;

  beforeAll(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'vip-cache-'));
    cache = path.join(root, 'models');
    outside = path.join(root, 'outside');
    await fsp.mkdir(cache);
    await fsp.mkdir(outside);
    await fsp.writeFile(path.join(outside, 'secret'), 'x');
    await fsp.symlink(outside, path.join(cache, 'link'), 'dir');
    await fsp.symlink(path.join(outside, 'secret'), path.join(cache, 'file-link'));
  });

  afterAll(() => fsp.rm(root, { recursive: true, force: true }));

  test('paths inside the canonical cache resolve, including new files', async () => {
    expect(await resolveInsideReal(fsp, cache, 'bsrnn/model.onnx')).toBe(path.join(cache, 'bsrnn', 'model.onnx'));
  });

  test('a symlinked directory or file cannot redirect reads or writes outside', async () => {
    expect(await resolveInsideReal(fsp, cache, 'link/secret')).toBeNull();
    expect(await resolveInsideReal(fsp, cache, 'link/new-file')).toBeNull();
    expect(await resolveInsideReal(fsp, cache, 'file-link')).toBeNull();
    expect(await resolveInsideReal(fsp, cache, '../outside/secret')).toBeNull();
  });
});

describe('Electron main process wiring', () => {
  const main = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');

  test('every IPC handler goes through the trusted-sender wrapper bound to the main frame', () => {
    expect(main.match(/ipcMain\.handle\(/g)).toHaveLength(1);
    const wrapper = main.match(/function handleTrusted\(channel, fn\) \{[\s\S]*?\n\}/)[0];
    expect(wrapper).toContain('evt.sender === mainWindow.webContents');
    expect(wrapper).toContain('evt.senderFrame === evt.sender.mainFrame');
    expect(wrapper).toMatch(/!fromMainFrame \|\| !isAppUrl\(senderUrl/);
  });

  test('the main window cannot navigate or be redirected off the app origin', () => {
    expect(main).toMatch(/const keepOnAppOrigin = \(event, url\) => \{\s*if \(isAppUrl\(url[^\n]*\) return;\s*event\.preventDefault\(\);/);
    expect(main).toContain("mainWindow.webContents.on('will-navigate', keepOnAppOrigin)");
    expect(main).toContain("mainWindow.webContents.on('will-redirect', keepOnAppOrigin)");
  });

  test('auth popups are locked to the OAuth flow and cannot open windows', () => {
    expect(main).toContain("popup.webContents.on('will-navigate', keepOnAuthFlow)");
    expect(main).toContain("popup.webContents.on('will-redirect', keepOnAuthFlow)");
    expect(main).toContain("popup.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))");
  });

  test('every shell.openExternal call is directly guarded by the scheme allowlist', () => {
    const calls = main.match(/shell\.openExternal\(/g) || [];
    const guarded = main.match(/if \(isSafeExternalUrl\((\w+)\)\) shell\.openExternal\(\1\);/g) || [];
    expect(calls.length).toBeGreaterThan(0);
    expect(guarded).toHaveLength(calls.length);
  });

  test('model-cache IPC resolves paths through the symlink-aware resolver', () => {
    expect(main).not.toMatch(/[^.\w]resolveInside\(/);
    expect(main.match(/resolveInsideReal\(fs, /g).length).toBeGreaterThanOrEqual(3);
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
