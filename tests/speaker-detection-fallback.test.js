/**
 * Speaker detection without a browser document.
 * Node has no document, so the ONNX loader fails immediately and k-means runs inline.
 */
'use strict';

let detectSpeakers;

beforeAll(async () => {
  ({ detectSpeakers } = await import('../src/pipeline/SpeakerDetection.js'));
});

describe('speaker detection does not block enhancement', () => {
  test('missing ONNX returns a degraded k-means result', async () => {
    delete globalThis.ort;
    const samples = new Float32Array(48000);
    for (let i = 0; i < samples.length; i++) samples[i] = 0.25 * Math.sin((2 * Math.PI * 180 * i) / 48000);
    const started = Date.now();
    const result = await detectSpeakers([samples], 48000);
    expect(Date.now() - started).toBeLessThan(8000);
    expect(result.status).toBe('degraded');
    expect(result.method).toBe('kmeans');
    expect(Array.isArray(result.segments)).toBe(true);
    expect(Array.isArray(result.speakers)).toBe(true);
    expect(result.provider).toBe('js-kmeans');
    expect(result.providerVerified).toBe(false);
    expect(String(result.reason)).toMatch(/onnxruntime-web not loaded|not available locally|off by default; models not available/i);
  }, 15000);

  test('cancellation still rejects and does not invent speakers', async () => {
    const signal = new AbortController();
    signal.abort();
    await expect(detectSpeakers([new Float32Array(4800)], 16000, { signal: signal.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
  });
});
