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

test('a cancel message posted mid-run is dispatched between batches (no full-file run)', async () => {
  const messages = [];
  let clock = 0;
  const source = fs.readFileSync(path.join(__dirname, '../src/workers/MLWorker.js'), 'utf8') + `
    self.__cancelTest = { runWaveformMask };
  `;
  const sandbox = {
    importScripts() {}, console, Promise, Error, Object, Set, Map, ArrayBuffer,
    Float32Array, Uint8Array, Uint32Array, Int32Array, BigInt64Array,
    setTimeout, clearTimeout,
    performance: { now: () => clock },
    ort: { env: { wasm: {} }, Tensor: class Tensor {}, InferenceSession: {} },
    self: { navigator: {}, postMessage: (m) => messages.push(m) },
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  const entry = { id: 'wave', sampleRate: 4, segmentSamples: 4, io: { input: 'in', output: 'out' } };
  // ORT promises settle as microtasks: without a macrotask yield in the loop,
  // a 'cancel' message (a macrotask) could not run until every batch finished.
  const session = { run: jest.fn(async () => {
    clock += 40;
    return { out: { data: new Float32Array([1, 1, 1, 1]) } };
  }) };
  const segments = 400;
  const active = sandbox.self.__cancelTest.runWaveformMask(
    entry, session, new Float32Array(segments * 4).fill(1), 4, () => {}, 'job-long',
  );
  setTimeout(() => { void sandbox.self.onmessage({ data: { type: 'cancel', requestId: 'job-long' } }); }, 0);
  await expect(active).rejects.toMatchObject({ name: 'AbortError', code: 'VIP_CANCELLED' });
  expect(session.run.mock.calls.length).toBeLessThan(10);
  expect(messages).toContainEqual({ type: 'cancelled', requestId: 'job-long' });
});

/** Load MLWorker.js with its queue internals exposed (no ORT, no models). */
function loadWorkerQueue(messages) {
  const source = fs.readFileSync(path.join(__dirname, '../src/workers/MLWorker.js'), 'utf8') + `
    self.__q = { enqueueRequest, cancellationPoint };
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
  return sandbox.self;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

test('F02: cancelled is acknowledged only once the running request has stopped', async () => {
  const messages = [];
  const self = loadWorkerQueue(messages);
  const gate = deferred();
  let reachedEnd = false;
  const running = self.__q.enqueueRequest({ requestId: 'a' }, async () => {
    await gate.promise; // an inference call that has not returned yet
    await self.__q.cancellationPoint('a');
    reachedEnd = true;
    self.postMessage({ type: 'stems', requestId: 'a' });
  });
  running.catch(() => {});
  await flush();
  await self.onmessage({ data: { type: 'cancel', requestId: 'a' } });
  await flush();
  // Still inside the stalled call: no ack, so the host's grace timer stays armed.
  expect(messages.filter((m) => m.type === 'cancelled')).toHaveLength(0);
  gate.resolve();
  await expect(running).rejects.toMatchObject({ code: 'VIP_CANCELLED' });
  await flush();
  expect(reachedEnd).toBe(false);
  expect(messages).toContainEqual({ type: 'cancelled', requestId: 'a' });
  expect(messages.some((m) => m.type === 'stems')).toBe(false);
});

test('F02: a request cancelled while queued is acked at once and never starts', async () => {
  const messages = [];
  const self = loadWorkerQueue(messages);
  const gate = deferred();
  const first = self.__q.enqueueRequest({ requestId: 'a' }, () => gate.promise);
  let bStarted = false;
  const second = self.__q.enqueueRequest({ requestId: 'b' }, async () => { bStarted = true; });
  second.catch(() => {});
  await self.onmessage({ data: { type: 'cancel', requestId: 'b' } });
  expect(messages).toContainEqual({ type: 'cancelled', requestId: 'b' });
  gate.resolve();
  await first;
  await expect(second).rejects.toMatchObject({ code: 'VIP_CANCELLED' });
  expect(bStarted).toBe(false);
  // The next request runs immediately on the same worker.
  let cRan = false;
  await self.__q.enqueueRequest({ requestId: 'c' }, async () => { cRan = true; });
  expect(cRan).toBe(true);
});

test('F02: cancel for a request the worker no longer holds is acked immediately', async () => {
  const messages = [];
  const self = loadWorkerQueue(messages);
  await self.__q.enqueueRequest({ requestId: 'done' }, async () => {});
  await self.onmessage({ data: { type: 'cancel', requestId: 'done' } });
  expect(messages).toContainEqual({ type: 'cancelled', requestId: 'done' });
});
