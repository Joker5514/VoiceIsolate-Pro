/**
 * Diarization model presence probe (Engineer Console session, Nov 17).
 *
 * The three diarization models are committed under public/models/ and served
 * as same-origin static files (and, locally, by server.js static middleware).
 * A HEAD may include Content-Length, or it may omit it on a compressed or
 * chunked path. The old probe required Content-Length > 100 000, so every
 * pass logged "Diarization ONNX models not available locally" and never tried
 * to load models that were there. A missing length is unknown, not missing.
 */
'use strict';

let mod;
const realFetch = globalThis.fetch;

function headResponse(status, headers = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (name.toLowerCase() in lower ? lower[name.toLowerCase()] : null) },
  };
}

function tone() {
  const samples = new Float32Array(48000);
  for (let i = 0; i < samples.length; i++) samples[i] = 0.25 * Math.sin((2 * Math.PI * 180 * i) / 48000);
  return samples;
}

beforeAll(async () => {
  mod = await import('../src/pipeline/SpeakerDetection.js');
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete globalThis.ort;
  delete globalThis.VIP_liveDiagnostics;
  delete globalThis.VIP_ONNX_DIARIZATION;
  mod.__resetDiarizationModelStateForTests?.();
});

describe('diarization model probe', () => {
  test('names the exact model files and URLs it probes', () => {
    expect(mod.DIARIZATION_MODEL_URLS).toEqual({
      segmentation: '/models/pyannote-segmentation-3.0.onnx',
      embedding: '/models/wespeaker-resnet34.onnx',
      vad: '/models/silero-vad.onnx',
    });
  });

  test('HEAD 200 without Content-Length (Brotli edge / chunked proxy) counts as present', async () => {
    globalThis.fetch = jest.fn(async () => headResponse(200, { 'content-encoding': 'br', 'content-type': 'application/octet-stream' }));
    const probe = await mod.probeDiarizationModels();
    expect(probe.ok).toBe(true);
    expect(probe.models.map((m) => m.verdict)).toEqual(['present-unsized', 'present-unsized', 'present-unsized']);
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    for (const [url, init] of globalThis.fetch.mock.calls) {
      expect(url).toMatch(/^\/models\/.+\.onnx$/);
      expect(init).toMatchObject({ method: 'HEAD' });
      // A Range probe through the Vercel rewrite was cached at the edge and
      // replayed to later full GETs. The probe must never send one.
      expect(init.headers?.Range || init.headers?.range).toBeUndefined();
    }
  });

  test('a missing model is reported by file, URL and HTTP status', async () => {
    globalThis.fetch = jest.fn(async (url) => (url.includes('wespeaker')
      ? headResponse(404, { 'content-length': 15 })
      : headResponse(200, { 'content-length': 5986908 })));
    const probe = await mod.probeDiarizationModels();
    expect(probe.ok).toBe(false);
    const emb = probe.models.find((m) => m.role === 'embedding');
    expect(emb).toMatchObject({ file: 'wespeaker-resnet34.onnx', url: '/models/wespeaker-resnet34.onnx', status: 404, verdict: 'missing' });
    expect(probe.summary).toBe('wespeaker-resnet34.onnx (/models/wespeaker-resnet34.onnx: HTTP 404)');
  });

  test('a small file with a real length is a stub, not a model', async () => {
    globalThis.fetch = jest.fn(async () => headResponse(200, { 'content-length': 134 }));
    const probe = await mod.probeDiarizationModels();
    expect(probe.ok).toBe(false);
    expect(probe.models.every((m) => m.verdict === 'stub')).toBe(true);
    expect(probe.summary).toMatch(/pyannote-segmentation-3\.0\.onnx \(\/models\/pyannote-segmentation-3\.0\.onnx: 134 bytes, stub\)/);
  });

  test('a network error is reported as unreachable', async () => {
    globalThis.fetch = jest.fn(async () => { throw new TypeError('Failed to fetch'); });
    const probe = await mod.probeDiarizationModels();
    expect(probe.ok).toBe(false);
    expect(probe.models.every((m) => m.verdict === 'unreachable')).toBe(true);
    expect(probe.summary).toMatch(/silero-vad\.onnx \(\/models\/silero-vad\.onnx: unreachable: Failed to fetch\)/);
  });
});

