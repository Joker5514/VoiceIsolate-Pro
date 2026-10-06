// BSRNN hash, I/O and single-thread WASM throughput. Run from repo root: node scripts/audit/2026-10-06/ort-bench.mjs
import { createRequire } from 'node:module';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const ort = createRequire(path.join(root, 'package.json'))('onnxruntime-web');
ort.env.wasm.numThreads = 1;
const bytes = fs.readFileSync(path.join(root, 'public/app/models/bsrnn_vocals.onnx'));
console.log('sha256', crypto.createHash('sha256').update(bytes).digest('hex'));
const s = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
console.log('inputs', s.inputNames, 'outputs', s.outputNames);
const B = 384, bins = 2049;
const data = new Float32Array(B * bins);
for (let i = 0; i < data.length; i++) data[i] = Math.abs(Math.sin(i * 0.37)) * 0.1;
const feeds = { [s.inputNames[0]]: new ort.Tensor('float32', data, [B, bins]) };
await s.run(feeds);
const t0 = performance.now(); const R = 5;
let out; for (let r = 0; r < R; r++) out = await s.run(feeds);
const ms = (performance.now() - t0) / R;
const o = out[s.outputNames[0]].data; let mn = 1, mx = 0;
for (const v of o) { if (v < mn) mn = v; if (v > mx) mx = v; }
console.log(`batch ${B} frames: ${ms.toFixed(1)} ms => ${(ms / B).toFixed(3)} ms/frame; mask range [${mn.toFixed(3)}, ${mx.toFixed(3)}]`);
for (const hop of [1024, 2048]) {
  const frames = 15 * 60 * 48000 / hop;
  console.log(`15-min mono @hop ${hop}: ${frames} frames = ${(frames * ms / B / 1000).toFixed(1)} s inference`);
}
