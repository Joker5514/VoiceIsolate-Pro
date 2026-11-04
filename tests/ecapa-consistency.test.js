/**
 * VIP-015 — ECAPA consistency pins.
 *
 * Skipped when the optional ECAPA model is absent (same pattern as
 * tests/speaker-embedding-worker.test.js). When present, pins the
 * discrimination property measured by
 * scripts/quality/ecapa-consistency.cjs: same-source halves score
 * clearly above the cross-clip median. This is NOT an identification
 * accuracy test — the corpus has no speaker labels — and it must not
 * be read as one. The one known same-speaker cross pair in the probe
 * (cos 0.967) is why the cross assertion uses the median, not the max.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { createSpeakerWorker, realOrt, ecapaEntry } = require('../scripts/quality/lib/speaker-worker-node.cjs');

const ROOT = path.join(__dirname, '..');
const MODEL = path.join(ROOT, 'public/app/models/ecapa_tdnn.onnx');
const haveModel = fs.existsSync(MODEL);

function readWav16(file) {
  const b = fs.readFileSync(file);
  let off = 12;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === 'data') {
      const x = new Float32Array(size / 2);
      for (let i = 0; i < x.length; i++) x[i] = b.readInt16LE(off + 8 + 2 * i) / 32768;
      return x;
    }
    off += 8 + size + (size & 1);
  }
  throw new Error(`${file}: no data chunk`);
}

function upsampleLinear(x) {
  const out = new Float32Array(x.length * 3);
  for (let i = 0; i < x.length; i++) {
    const base = i * 3;
    out[base] = x[i];
    if (i + 1 < x.length) {
      out[base + 1] = (2 * x[i] + x[i + 1]) / 3;
      out[base + 2] = (x[i] + 2 * x[i + 1]) / 3;
    } else {
      out[base + 1] = x[i];
      out[base + 2] = x[i];
    }
  }
  return out;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

(haveModel ? describe : describe.skip)('ECAPA consistency (VIP-015)', () => {
  test('same-source halves score above the cross-clip median', async () => {
    const worker = createSpeakerWorker(realOrt());
    const init = await worker.send({ type: 'init', entry: ecapaEntry() });
    expect(init.find((m) => m.type === 'ready')).toBeTruthy();
    const ids = ['ms-snsd-clean-001', 'ms-snsd-clean-002', 'real-quiet-speech-001', 'real-noisy-hvac-001'];
    const first = {};
    const same = [];
    for (const id of ids) {
      const x48 = upsampleLinear(readWav16(path.join(ROOT, 'scripts/quality/corpus/audio', `${id}.wav`)));
      const half = Math.floor(x48.length / 2);
      const embs = [];
      for (const h of [x48.subarray(0, half), x48.subarray(half)]) {
        const replies = await worker.send({ type: 'embed', samples: h, sampleRate: 48000 });
        const emb = replies.find((m) => m.embedding)?.embedding;
        expect(emb).toBeTruthy();
        embs.push(Float32Array.from(emb));
      }
      first[id] = embs[0];
      same.push(cosine(embs[0], embs[1]));
    }
    const cross = [];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) cross.push(cosine(first[ids[i]], first[ids[j]]));
    }
    cross.sort((a, b) => a - b);
    const medianCross = cross[Math.floor(cross.length / 2)];
    for (const s of same) expect(s).toBeGreaterThan(0.45);
    expect(medianCross).toBeLessThan(0.3);
  }, 120000);
});
