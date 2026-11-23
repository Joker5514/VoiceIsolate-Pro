/**
 * Canonical inventory for the three shipped diarization ONNX files under
 * public/models/. Isolation models stay in ModelManifest.js so generated
 * isolation-only projections are unchanged.
 *
 * Browser URLs are same-origin /models/*.onnx. The Vercel build validator
 * (scripts/validate-model-integrity.mjs, invoked from scripts/validate.js)
 * hash-checks these entries so a truncated file fails the build.
 */
'use strict';

export const DIARIZATION_MODEL_MANIFEST = Object.freeze({
  segmentation: Object.freeze({
    id: 'segmentation',
    file: 'pyannote-segmentation-3.0.onnx',
    url: '/models/pyannote-segmentation-3.0.onnx',
    sizeBytes: 5986908,
    sha256: '057ee564753071c0b09b5b611648b50ac188d50846bff5f01e9f7bbf1591ea25',
    inputName: 'input_values',
    outputName: 'logits',
  }),
  embedding: Object.freeze({
    id: 'embedding',
    file: 'wespeaker-resnet34.onnx',
    url: '/models/wespeaker-resnet34.onnx',
    sizeBytes: 26535549,
    sha256: '3955447b0499dc9e0a4541a895df08b03c69098eba4e56c02b5603e9f7f4fcbb',
    inputName: 'input_features',
    outputName: 'last_hidden_state',
  }),
  vad: Object.freeze({
    id: 'vad',
    file: 'silero-vad.onnx',
    url: '/models/silero-vad.onnx',
    sizeBytes: 2327524,
    sha256: '1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3',
  }),
});

const SHA256_RE = /^[0-9a-f]{64}$/;

function toUint8(bytes) {
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (ArrayBuffer.isView(bytes)) {
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  throw new TypeError('diarization model bytes must be an ArrayBuffer or typed array');
}

function hexOf(buf) {
  const view = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < view.length; i++) out += view[i].toString(16).padStart(2, '0');
  return out;
}

export async function sha256Hex(bytes) {
  const view = toUint8(bytes);
  if (globalThis.crypto?.subtle?.digest) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', view);
    return hexOf(digest);
  }
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(view).digest('hex');
}

export function diarizationModelIds(manifest = DIARIZATION_MODEL_MANIFEST) {
  return Object.keys(manifest);
}

/**
 * Verify fetched or on-disk model bytes against the pinned size and SHA-256.
 * @param {{ id: string, file?: string, url: string, sizeBytes: number, sha256: string }} entry
 * @param {ArrayBuffer|Uint8Array|Buffer} bytes
 */
export async function verifyDiarizationModelBytes(entry, bytes) {
  const label = entry?.file || entry?.id || entry?.url || 'unknown';
  if (!entry || typeof entry.sha256 !== 'string' || !SHA256_RE.test(entry.sha256)) {
    const err = new Error(`diarization model ${label} has an invalid sha256 pin`);
    err.code = 'model-integrity';
    throw err;
  }
  const view = toUint8(bytes);
  if (view.byteLength !== entry.sizeBytes) {
    const err = new Error(
      `diarization model ${label} (${entry.url}): expected size ${entry.sizeBytes}, got ${view.byteLength}`,
    );
    err.code = 'model-integrity';
    throw err;
  }
  const digest = await sha256Hex(view);
  if (digest !== entry.sha256) {
    const err = new Error(
      `diarization model ${label} (${entry.url}): expected hash ${entry.sha256}, got ${digest}`,
    );
    err.code = 'model-integrity';
    throw err;
  }
  return view;
}

export default DIARIZATION_MODEL_MANIFEST;
