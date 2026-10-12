'use strict';

/**
 * Main-process transport to the local SAM-Audio worker.
 *
 * The renderer cannot reach http://127.0.0.1:<port> itself: the page CSP
 * (`connect-src 'self' …`) blocks it, and the worker deliberately answers no
 * CORS preflight, so no web origin can drive it. The renderer instead hands
 * PCM to the main process over IPC; this module validates the request and
 * talks to the worker on a fixed loopback host and fixed paths only.
 */
const http = require('http');

/** server.py rejects bodies above 64 MiB; base64 float32 costs 16/3 bytes a sample. */
const WORKER_MAX_BODY_BYTES = 64 * 1024 * 1024;
const MAX_SAMPLES = Math.floor(((WORKER_MAX_BODY_BYTES - 4096) * 3) / 4 / 4);
const MIN_SAMPLES = 16;
const MAX_PROMPT_CHARS = 512;
const JOB_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const OUTPUTS = new Set(['target', 'residual', 'both']);
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * @param {unknown} req
 * @returns {{ jobId: string, audio: Float32Array, sampleRate: number, prompt: string,
 *   predictSpans: boolean, rerankingCandidates: number, output: string, timeoutMs: number }}
 */
function validateSeparateRequest(req) {
  if (!req || typeof req !== 'object') throw new TypeError('request must be an object');
  const { jobId, audio, sampleRate } = req;
  if (typeof jobId !== 'string' || !JOB_ID_RE.test(jobId)) throw new TypeError('invalid jobId');
  // Tag check, not instanceof: IPC structured clone may hand over another realm's array.
  if (Object.prototype.toString.call(audio) !== '[object Float32Array]') throw new TypeError('audio must be a Float32Array');
  if (audio.length < MIN_SAMPLES) throw new RangeError('audio too short');
  if (audio.length > MAX_SAMPLES) throw new RangeError(`audio too long (max ${MAX_SAMPLES} samples per job)`);
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 384000) {
    throw new RangeError('invalid sampleRate');
  }
  if (req.mode !== undefined && req.mode !== 'text') throw new RangeError('unsupported-targeting');
  if (Array.isArray(req.anchors) && req.anchors.length) throw new RangeError('unsupported-targeting');
  const prompt = String(req.prompt ?? 'person speaking').slice(0, MAX_PROMPT_CHARS);
  const output = OUTPUTS.has(req.output) ? req.output : 'both';
  const rerank = Number.isInteger(req.rerankingCandidates) ? Math.min(Math.max(req.rerankingCandidates, 1), 8) : 1;
  const t = Number(req.timeoutMs);
  const timeoutMs = Number.isFinite(t) && t > 0 ? Math.min(t, MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
  return {
    jobId, audio, sampleRate, prompt, output, timeoutMs,
    predictSpans: !!req.predictSpans,
    rerankingCandidates: rerank,
  };
}

function f32ToBase64(f32) {
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength).toString('base64');
}

function base64ToF32(b64) {
  const buf = Buffer.from(b64, 'base64');
  const out = new Float32Array(Math.floor(buf.byteLength / 4));
  new Uint8Array(out.buffer).set(buf.subarray(0, out.byteLength));
  return out;
}

/**
 * @param {{ port: () => number }} opts
 */
function createSamProxy({ port }) {
  /** jobId → in-flight http.ClientRequest */
  const inflight = new Map();

  function post(path, body, timeoutMs, jobId) {
    return new Promise((resolve, reject) => {
      const data = Buffer.from(JSON.stringify(body));
      const req = http.request({
        host: '127.0.0.1',
        port: port(),
        path,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
        timeout: timeoutMs,
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* non-JSON */ }
          resolve({ status: res.statusCode, json });
        });
        res.on('error', reject);
      });
      if (jobId) inflight.set(jobId, req);
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      req.on('close', () => { if (jobId && inflight.get(jobId) === req) inflight.delete(jobId); });
      req.end(data);
    });
  }

  async function separate(raw) {
    let r;
    try {
      r = validateSeparateRequest(raw);
    } catch (err) {
      return { ok: false, status: 400, error: err.message };
    }
    let res;
    try {
      res = await post('/separate', {
        jobId: r.jobId,
        sampleRate: r.sampleRate,
        channels: 1,
        prompt: r.prompt,
        mode: 'text',
        anchors: [],
        predictSpans: r.predictSpans,
        rerankingCandidates: r.rerankingCandidates,
        output: r.output,
        audioBase64: f32ToBase64(r.audio),
      }, r.timeoutMs, r.jobId);
    } catch (err) {
      if (err?.message === 'cancelled') return { ok: false, status: 499, error: 'cancelled' };
      return { ok: false, status: 0, error: err?.message || 'worker-unreachable' };
    }
    const body = res.json || {};
    if (res.status !== 200) return { ok: false, status: res.status, error: body.error || `http-${res.status}` };
    const out = {
      ok: true,
      jobId: r.jobId,
      sampleRate: body.sampleRate,
      mock: !!body.mock,
      real: !!body.real,
      model: body.model || null,
      device: body.device || null,
    };
    if (typeof body.targetBase64 === 'string') out.target = base64ToF32(body.targetBase64);
    if (typeof body.residualBase64 === 'string') out.residual = base64ToF32(body.residualBase64);
    return out;
  }

  async function cancel(jobId) {
    if (typeof jobId !== 'string' || !JOB_ID_RE.test(jobId)) return { ok: false, error: 'invalid jobId' };
    const req = inflight.get(jobId);
    if (req) req.destroy(new Error('cancelled'));
    try {
      await post('/cancel', { jobId }, 5000, null);
    } catch { /* the worker may already be gone; the request above is closed either way */ }
    return { ok: true, aborted: !!req };
  }

  return { separate, cancel, inflightCount: () => inflight.size };
}

module.exports = {
  createSamProxy,
  validateSeparateRequest,
  MAX_SAMPLES,
  JOB_ID_RE,
};
