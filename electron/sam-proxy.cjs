'use strict';

/**
 * Main-process transport to the local SAM-Audio worker.
 *
 * The renderer cannot use http://127.0.0.1:<port> itself: the worker answers
 * no CORS preflight and refuses any request with an Origin header, so no page
 * can drive it (the web CSP also blocks it; the vip:// handler sets no CSP).
 * The renderer instead hands PCM to the main process over IPC; this module
 * validates the request and talks to the worker on a fixed loopback host and
 * fixed paths only.
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
/** Each job buffers its PCM, request body and response in the main process. */
const MAX_CONCURRENT_JOBS = 2;
/** Slack per returned stem over the input length (model padding), in samples. */
const RESPONSE_SLACK_SAMPLES = 65536;
const WORKER_SERVICE = 'sam-audio-worker';
const HEALTH_TIMEOUT_MS = 3000;

/** @param {unknown} p */
function isValidWorkerPort(p) {
  return Number.isInteger(p) && p >= 1024 && p <= 65535;
}

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
  /** jobId → { cancelled } for every separate() from validation to settle */
  const jobs = new Map();

  function request(method, path, body, timeoutMs, jobId, maxBytes) {
    return new Promise((resolve, reject) => {
      const p = port();
      if (!isValidWorkerPort(p)) {
        reject(new Error('invalid-worker-port'));
        return;
      }
      const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const headers = data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {};
      const req = http.request({ host: '127.0.0.1', port: p, path, method, headers, timeout: timeoutMs }, (res) => {
        const chunks = [];
        let received = 0;
        res.on('data', (c) => {
          received += c.length;
          if (received > maxBytes) {
            req.destroy(new Error('worker-response-too-large'));
            return;
          }
          chunks.push(c);
        });
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
      req.end(data || undefined);
    });
  }

  /** The port is configurable, so confirm it is our worker before sending PCM. */
  async function verifyWorker() {
    const res = await request('GET', '/health', undefined, HEALTH_TIMEOUT_MS, null, 64 * 1024);
    if (res.status !== 200 || res.json?.service !== WORKER_SERVICE) throw new Error('not-sam-worker');
  }

  async function separate(raw) {
    let r;
    try {
      r = validateSeparateRequest(raw);
    } catch (err) {
      return { ok: false, status: 400, error: err.message };
    }
    // Reserve the slot synchronously so concurrent calls see it at once.
    if (jobs.has(r.jobId)) return { ok: false, status: 409, error: 'job-already-running' };
    if (jobs.size >= MAX_CONCURRENT_JOBS) return { ok: false, status: 429, error: 'worker-busy' };
    const job = { cancelled: false };
    jobs.set(r.jobId, job);
    const n = r.audio.length + RESPONSE_SLACK_SAMPLES;
    const maxResponseBytes = 2 * 4 * Math.ceil((n * 4) / 3) + 64 * 1024;
    let res;
    try {
      await verifyWorker();
      if (job.cancelled) throw new Error('cancelled');
      res = await request('POST', '/separate', {
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
      }, r.timeoutMs, r.jobId, maxResponseBytes);
    } catch (err) {
      if (err?.message === 'cancelled' || job.cancelled) return { ok: false, status: 499, error: 'cancelled' };
      return { ok: false, status: 0, error: err?.message || 'worker-unreachable' };
    } finally {
      jobs.delete(r.jobId);
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
    const job = jobs.get(jobId);
    if (job) job.cancelled = true;
    const req = inflight.get(jobId);
    if (req) req.destroy(new Error('cancelled'));
    try {
      await request('POST', '/cancel', { jobId }, 5000, null, 64 * 1024);
    } catch { /* the worker may already be gone; the request above is closed either way */ }
    return { ok: true, aborted: !!(req || job) };
  }

  return { separate, cancel, inflightCount: () => inflight.size, activeJobs: () => jobs.size };
}

module.exports = {
  createSamProxy,
  validateSeparateRequest,
  isValidWorkerPort,
  MAX_SAMPLES,
  MAX_CONCURRENT_JOBS,
  JOB_ID_RE,
};
