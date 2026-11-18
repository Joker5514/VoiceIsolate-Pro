/**
 * Live test t24u: from the browser, HEAD /models/{pyannote,wespeaker,silero-vad}
 * returned HTTP 403 and the probe said "missing". A 403 (or 401/405/429/5xx)
 * proves only that the HEAD was refused, not that the file is absent. Such
 * responses are "unverified" with the status code; 404/410 stay "missing".
 */
'use strict';

let mod;
const realFetch = globalThis.fetch;

function headResponse(status, headers = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return { ok: status >= 200 && status < 300, status, headers: { get: (n) => lower[n.toLowerCase()] ?? null } };
}
function tone() {
  const s = new Float32Array(48000);
  for (let i = 0; i < s.length; i++) s[i] = 0.25 * Math.sin((2 * Math.PI * 180 * i) / 48000);
  return s;
}

beforeAll(async () => { mod = await import('../src/pipeline/SpeakerDetection.js'); });
afterEach(() => {
  globalThis.fetch = realFetch;
  delete globalThis.ort;
  delete globalThis.VIP_liveDiagnostics;
  delete globalThis.VIP_ONNX_DIARIZATION;
  mod.__resetDiarizationModelStateForTests?.();
});

describe('non-2xx HEAD that is not 404/410', () => {
  test.each([401, 403, 405, 429, 500, 503])('HTTP %i is unverified with its status, not missing', async (code) => {
    globalThis.fetch = jest.fn(async () => headResponse(code, { 'content-length': 0 }));
    const probe = await mod.probeDiarizationModels();
    expect(probe.ok).toBe(false);
    for (const m of probe.models) expect(m).toMatchObject({ status: code, verdict: 'unverified' });
    expect(probe.summary).toContain(`HTTP ${code}`);
    expect(probe.summary).toMatch(/unverified/);
    expect(probe.summary).not.toMatch(/missing/);
  });

  test.each([404, 410])('HTTP %i stays missing', async (code) => {
    globalThis.fetch = jest.fn(async () => headResponse(code, {}));
    const probe = await mod.probeDiarizationModels();
    for (const m of probe.models) expect(m).toMatchObject({ status: code, verdict: 'missing' });
  });

  test('default path logs "unverified" with the code, not "not available"', async () => {
    globalThis.fetch = jest.fn(async () => headResponse(403, {}));
    globalThis.ort = { InferenceSession: { create: jest.fn() }, env: { wasm: {} } };
    const diag = [];
    globalThis.VIP_liveDiagnostics = { log: (level, event, detail) => diag.push({ level, event, detail }) };
    const res = await mod.detectSpeakers([tone()], 48000);
    expect(res.method).toBe('kmeans');
    const d = diag.find((x) => x.event === 'speaker.onnx-unavailable');
    expect(d.detail.code).toBe('models-unverified');
    expect(d.detail.reason).toMatch(/unverified/);
    expect(d.detail.reason).toContain('pyannote-segmentation-3.0.onnx (/models/pyannote-segmentation-3.0.onnx: HTTP 403, unverified)');
    expect(d.detail.reason).not.toMatch(/not available|missing/);
  }, 15000);

  test('opt-in: a refused HEAD does not block the load; the GET decides', async () => {
    globalThis.VIP_ONNX_DIARIZATION = true;
    globalThis.fetch = jest.fn(async () => headResponse(403, {}));
    const create = jest.fn(async () => ({ release: async () => {} }));
    globalThis.ort = { InferenceSession: { create }, env: { wasm: {} } };
    await mod.detectSpeakers([tone()], 48000);
    expect(create).toHaveBeenCalledTimes(3);
  }, 15000);
});
