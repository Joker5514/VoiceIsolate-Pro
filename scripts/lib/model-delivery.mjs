/** Explicit network-tier delivery verification. Never used by the static gate. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MODEL_MANIFEST } from '../../src/core/ModelManifest.js';
import { requiredModelFiles } from '../generate-model-manifests.mjs';

export function deliveryBase(root, override) {
  let base = override;
  if (!base) {
    const config = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
    const rewrite = (config.rewrites || []).find((r) => r.source === '/app/models/:model(.*\\.onnx)');
    base = rewrite?.destination?.replace('/:model', '');
  }
  const url = new URL(base || 'invalid://missing-model-delivery');
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('Remote model delivery requires an HTTPS base URL without credentials');
  }
  return url.href.replace(/\/$/, '');
}

/** Download bounded bytes and verify their digest; HEAD/Content-Length is not integrity. */
export async function verifyRemoteModel(entry, base, { fetchImpl = globalThis.fetch, timeoutMs = 30000 } = {}) {
  const url = `${base}/${encodeURIComponent(path.basename(entry.url))}`;
  if (!/^[a-f0-9]{64}$/.test(entry.sha256 || '') || !Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes <= 0) {
    return { id: entry.id, url, ok: false, error: 'required model has no valid size and SHA-256 pin' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal, redirect: 'error', headers: { 'User-Agent': 'VoiceIsolate-ModelValidator/2' } });
    if (!response.ok) return { id: entry.id, url, ok: false, error: `HTTP ${response.status}` };
    const declared = response.headers.get('content-length');
    if (declared !== null && Number(declared) !== entry.sizeBytes) {
      await response.body?.cancel?.();
      return { id: entry.id, url, ok: false, error: `Content-Length ${declared} != expected ${entry.sizeBytes}` };
    }
    const hash = crypto.createHash('sha256');
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > entry.sizeBytes) {
        await response.body.cancel?.();
        return { id: entry.id, url, ok: false, error: `response exceeds expected ${entry.sizeBytes} bytes` };
      }
      hash.update(chunk);
    }
    const sha256 = hash.digest('hex');
    const ok = size === entry.sizeBytes && sha256 === entry.sha256;
    return { id: entry.id, url, ok, size, sha256, ...(ok ? {} : { error: `size/hash mismatch: got ${size}/${sha256}, expected ${entry.sizeBytes}/${entry.sha256}` }) };
  } catch (error) {
    return { id: entry.id, url, ok: false, error: error.name === 'AbortError' ? `timeout after ${timeoutMs} ms` : error.message };
  } finally { clearTimeout(timer); }
}

export async function verifyRemoteDelivery(options = {}) {
  const manifest = options.manifest || MODEL_MANIFEST;
  const required = requiredModelFiles(manifest);
  const skipped = Object.values(manifest).filter((e) => !e.composite && !required.includes(e)).map((e) => e.id);
  if (!required.length) return { ok: false, results: [], skipped, error: 'no required shipped models in canonical registry' };
  const results = await Promise.all(required.map((entry) => verifyRemoteModel(entry, options.base, options)));
  return { ok: results.every((r) => r.ok), results, skipped };
}
