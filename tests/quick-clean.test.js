const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { webcrypto, createHash } = require('crypto');
const { JSDOM } = require('jsdom');

let plans, audio, QuickCleanUI;
beforeAll(async () => {
  plans = await import('../src/pipeline/QuickCleanPlan.js');
  audio = await import('../src/core/AudioReview.js');
  ({ QuickCleanUI } = await import('../src/presentation/QuickCleanUI.js'));
});

test('all enabled outcomes resolve to shipped files with matching hashes and immutable 48 kHz chains', async () => {
  const { MODEL_MANIFEST } = await import('../src/core/ModelManifest.js');
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const dom = new JSDOM(html);
  const ui = new QuickCleanUI(dom.window.document);
  expect([...ui.select.options].every((option) => option.disabled)).toBe(true);
  ui.setBackend('wasm');
  expect(ui.select.options).toHaveLength(3);
  for (const option of ui.select.options) {
    expect(option.disabled).toBe(false);
    ui.select.value = option.value;
    const plan = ui.plan();
    expect(plan.sampleRate).toBe(48000);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.modelIds)).toBe(true);
    for (const id of plan.modelIds) {
      const entry = MODEL_MANIFEST[id];
      const bytes = fs.readFileSync(path.join(__dirname, '../public', entry.url));
      expect(bytes.length).toBe(entry.sizeBytes);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(entry.sha256);
    }
  }
  const ids = [...dom.window.document.querySelectorAll('[id]')].map((element) => element.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(html).not.toMatch(/^<<<<<<<|^=======|^>>>>>>>/m);
  dom.window.close();
});

test.each(['demucs', 'studio_isolation', '__proto__', 'unknown'])('rejects unavailable outcome %s', (id) => {
  expect(() => plans.resolveQuickCleanPlan(id)).toThrow();
});

test.each([{ shipped: false }, { optional: true }, { sha256: null }, { strategy: 'waveform' }, { sampleRate: 44100 }])('rejects unavailable or incompatible manifest entry %j', async (overrides) => {
  const { MODEL_MANIFEST } = await import('../src/core/ModelManifest.js');
  const manifest = { ...MODEL_MANIFEST, bsrnn_vocals: { ...MODEL_MANIFEST.bsrnn_vocals, ...overrides } };
  expect(() => plans.resolveQuickCleanPlan('bsrnn_vocals', { manifest })).toThrow(/shipped/);
});

test('unknown backend disables every choice; offline and unknown quota are explicit', async () => {
  const dom = new JSDOM(fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8'));
  const ui = new QuickCleanUI(dom.window.document);
  ui.setBackend('unavailable');
  expect([...ui.select.options].every((option) => option.disabled)).toBe(true);
  ui.setBackend('wasm');
  const device = await plans.inspectQuickCleanDevice({ navigator: { onLine: false, storage: { estimate: async () => { throw Error(); } } } });
  expect(device).toEqual({ online: false, freeBytes: null });
  ui.preflight(device);
  expect(dom.window.document.getElementById('quickCleanPreflight').textContent).toMatch(/Offline:.*previously cached/);
  expect(dom.window.document.getElementById('quickCleanPreflight').textContent).toMatch(/could not be measured/);
  dom.window.close();
});

test('matching attenuates to equal RMS and leaves peak headroom', () => {
  const a = audio.measureChannels([new Float32Array([0.8, -0.8])]);
  const b = audio.measureChannels([new Float32Array([0.2, -0.2])]);
  const gains = audio.reviewGains(a, b);
  expect(a.rms * gains.original).toBeCloseTo(b.rms * gains.cleaned, 6);
  expect(gains.original).toBeLessThanOrEqual(1);
  expect(gains.cleaned).toBeLessThanOrEqual(1);
  expect(audio.reviewGains({ rms: 0 }, b).matched).toBe(false);
});

test('invalid and clipping audio is detected before encoding', () => {
  expect(() => audio.measureChannels([new Float32Array([NaN])])).toThrow(/non-finite/);
  expect(() => audio.measureChannels([new Float32Array(2), new Float32Array(1)])).toThrow(/mismatched/);
  expect(audio.measureChannels([new Float32Array([1.1, 0, -1.2])]).clipped).toBe(2);
});

test('a cached model with a correct key but corrupted bytes cannot bypass integrity verification', async () => {
  const valid = new Uint8Array([10, 20, 30]).buffer;
  const corrupt = new Uint8Array([99, 99, 99]).buffer;
  const fetch = jest.fn(async () => ({ ok: true, arrayBuffer: async () => valid }));
  const source = fs.readFileSync(path.join(__dirname, '../src/workers/MLWorker.js'), 'utf8');
  const context = vm.createContext({
    importScripts() {}, self: { postMessage() {} }, ort: {}, crypto: webcrypto,
    console: { log() {}, warn() {}, error() {} }, Float32Array, Uint8Array,
    Uint32Array, ArrayBuffer, setTimeout, clearTimeout, fetch, corrupt,
  });
  vm.runInContext(source + '\nlocalCacheGet = async () => corrupt; localCachePut = async () => {}; self.read = fetchModelBytes;', context);
  const entry = { id: 'fixture', url: '/app/models/fixture.onnx', sha256: createHash('sha256').update(new Uint8Array(valid)).digest('hex') };
  const result = await context.self.read(entry);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect([...new Uint8Array(result)]).toEqual([...new Uint8Array(valid)]);
});
