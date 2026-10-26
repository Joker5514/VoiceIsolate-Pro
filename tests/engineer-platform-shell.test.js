/**
 * Web, Android, and Electron ship one Engineer shell.
 * Web serves public/. pnpm build copies public/ to build/.
 * Android webDir and Electron vip:// both read that build/.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const MARKERS = [
  'workstation-premium.css',
  'id="vipMetricGuide"',
  'id="vipStemPath"',
  'id="vipSignalChain"',
];

describe('Engineer shell shared by web, Android, and desktop', () => {
  const html = read('public/app/index.html');
  const consoleJs = read('public/app/engineer-console.js');

  test('web source contains the workflow shell', () => {
    for (const marker of MARKERS) expect(html).toContain(marker);
    for (const id of ["id: 'stems'", "id: 'advanced'", "id: 'engineer'", "id: 'forensic'"]) {
      expect(consoleJs).toContain(id);
    }
    expect(fs.existsSync(path.join(ROOT, 'public/app/workstation-premium.css'))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, 'public/fonts/Geist-Variable.woff2'))).toBe(true);
  });

  test('static build copies that same public tree', () => {
    const build = read('scripts/build.mjs');
    expect(build).toContain('cpRecursive(PUBLIC, BUILD)');
  });

  test('Android packages build/ and requires the new shell files', () => {
    const cap = JSON.parse(read('capacitor.config.json'));
    expect(cap.webDir).toBe('build');
    const prepare = read('scripts/prepare-android-complete.mjs');
    expect(prepare).toContain('app/workstation-premium.css');
    expect(prepare).toContain('fonts/Geist-Variable.woff2');
  });

  test('Electron packages build/ and serves it on vip://', () => {
    const yml = read('electron/electron-builder.yml');
    expect(yml).toContain('build/**/*');
    const main = read('electron/main.cjs');
    expect(main).toContain("mainWindow.loadURL('vip://app/index.html')");
    expect(main).toContain('vip://app/index.html → build/index.html');
    expect(main).toContain("'.woff2': 'font/woff2'");
  });
});
