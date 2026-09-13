'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test('cancellation during awaited inference stops later batches and permits a successor', async () => {
  const messages = [];
  const first = deferred();
  let calls = 0;
  const source = fs.readFileSync(path.join(__dirname, '../src/workers/MLWorker.js'), 'utf8') + `
    self.__cancelTest = { runWaveformMask };
  `;
  const sandbox = {
    importScripts() {}, console, Promise, Error, Object, Set, Map, ArrayBuffer,
    Float32Array, Uint8Array, Uint32Array, Int32Array, BigInt64Array,
    setTimeout, clearTimeout,
    ort: { env: { wasm: {} }, Tensor: class Tensor {}, InferenceSession: {} },
    self: { navigator: {}, postMessage: (m) => messages.push(m) },
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  const entry = { id: 'wave', sampleRate: 4, segmentSamples: 4, io: { input: 'in', output: 'out' } };
  const session = { run: jest.fn(async () => {
    calls += 1;
    if (calls === 1) await first.promise;
    return { out: { data: new Float32Array([1, 1, 1, 1]) } };
  }) };
  const active = sandbox.self.__cancelTest.runWaveformMask(
    entry, session, new Float32Array(12).fill(1), 4, () => {}, 'job-a',
  );
  while (session.run.mock.calls.length === 0) await Promise.resolve();
  await sandbox.self.onmessage({ data: { type: 'cancel', requestId: 'job-a' } });
  first.resolve();
  await expect(active).rejects.toMatchObject({ name: 'AbortError', code: 'VIP_CANCELLED' });
  expect(session.run).toHaveBeenCalledTimes(1);
  expect(messages).toContainEqual({ type: 'cancelled', requestId: 'job-a' });
  expect(messages.find((m) => m.type === 'stems' && m.requestId === 'job-a')).toBeUndefined();

  await expect(sandbox.self.__cancelTest.runWaveformMask(
    entry, session, new Float32Array(4).fill(1), 4, () => {}, 'job-b',
  )).resolves.toBeInstanceOf(Float32Array);
  expect(session.run).toHaveBeenCalledTimes(2);
});
