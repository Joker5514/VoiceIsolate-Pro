/**
 * Engineer cockpit pills — CTX / WORKLET / GATE / DEESS / SAB / ML / ORT / NET
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public/app/index.html'), 'utf8');
const boot = fs.readFileSync(path.join(ROOT, 'public/app/vip-boot.js'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'public/app/app.js'), 'utf8');
const host = fs.readFileSync(path.join(ROOT, 'src/pipeline/MLWorkerHost.js'), 'utf8');

const PILL_IDS = [
  'engCtxPill',
  'engWorkletPill',
  'engGatePill',
  'engDeessPill',
  'engSabPill',
  'engMlPill',
  'engOrtPill',
  'engNetPill',
];

describe('Engine pill markup', () => {
  test.each(PILL_IDS)('HTML defines #%s', (id) => {
    expect(html).toContain(`id="${id}"`);
  });
});

describe('vip-boot pill driver', () => {
  test('drives all eight cockpit pills', () => {
    for (const id of PILL_IDS) {
      expect(boot).toContain(`'${id}'`);
    }
  });

  test('reads live gate/deess status from bridge or diagnostics', () => {
    expect(boot).toContain('readPlaybackWorkletStatus');
    expect(boot).toContain('getWorkletStatus');
    expect(boot).toContain('__vipWorkletStatus');
  });

  test('does not abandon worklet pills after 30s', () => {
    // Old driver cleared after 30000ms without resolving GATE/DEESS
    expect(boot).not.toMatch(/TIMEOUT\s*=\s*30000/);
    expect(boot).toContain('MAX_TICKS');
  });

  test('maps loaded → ready for worklets', () => {
    expect(boot).toContain("if (s === 'loaded') return 'ready'");
  });
});

describe('app.js + MLWorkerHost pill hooks', () => {
  test('ensureCtx paints CTX and worklet loading then ready', () => {
    expect(app).toContain("pill('engCtxPill', 'ready')");
    expect(app).toContain("pill('engWorkletPill', 'loading')");
    expect(app).toContain("pill('engGatePill'");
    expect(app).toContain("pill('engDeessPill'");
    expect(app).toContain("pill('engSabPill'");
  });

  test('unlocks audio on pointer/touch as well as click', () => {
    expect(app).toContain("addEventListener('pointerdown'");
    expect(app).toContain("addEventListener('touchstart'");
  });

  test('MLWorker ready message updates ORT + ML pills', () => {
    expect(host).toContain("setPill('engOrtPill'");
    expect(host).toContain("setPill('engMlPill', 'ready')");
    expect(host).toContain("msg.type === 'ready'");
  });

  test('exposes visible WebGPU/WASM backend label and model chain', () => {
    expect(html).toContain('id="ortBackendLabel"');
    expect(html).toContain('id="activeModelChain"');
    expect(host).toContain('WebGPU');
    expect(host).toContain('WASM');
    expect(host).toContain('activeModelChain');
  });
});

