/**
 * Browser + Android latency / wiring guards for ML + worklets.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const host = fs.readFileSync(path.join(ROOT, 'src/pipeline/MLWorkerHost.js'), 'utf8');
const mixer = fs.readFileSync(path.join(ROOT, 'src/pipeline/PlaybackMixer.js'), 'utf8');
const mlWorker = fs.readFileSync(path.join(ROOT, 'src/workers/MLWorker.js'), 'utf8');
const mainJava = fs.readFileSync(
  path.join(ROOT, 'android/app/src/main/java/com/voiceisolatepro/app/MainActivity.java'),
  'utf8',
);
const cap = fs.readFileSync(path.join(ROOT, 'capacitor.config.json'), 'utf8');

describe('Cross-platform ML worker URL', () => {
  test('resolves Worker URL from location (Capacitor/Electron safe)', () => {
    expect(host).toContain('resolveWorkerUrl');
    expect(host).toContain('/src/workers/MLWorker.js');
    expect(host).toMatch(/new Worker\(workerUrl/);
  });

  test('wasm paths stay same-origin /lib/', () => {
    expect(mlWorker).toMatch(/wasmPaths\s*=\s*['"]\/lib\//);
  });
});

describe('Android COOP/COEP + MIME for low-latency workers', () => {
  test('MainActivity injects isolation headers', () => {
    expect(mainJava).toContain('Cross-Origin-Opener-Policy');
    expect(mainJava).toContain('Cross-Origin-Embedder-Policy');
    expect(mainJava).toContain('require-corp');
  });

  test('serves JS/WASM with correct MIME (worklet + ORT)', () => {
    expect(mainJava).toContain('mimeTypeForAsset');
    expect(mainJava).toContain('application/javascript');
    expect(mainJava).toContain('application/wasm');
  });

  test('Capacitor webDir is build/ with https scheme', () => {
    const cfg = JSON.parse(cap);
    expect(cfg.webDir).toBe('build');
    expect(cfg.server?.androidScheme).toBe('https');
  });
});

describe('Playback worklets multi-platform', () => {
  test('worklet URL candidates cover Capacitor relative roots', () => {
    expect(mixer).toContain('workletUrlCandidates');
    expect(mixer).toContain('resolveWorkletUrl');
  });
});