describe('detectSpeakers with the probe', () => {
  test('default: reachable models are probed, not downloaded, and the log says the diarizer is off', async () => {
    globalThis.fetch = jest.fn(async () => headResponse(200, { 'content-encoding': 'br' }));
    const create = jest.fn(async () => ({ release: async () => {} }));
    globalThis.ort = { InferenceSession: { create }, env: { wasm: {} } };
    const diag = [];
    globalThis.VIP_liveDiagnostics = { log: (level, event, detail) => diag.push({ level, event, detail }) };
    const result = await mod.detectSpeakers([tone()], 48000);
    expect(create).not.toHaveBeenCalled();
    expect(result.method).toBe('kmeans');
    const unavailable = diag.find((d) => d.event === 'speaker.onnx-unavailable');
    expect(unavailable.detail.code).toBe('onnx-diarizer-disabled');
    expect(unavailable.detail.reason).toBe('ONNX diarizer is off by default (models reachable 3/3; opt in with localStorage vip-onnx-diarization=1)');
    expect(unavailable.detail.models.map((m) => m.file)).toEqual([
      'pyannote-segmentation-3.0.onnx', 'wespeaker-resnet34.onnx', 'silero-vad.onnx',
    ]);
  }, 15000);

  test('opt-in: unsized HEAD responses go on to create the three sessions', async () => {
    globalThis.VIP_ONNX_DIARIZATION = true;
    globalThis.fetch = jest.fn(async () => headResponse(200, { 'content-encoding': 'br' }));
    const create = jest.fn(async () => ({ release: async () => {} }));
    globalThis.ort = { InferenceSession: { create }, env: { wasm: {} } };
    const diag = [];
    globalThis.VIP_liveDiagnostics = { log: (level, event, detail) => diag.push({ level, event, detail }) };
    const result = await mod.detectSpeakers([tone()], 48000);
    const urls = create.mock.calls.map(([src]) => src).sort();
    expect(urls).toEqual([
      '/models/pyannote-segmentation-3.0.onnx',
      '/models/silero-vad.onnx',
      '/models/wespeaker-resnet34.onnx',
    ]);
    // Jest cannot import the absolute /app/speaker-diarizer.js, so the run
    // still falls back. The reason must not claim the models are missing.
    expect(result.method).toBe('kmeans');
    expect(String(result.reason)).not.toMatch(/not available locally/);
    const unavailable = diag.find((d) => d.event === 'speaker.onnx-unavailable');
    expect(unavailable.detail.code).not.toBe('models-unavailable');
  }, 15000);

  test('missing models log which files, where, and why', async () => {
    globalThis.VIP_ONNX_DIARIZATION = true;
    globalThis.fetch = jest.fn(async () => headResponse(404, { 'content-length': 15 }));
    const create = jest.fn();
    globalThis.ort = { InferenceSession: { create }, env: { wasm: {} } };
    const diag = [];
    globalThis.VIP_liveDiagnostics = { log: (level, event, detail) => diag.push({ level, event, detail }) };
    const result = await mod.detectSpeakers([tone()], 48000);
    expect(create).not.toHaveBeenCalled();
    expect(result.method).toBe('kmeans');
    const unavailable = diag.find((d) => d.event === 'speaker.onnx-unavailable');
    expect(unavailable.detail.code).toBe('models-unavailable');
    expect(unavailable.detail.reason).toBe(
      'Diarization ONNX models not available: pyannote-segmentation-3.0.onnx (/models/pyannote-segmentation-3.0.onnx: HTTP 404); '
      + 'wespeaker-resnet34.onnx (/models/wespeaker-resnet34.onnx: HTTP 404); silero-vad.onnx (/models/silero-vad.onnx: HTTP 404)',
    );
    expect(unavailable.detail.models).toHaveLength(3);
    expect(unavailable.detail.models[0]).toMatchObject({ file: 'pyannote-segmentation-3.0.onnx', status: 404, verdict: 'missing' });
  }, 15000);

  test('a model that fails to load is named, and is not re-downloaded on every pass', async () => {
    globalThis.VIP_ONNX_DIARIZATION = true;
    globalThis.fetch = jest.fn(async () => headResponse(200, {}));
    const create = jest.fn(async (src) => {
      if (String(src).includes('pyannote')) throw new Error('protobuf parsing failed');
      return { release: async () => {} };
    });
    globalThis.ort = { InferenceSession: { create }, env: { wasm: {} } };
    const diag = [];
    globalThis.VIP_liveDiagnostics = { log: (level, event, detail) => diag.push({ level, event, detail }) };
    await mod.detectSpeakers([tone()], 48000);
    const first = diag.find((d) => d.event === 'speaker.onnx-unavailable');
    expect(first.detail.code).toBe('model-load-failed');
    expect(first.detail.reason).toMatch(/pyannote-segmentation-3\.0\.onnx \(\/models\/pyannote-segmentation-3\.0\.onnx\): protobuf parsing failed/);
    const callsAfterFirst = create.mock.calls.length;
    diag.length = 0;
    await mod.detectSpeakers([tone()], 48000);
    const second = diag.find((d) => d.event === 'speaker.onnx-unavailable');
    expect(second.detail.code).toBe('model-load-failed');
    expect(second.detail.cached).toBe(true);
    expect(create.mock.calls.length).toBe(callsAfterFirst);
  }, 20000);
});

describe('default path with missing models', () => {
  test('names the missing files even when the diarizer is off', async () => {
    globalThis.fetch = jest.fn(async (url) => (url.includes('pyannote')
      ? headResponse(404, { 'content-length': 15 })
      : headResponse(200, { 'content-length': 26535549 })));
    globalThis.ort = { InferenceSession: { create: jest.fn() }, env: { wasm: {} } };
    const diag = [];
    globalThis.VIP_liveDiagnostics = { log: (level, event, detail) => diag.push({ level, event, detail }) };
    await mod.detectSpeakers([tone()], 48000);
    const unavailable = diag.find((d) => d.event === 'speaker.onnx-unavailable');
    expect(unavailable.detail.code).toBe('models-unavailable');
    expect(unavailable.detail.reason).toBe('ONNX diarizer is off by default; models not available: pyannote-segmentation-3.0.onnx (/models/pyannote-segmentation-3.0.onnx: HTTP 404)');
  }, 15000);

  test('opt-in runs are serialised so two passes never share a running session', async () => {
    globalThis.VIP_ONNX_DIARIZATION = true;
    globalThis.fetch = jest.fn(async () => headResponse(200, {}));
    let active = 0;
    let maxActive = 0;
    const create = jest.fn(async () => {
      active += 1; maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 20));
      active -= 1;
      return { release: async () => {} };
    });
    globalThis.ort = { InferenceSession: { create }, env: { wasm: {} } };
    const results = await Promise.all([mod.detectSpeakers([tone()], 48000), mod.detectSpeakers([tone()], 48000)]);
    expect(results.every((r) => r.method === 'kmeans')).toBe(true);
    // Three sessions load in parallel for one pass; the second pass waits.
    expect(maxActive).toBeLessThanOrEqual(3);
    expect(create).toHaveBeenCalledTimes(3);
  }, 20000);
});
