/**
 * Android complete offline app packaging guards.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const prepare = fs.readFileSync(path.join(ROOT, 'scripts/prepare-android-complete.mjs'), 'utf8');
const verify = fs.readFileSync(path.join(ROOT, 'scripts/verify-android-complete.mjs'), 'utf8');
const winBuild = fs.readFileSync(path.join(ROOT, 'scripts/android-build-win.mjs'), 'utf8');
const gradle = fs.readFileSync(path.join(ROOT, 'android/app/build.gradle'), 'utf8');
const manifest = fs.readFileSync(path.join(ROOT, 'android/app/src/main/AndroidManifest.xml'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const cap = JSON.parse(fs.readFileSync(path.join(ROOT, 'capacitor.config.json'), 'utf8'));
const dl = fs.readFileSync(path.join(ROOT, 'public/download/index.html'), 'utf8');

describe('Android complete app pipeline', () => {
  test('prepare script ships Engineer entry + required models', () => {
    expect(prepare).toContain("location.replace('/app/index.html')");
    expect(prepare).toContain('bsrnn_vocals.onnx');
    expect(prepare).toContain('rnnoise_suppressor.onnx');
    expect(prepare).toContain('silero_vad.onnx');
    expect(prepare).toContain('demucs_v4_fp32.onnx');
    expect(prepare).toMatch(/EXCLUDE_MODELS/);
  });

  test('win + package scripts run prepare + verify', () => {
    expect(winBuild).toContain('prepare-android-complete.mjs');
    expect(winBuild).toContain('verify-android-complete.mjs');
    expect(pkg.scripts['android:prepare']).toContain('prepare-android-complete');
    expect(pkg.scripts['android:verify']).toContain('verify-android-complete');
  });

  test('gradle does not compress onnx/wasm/js', () => {
    expect(gradle).toContain("noCompress");
    expect(gradle).toContain("'onnx'");
    expect(gradle).toContain("'wasm'");
    expect(gradle).toContain("'js'");
  });

  test('manifest largeHeap + storage permission for file pick', () => {
    expect(manifest).toContain('android:largeHeap="true"');
    expect(manifest).toContain('READ_EXTERNAL_STORAGE');
    expect(manifest).toContain('READ_MEDIA_AUDIO');
  });

  test('Capacitor is local-only (no remote server url)', () => {
    expect(cap.webDir).toBe('build');
    expect(cap.server?.url == null || cap.server?.url === '').toBe(true);
    expect(cap.server?.androidScheme).toBe('https');
  });

  test('download page describes complete offline APK', () => {
    expect(dl).toMatch(/complete offline app/i);
    expect(dl).toMatch(/no network required/i);
  });

  test('verify script rejects Google Fonts on entry + missing models', () => {
    expect(verify).toContain('fonts.googleapis.com');
    expect(verify).toContain('bsrnn_vocals.onnx');
    expect(verify).toContain('demucs_v4_fp32.onnx');
  });
});
