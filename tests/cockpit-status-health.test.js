/**
 * Cockpit pills + Local Model Health — regression guards.
 * Ready must not look like error; ModelCDNLoader must load; worklet URLs resolve.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(ROOT, 'public/app/style.css'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'public/app/index.html'), 'utf8');
const loader = fs.readFileSync(path.join(ROOT, 'public/app/model-cdn-loader.js'), 'utf8');
const statusUi = fs.readFileSync(path.join(ROOT, 'public/app/model-status-ui.js'), 'utf8');
const mixer = fs.readFileSync(path.join(ROOT, 'src/pipeline/PlaybackMixer.js'), 'utf8');
const workletStatus = fs.readFileSync(path.join(ROOT, 'src/presentation/WorkletStatus.js'), 'utf8');

describe('Engine pill ready styling', () => {
  test('ready state is cyan/green, not error red', () => {
    // Historical bug: data-state=ready used color:#ff1111 (looked broken)
    const readyRule = css.match(/\.engine-pill\[data-state="ready"\]\{[^}]+\}/);
    expect(readyRule).toBeTruthy();
    expect(readyRule[0]).not.toMatch(/color:\s*#ff1111/i);
    expect(readyRule[0]).not.toMatch(/color:\s*#ef4444/i);
    expect(readyRule[0]).toMatch(/color:\s*#00ffe7/i);
  });

  test('error state remains distinct red', () => {
    const errorRule = css.match(/\.engine-pill\[data-state="error"\]\{[^}]+\}/);
    expect(errorRule).toBeTruthy();
    expect(errorRule[0]).toMatch(/#ef4444/);
  });
});

describe('ModelCDNLoader wiring', () => {
  test('index.html loads model-cdn-loader.js before app modules', () => {
    expect(html).toMatch(/src=["']\.\/model-cdn-loader\.js["']/);
    const loaderIdx = html.indexOf('model-cdn-loader.js');
    const appIdx = html.indexOf("import('./app.js')");
    expect(loaderIdx).toBeGreaterThan(-1);
    expect(appIdx).toBeGreaterThan(loaderIdx);
  });

  test('loader exposes probeSameOriginHealth + getProviderHealthReport', () => {
    expect(loader).toContain('probeSameOriginHealth');
    expect(loader).toContain('getProviderHealthReport');
    expect(loader).toContain("providerHealth['same-origin']");
  });

  test('ModelStatusUI probes when health is unknown', () => {
    expect(statusUi).toContain('probeSameOriginHealth');
    expect(statusUi).toContain('probing…');
  });
});

describe('Playback worklet URL resolution', () => {
  test('resolveWorkletUrl uses location.href base (Electron vip:// safe)', () => {
    expect(mixer).toContain('export function resolveWorkletUrl');
    expect(mixer).toContain('location?.href');
    expect(mixer).toMatch(/vip:/);
  });

  test('workletUrlCandidates tries multiple paths for Capacitor/Electron', () => {
    expect(mixer).toContain('export function workletUrlCandidates');
    expect(mixer).toContain('ensureWorkletModule');
    expect(mixer).toMatch(/workletUrlCandidates\(path\)/);
  });

  test('gate/deess publish __vipWorkletStatus for cockpit drivers', () => {
    expect(mixer).toContain('__vipWorkletStatus');
    expect(workletStatus).toContain('__vipWorkletStatus');
    expect(workletStatus).toContain('startWorkletStatusDriver');
  });
});
