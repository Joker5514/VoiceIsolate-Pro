'use strict';

/**
 * The waveform envelope is exact (min/max of every sample per pixel column)
 * and, for long stems, built in time-budgeted chunks instead of one blocking
 * pass. The functions are lifted from visuals-bootstrap.js.
 */
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../public/app/visuals-bootstrap.js'), 'utf8');
const block = src.slice(src.indexOf('  const WAVE_SYNC_MAX_SAMPLES'), src.indexOf('  function _drawWaveformBase('));

function load() {
  return new Function(`let _waveEnvCache = new WeakMap();\n${block}\nreturn { _waveEnvelope };`)();
}

function reference(data, w) {
  const step = Math.max(1, Math.floor(data.length / w));
  const min = new Float32Array(w);
  const max = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    let lo = 1;
    let hi = -1;
    for (let i = x * step; i < Math.min(x * step + step, data.length); i++) {
      lo = Math.min(lo, data[i]);
      hi = Math.max(hi, data[i]);
    }
    min[x] = lo;
    max[x] = hi;
  }
  return { min, max };
}

const buf = (data) => ({ getChannelData: () => data });

test('long stem: built asynchronously, exact including a one-sample spike', async () => {
  const n = 48000 * 60;
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) data[i] = Math.sin(i * 0.003) * 0.3;
  data[1_234_567] = 0.99; // one sample: any stride or excerpt would miss it
  const { _waveEnvelope } = load();
  const b = buf(data);
  let redraws = 0;
  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  const redraw = () => { redraws++; resolveReady(); };
  // The playhead loop asks again every frame: the latest callback per canvas
  // is kept, so a canvas is redrawn once, not once per frame.
  for (let k = 0; k < 20; k++) expect(_waveEnvelope(b, 800, 'canvasA', redraw)).toBeNull();
  await ready;
  await new Promise((r) => setTimeout(r, 0));
  expect(redraws).toBe(1);
  const env = _waveEnvelope(b, 800, 'canvasA', () => {});
  const ref = reference(data, 800);
  expect(Array.from(env.min)).toEqual(Array.from(ref.min));
  expect(Array.from(env.max)).toEqual(Array.from(ref.max));
  expect(Math.max(...env.max)).toBeCloseTo(0.99, 6);
});

test('short stem: computed synchronously and exact', () => {
  const data = new Float32Array(48000 * 5).map((_, i) => Math.sin(i * 0.01) * 0.5);
  const { _waveEnvelope } = load();
  const env = _waveEnvelope(buf(data), 300);
  const ref = reference(data, 300);
  expect(Array.from(env.max)).toEqual(Array.from(ref.max));
});
