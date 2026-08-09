'use strict';

/**
 * Android WebView: SharedArrayBuffer / COOP-COEP must not block the app.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const boot = fs.readFileSync(path.join(ROOT, 'public/app/vip-boot.js'), 'utf8');
const mainActivity = fs.readFileSync(
  path.join(ROOT, 'android/app/src/main/java/com/voiceisolatepro/app/MainActivity.java'),
  'utf8'
);
const mlWorker = fs.readFileSync(path.join(ROOT, 'src/workers/MLWorker.js'), 'utf8');

describe('Android SAB / COOP-COEP non-blocking policy', () => {
  test('vip-boot does not treat missing SAB as a fatal startup banner', () => {
    // Banner must not be the only reaction to !hasSAB()
    expect(boot).toContain('NOT FATAL');
    expect(boot).toMatch(/SharedArrayBuffer[\s\S]{0,200}NOT FATAL|NOT FATAL[\s\S]{0,400}SharedArrayBuffer/i);
    // Must not call showBanner for the SAB case with the old COOP hard-reload copy
    expect(boot).not.toMatch(
      /if\s*\(\s*!hasSAB\(\)\s*\)\s*\{\s*showBanner\([\s\S]*SharedArrayBuffer unavailable/
    );
    expect(boot).toContain('isAndroidWebViewShell');
    expect(boot).toContain("setEnginePill('engSabPill', sabOk ? 'ready' : 'unavailable')");
  });

  test('MainActivity injects COOP/COEP and reloads after client install', () => {
    expect(mainActivity).toContain('Cross-Origin-Opener-Policy');
    expect(mainActivity).toContain('Cross-Origin-Embedder-Policy');
    expect(mainActivity).toContain('webView.reload()');
  });

  test('MLWorker forces single-thread WASM when SAB is unavailable', () => {
    expect(mlWorker).toContain('SharedArrayBuffer');
    expect(mlWorker).toContain('numThreads = 1');
    expect(mlWorker).toContain('crossOriginIsolated');
  });
});
