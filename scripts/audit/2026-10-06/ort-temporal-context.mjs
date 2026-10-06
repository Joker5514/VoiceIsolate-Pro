// Do the shipped models use cross-frame context? Run from repo root: node scripts/audit/2026-10-06/ort-temporal-context.mjs
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const ort = createRequire(path.join(root, 'package.json'))('onnxruntime-web');
ort.env.wasm.numThreads = 1;
for (const m of ['bsrnn_vocals', 'rnnoise_suppressor']) {
  const s = await ort.InferenceSession.create(fs.readFileSync(path.join(root, 'public/app/models', m + '.onnx')), { executionProviders: ['wasm'] });
  const bins = 2049, B = 8;
  const a = new Float32Array(B * bins);
  for (let i = 0; i < a.length; i++) a[i] = Math.abs(Math.sin(i * 0.37)) * 0.1;
  const b = Float32Array.from(a);
  for (let i = 0; i < bins * 4; i++) b[i] = Math.abs(Math.cos(i * 1.3)) * 2; // change frames 0..3 only
  const run = async (d, n) => (await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', d, [n, bins]) }))[s.outputNames[0]].data;
  const oa = await run(a, B), ob = await run(b, B);
  let maxd = 0; for (let i = bins * 4; i < B * bins; i++) maxd = Math.max(maxd, Math.abs(oa[i] - ob[i]));
  const single = await run(a.subarray(bins * 7), 1);
  let maxs = 0; for (let k = 0; k < bins; k++) maxs = Math.max(maxs, Math.abs(single[k] - oa[bins * 7 + k]));
  if (process.argv.includes('--check') && (maxd !== 0 || maxs !== 0)) { console.error(`FAIL ${m}: model uses cross-frame context`); process.exitCode = 1; }
  console.log(m, 'frames 4..7 delta when frames 0..3 change:', maxd.toExponential(2), '| frame 7 alone vs in batch:', maxs.toExponential(2));
}
