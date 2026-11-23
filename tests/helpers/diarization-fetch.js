'use strict';

const fs = require('fs');
const path = require('path');

const MODELS_DIR = path.join(__dirname, '..', '..', 'public', 'models');
const DIARIZATION_URL_FILES = Object.freeze({
  '/models/pyannote-segmentation-3.0.onnx': 'pyannote-segmentation-3.0.onnx',
  '/models/wespeaker-resnet34.onnx': 'wespeaker-resnet34.onnx',
  '/models/silero-vad.onnx': 'silero-vad.onnx',
});

function headResponse(status, headers = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (name.toLowerCase() in lower ? lower[name.toLowerCase()] : null) },
  };
}

function readModelBytes(url) {
  const file = DIARIZATION_URL_FILES[url];
  if (!file) return null;
  return fs.readFileSync(path.join(MODELS_DIR, file));
}

function getResponse(url, { ok = true, status = 200, bytes } = {}) {
  const buf = bytes != null ? bytes : readModelBytes(url);
  if (!buf) {
    return {
      ok: false,
      status: 404,
      arrayBuffer: async () => new ArrayBuffer(0),
      headers: { get: () => null },
    };
  }
  const copy = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return {
    ok,
    status,
    arrayBuffer: async () => copy.slice(0),
    headers: { get: (name) => (String(name).toLowerCase() === 'content-length' ? String(buf.byteLength) : null) },
  };
}

/**
 * Fetch mock: HEAD uses `head`, GET serves pinned public/models bytes so
 * createNamedSession can hash-verify and pass ArrayBuffers to ORT.
 */
function diarizationFetchMock({ headStatus = 200, headHeaders = {} } = {}) {
  return async (url, init = {}) => {
    const method = String(init.method || 'GET').toUpperCase();
    if (method === 'HEAD') return headResponse(headStatus, headHeaders);
    return getResponse(url);
  };
}

module.exports = {
  DIARIZATION_URL_FILES,
  headResponse,
  readModelBytes,
  getResponse,
  diarizationFetchMock,
};
