/**
 * Architecture v26 modules — research, schema, ORT status, benchmarks.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

describe('Architecture v26 documentation', () => {
  test('architecture summary exists', () => {
    const p = path.join(ROOT, 'docs/VoiceIsolate_Pro_Architecture_v26.md');
    expect(fs.existsSync(p)).toBe(true);
    const text = fs.readFileSync(p, 'utf8');
    expect(text).toContain('Stem-Split');
    expect(text).toMatch(/single STFT|Single STFT|one forward STFT/i);
    expect(text).toContain('WebGPU');
    expect(text).toContain('100% local');
  });

  test('technical whitepaper exists', () => {
    const p = path.join(ROOT, 'docs/VoiceIsolate_Pro_Technical_Whitepaper.md');
    expect(fs.existsSync(p)).toBe(true);
    const text = fs.readFileSync(p, 'utf8');
    expect(text).toContain('Live-Mix');
    expect(text).toContain('Research Mode');
  });

  test('docs README links architecture v26', () => {
    const text = fs.readFileSync(path.join(ROOT, 'docs/README.md'), 'utf8');
    expect(text).toContain('VoiceIsolate_Pro_Architecture_v26.md');
    expect(text).toContain('VoiceIsolate_Pro_Technical_Whitepaper.md');
  });
});

describe('Research / schema / ORT / benchmark modules', () => {
  test('core modules exist', () => {
    for (const rel of [
      'src/core/ParameterSchema.js',
      'src/core/ResearchSession.js',
      'src/core/OrtStatus.js',
      'src/pipeline/BenchmarkHarness.js',
      'public/app/research-mode.js',
    ]) {
      expect(fs.existsSync(path.join(ROOT, rel))).toBe(true);
    }
  });

  test('ParameterSchema exports PARAMETER_SCHEMA array', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/core/ParameterSchema.js'), 'utf8');
    expect(src).toContain('export const PARAMETER_SCHEMA');
    expect(src).toContain('snapshotParams');
    expect(src).toContain('realtimeParamIds');
  });

  test('ResearchSession is local-only export', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/core/ResearchSession.js'), 'utf8');
    expect(src).toContain('toBlob');
    expect(src).toContain('download');
    expect(src).toContain('noCloudInference');
    expect(src).not.toContain('fetch(');
  });

  test('OrtStatus tracks webgpu and wasm', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/core/OrtStatus.js'), 'utf8');
    expect(src).toContain('webgpu');
    expect(src).toContain('wasm');
    expect(src).toContain('applyMlWorkerMessage');
  });

  test('MLWorkerHost wires OrtStatus', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/pipeline/MLWorkerHost.js'), 'utf8');
    expect(src).toContain('applyMlWorkerMessage');
    expect(src).toContain("setOrtStatus({ provider: 'probing'");
  });

  test('Engineer index loads research-mode.js', () => {
    const html = fs.readFileSync(path.join(ROOT, 'public/app/index.html'), 'utf8');
    expect(html).toContain('research-mode.js');
    expect(html).toContain('engOrtPill');
  });

  test('Landing exposes ORT provider hint', () => {
    const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
    expect(html).toContain('ortProviderHint');
  });
});

describe('Single-pass + local constraints (structural)', () => {
  test('dsp-processor documents single STFT/iSTFT and no ORT in process', () => {
    const src = fs.readFileSync(path.join(ROOT, 'public/app/dsp-processor.js'), 'utf8');
    expect(src).toMatch(/single.*STFT|ONE forward FFT/i);
    expect(src).toMatch(/inverse FFT|iSTFT/i);
    expect(src).not.toMatch(/InferenceSession/);
  });

  test('architecture doc forbids live mic', () => {
    const text = fs.readFileSync(path.join(ROOT, 'docs/VoiceIsolate_Pro_Architecture_v26.md'), 'utf8');
    expect(text).toMatch(/No live microphone|upload-only/i);
  });
});
