'use strict';

/**
 * MLWorker is a classic worker (importScripts), so it cannot import the ESM
 * `stft-math.js` helpers and carries its own copies. This pins the copies to
 * the canonical helpers: the same padded sample at every index, and the same
 * padded frame count, for short, odd and long inputs.
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const src = fs.readFileSync(path.join(__dirname, '../src/workers/MLWorker.js'), 'utf8');

function lift(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`missing ${name}`);
  let depth = 0;
  let i = src.indexOf('{', start);
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) break;
  }
  return src.slice(start, i + 1);
}

// eslint-disable-next-line no-new-func
const worker = new Function(`${lift('mirrorIndex')}\n${lift('edgeExtension')}\nreturn { edgeExtension };`)();

let stft;
beforeAll(async () => {
  stft = await import(pathToFileURL(path.join(__dirname, '../src/core/stft-math.js')).href);
});

test('edgeExtension equals paddedSample outside the clip, for short and odd lengths', () => {
  const N = 4096;
  for (const len of [2, 3, 7, 100, 2047, 2048, 2049, 5001]) {
    const x = Float32Array.from({ length: len }, (_, i) => Math.sin(i * 0.37) * 0.5 + (i % 3) * 0.01);
    for (let idx = -N; idx < len + N; idx++) {
      if (idx >= 0 && idx < len) continue;
      const a = worker.edgeExtension(x, idx);
      const b = stft.paddedSample(x, idx);
      if (a !== b) throw new Error(`len ${len} idx ${idx}: worker ${a} vs core ${b}`);
    }
  }
});

test('the worker frame-count formula equals paddedFrameCount', () => {
  const m = src.match(/const totalFrames = Math\.max\(1, Math\.floor\(\(samples\.length - 1 \+ pad\) \/ hop\) \+ 1\);/);
  expect(m).not.toBeNull();
  const N = 4096;
  const hop = 1024;
  const pad = N - hop;
  for (const len of [1, 2, 1023, 1024, 1025, 4095, 4096, 4097, 48000, 48001]) {
    const workerFrames = Math.max(1, Math.floor((len - 1 + pad) / hop) + 1);
    expect(workerFrames).toBe(stft.paddedFrameCount(len, N, hop));
  }
});
