/**
 * Isolation providers + SAM policy (Option B).
 */
'use strict';

let providers;
let prompted;

beforeAll(async () => {
  providers = await import('../src/core/providers/index.js');
  prompted = await import('../src/pipeline/PromptedIsolation.js');
});

describe('BrowserSamAudioProvider', () => {
  test('is never available without verified export', async () => {
    const p = new providers.BrowserSamAudioProvider();
    const caps = await p.getCapabilities();
    expect(caps.available).toBe(false);
    expect(caps.browserSam).toBe(false);
    expect(caps.reasons.join(' ')).toMatch(/no-verified/);
    await expect(p.isolate({})).rejects.toThrow(/not available/i);
  });
});

describe('assertLoopbackBaseUrl', () => {
  test('allows 127.0.0.1', () => {
    expect(providers.assertLoopbackBaseUrl('http://127.0.0.1:8765').hostname).toBe('127.0.0.1');
  });
  test('rejects public hosts', () => {
    expect(() => providers.assertLoopbackBaseUrl('https://api.example.com')).toThrow(/non-loopback/);
  });
});

describe('float32 base64 roundtrip', () => {
  test('preserves samples', () => {
    const x = new Float32Array([0, 0.5, -0.25, 1]);
    const b64 = providers.float32ToBase64(x);
    const y = providers.base64ToFloat32(b64);
    expect(y.length).toBe(4);
    for (let i = 0; i < 4; i++) expect(y[i]).toBeCloseTo(x[i], 5);
  });
});

describe('ExistingOnnxProvider + USM', () => {
  test('query path returns target and residual', async () => {
    const p = new providers.ExistingOnnxProvider({
      usmFn: (pcm, sr, cfg) => {
        expect(cfg.mode).toBe('query');
        return {
          method: 'query-prior',
          sources: [
            { label: 'speech', pcm: new Float32Array(pcm), mask: new Float32Array(1) },
            { label: 'residual / other', pcm: new Float32Array(pcm.length), mask: new Float32Array(1) },
          ],
        };
      },
    });
    const audio = new Float32Array(2048);
    for (let i = 0; i < audio.length; i++) audio[i] = Math.sin(i / 20) * 0.2;
    const out = await p.isolate({
      audio,
      sampleRate: 48000,
      prompt: 'person speaking',
      processingMode: 'creator',
      output: 'both',
    });
    expect(out.provider).toBe('onnx-local');
    expect(out.target.length).toBe(audio.length);
    expect(out.residual.length).toBe(audio.length);
  });

  test('rejects live mode', async () => {
    const p = new providers.ExistingOnnxProvider();
    await expect(
      p.isolate({ audio: new Float32Array(16), sampleRate: 48000, processingMode: 'live' }),
    ).rejects.toThrow(/live/i);
  });
});

describe('selectIsolationProvider', () => {
  test('disabled → onnx', async () => {
    const sel = await providers.selectIsolationProvider({ samMode: 'disabled' });
    expect(sel.provider.id).toBe('onnx-local');
    expect(sel.reason).toBe('sam-disabled');
  });

  test('browser mode falls back to onnx', async () => {
    const sel = await providers.selectIsolationProvider({ samMode: 'browser' });
    expect(sel.provider.id).toBe('onnx-local');
    expect(sel.fallback).toBe(true);
  });

  test('android auto defaults onnx', async () => {
    const sel = await providers.selectIsolationProvider({
      samMode: 'auto',
      isAndroid: true,
      fetchImpl: async () => ({ ok: false }),
    });
    expect(sel.provider.id).toBe('onnx-local');
  });
});

describe('LocalSamAudioWorkerProvider mock fetch', () => {
  test('isolate against mock worker', async () => {
    const audio = new Float32Array(256);
    for (let i = 0; i < audio.length; i++) audio[i] = 0.1;
    const targetB64 = providers.float32ToBase64(audio);
    const residualB64 = providers.float32ToBase64(new Float32Array(audio.length));
    const fetchImpl = async (url, init) => {
      if (String(url).endsWith('/capabilities')) {
        return {
          ok: true,
          json: async () => ({ available: true, mock: true, backends: ['sam-audio-worker'] }),
        };
      }
      if (String(url).endsWith('/separate')) {
        expect(init.method).toBe('POST');
        return {
          ok: true,
          json: async () => ({
            sampleRate: 48000,
            mock: true,
            targetBase64: targetB64,
            residualBase64: residualB64,
          }),
        };
      }
      throw new Error('unexpected ' + url);
    };
    const p = new providers.LocalSamAudioWorkerProvider({
      baseUrl: 'http://127.0.0.1:8765',
      fetchImpl,
    });
    const caps = await p.getCapabilities();
    expect(caps.available).toBe(true);
    const out = await p.isolate({
      audio,
      sampleRate: 48000,
      prompt: 'man speaking',
      processingMode: 'forensic',
      output: 'both',
    });
    expect(out.provider).toBe('sam-local-worker');
    expect(out.target.length).toBe(256);
  });
});

describe('runPromptedIsolation', () => {
  test('uses USM path without network', async () => {
    const audio = new Float32Array(8192);
    for (let i = 0; i < audio.length; i++) {
      audio[i] = 0.2 * Math.sin((2 * Math.PI * 220 * i) / 16000);
    }
    const out = await prompted.runPromptedIsolation({
      audio,
      sampleRate: 16000,
      prompt: 'speech',
      processingMode: 'creator',
      samMode: 'disabled',
    });
    expect(out.providerId).toBe('onnx-local');
    expect(out.target).toBeTruthy();
  });
});
