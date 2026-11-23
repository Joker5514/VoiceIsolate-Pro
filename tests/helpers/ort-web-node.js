'use strict';

const { createRequire } = require('module');
const path = require('path');

function wasmDirFromOrtEntry(entry) {
  return path.dirname(entry);
}

async function loadOrtWebForNode() {
  if (globalThis.__vipOrtWebNode) return globalThis.__vipOrtWebNode;
  const requireFromHere = createRequire(__filename);
  const entry = requireFromHere.resolve('onnxruntime-web');
  const wasmDir = wasmDirFromOrtEntry(entry);
  // eslint-disable-next-line import/no-dynamic-require
  const mod = require(entry);
  const ort = mod?.default && mod.InferenceSession ? mod.default : mod;
  if (ort.env?.wasm) {
    ort.env.wasm.wasmPaths = wasmDir.endsWith(path.sep) ? wasmDir : `${wasmDir}/`;
    ort.env.wasm.numThreads = 1;
  }
  globalThis.__vipOrtWebNode = ort;
  return ort;
}

module.exports = { loadOrtWebForNode, wasmDirFromOrtEntry };
