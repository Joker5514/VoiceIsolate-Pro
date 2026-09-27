'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadWorker({ timers, getSessionImpl }) {
  const messages = [];
  const source = fs.readFileSync(path.join(__dirname, '../src/workers/MLWorker.js'), 'utf8') + `
    getSession = self.__getSessionImpl;
  `;
  const sandbox = {
    importScripts() {}, console, Promise, Error, Object, Set, Map, ArrayBuffer, Math,
    Float32Array, Uint8Array, Uint32Array, Int32Array, BigInt64Array,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    ort: {
      env: { wasm: {} },
      Tensor: class Tensor { constructor(type, data, dims) { this.data = data; this.dims = dims; } },
      InferenceSession: {},
    },
    self: { navigator: {}, postMessage: (m) => messages.push(m), __getSessionImpl: getSessionImpl },
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return { sandbox, messages };
}

function manualTimers() {
  const pending = new Map();
  let seq = 0;
  return {
    pending,
    setTimeout(fn) { seq += 1; pending.set(seq, fn); return seq; },
    clearTimeout(id) { pending.delete(id); },
    fireAll() {
      const fns = [...pending.values()];
      pending.clear();
      for (const fn of fns) fn();
    },
  };
}

const ENTRY = {
  id: 'mask', strategy: 'spectral-mask', fftSize: 16, hopSize: 4, bins: 9,
  maxBatchFrames: 2, io: { input: 'in', output: 'out' },
};

function onesSession() {
  return {
    run: async (feeds) => ({ out: { data: new Float32Array(feeds.in.data.length).fill(1) } }),
  };
}

test('model load posts request-scoped heartbeats until the session resolves', async () => {
  const timers = manualTimers();
  let resolveSession;
  const { sandbox, messages } = loadWorker({
    timers,
    getSessionImpl: () => new Promise((r) => { resolveSession = r; }),
  });
  await sandbox.self.onmessage({ data: { type: 'init', manifest: [ENTRY] } });
  const run = sandbox.self.onmessage({ data: {
    type: 'process', requestId: 7, modelIds: ['mask'],
    channelData: [new Float32Array(64).fill(0.1)], sampleRate: 48000,
  } });
  while (!resolveSession) await Promise.resolve();

  timers.fireAll();
  timers.fireAll();
  const beats = messages.filter((m) => m.type === 'heartbeat');
  expect(beats).toHaveLength(2);
  expect(beats[0]).toMatchObject({ requestId: 7, stage: 'load', modelId: 'mask' });

  resolveSession(onesSession());
  await run;
  expect(messages.some((m) => m.type === 'stems' && m.requestId === 7)).toBe(true);
  // Heartbeat timer is cleared once the session is ready.
  const before = messages.length;
  timers.fireAll();
  expect(messages.filter((m) => m.type === 'heartbeat')).toHaveLength(2);
  expect(messages.length).toBe(before);
});

test('cancelled requests stop emitting heartbeats', async () => {
  const timers = manualTimers();
  let resolveSession;
  const { sandbox, messages } = loadWorker({
    timers,
    getSessionImpl: () => new Promise((r) => { resolveSession = r; }),
  });
  await sandbox.self.onmessage({ data: { type: 'init', manifest: [ENTRY] } });
  const run = sandbox.self.onmessage({ data: {
    type: 'process', requestId: 9, modelIds: ['mask'],
    channelData: [new Float32Array(64)], sampleRate: 48000,
  } });
  while (!resolveSession) await Promise.resolve();
  await sandbox.self.onmessage({ data: { type: 'cancel', requestId: 9 } });
  timers.fireAll();
  expect(messages.filter((m) => m.type === 'heartbeat')).toHaveLength(0);
  resolveSession(onesSession());
  await run;
  expect(messages.some((m) => m.type === 'stems')).toBe(false);
});

test('stereo progress reports the channel mean and never jumps to the last channel offset', async () => {
  const timers = manualTimers();
  const { sandbox, messages } = loadWorker({ timers, getSessionImpl: async () => onesSession() });
  await sandbox.self.onmessage({ data: { type: 'init', manifest: [ENTRY] } });
  await sandbox.self.onmessage({ data: {
    type: 'process', requestId: 3, modelIds: ['mask'],
    channelData: [new Float32Array(4000).fill(0.2), new Float32Array(4000).fill(-0.2)],
    sampleRate: 48000,
  } });
  const pcts = messages.filter((m) => m.type === 'progress' && m.requestId === 3).map((m) => m.percent);
  expect(pcts.length).toBeGreaterThan(3);
  expect(pcts[0]).toBeLessThan(50);
  for (let i = 1; i < pcts.length; i++) expect(pcts[i]).toBeGreaterThanOrEqual(pcts[i - 1]);
  expect(pcts[pcts.length - 1]).toBe(100);
});
