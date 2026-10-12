/**
 * F20 — idbTxDone must report the commit, not a timer. The previous helper
 * resolved on a 0 ms timeout whenever `complete` had not fired yet, so a
 * delayed commit, a quota abort at commit time, or a late abort were all
 * reported as successful writes. Real-browser coverage lives in
 * scripts/idb-commit-browser-check.cjs.
 */
'use strict';

let idb;

beforeAll(async () => {
  idb = await import('../src/core/storage/openIdb.js');
});

/** EventTarget-backed transaction whose events the test fires by hand. */
class FakeTx extends EventTarget {
  constructor() {
    super();
    this.error = null;
  }
  fire(type, error = null) {
    if (error) this.error = error;
    this.dispatchEvent(new Event(type));
  }
}

function fakeDb() {
  const made = [];
  return {
    made,
    transaction() {
      const tx = new FakeTx();
      made.push(tx);
      return tx;
    },
  };
}

const settle = (p) => p.then(() => 'resolved', (e) => e);
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

describe('idbTxDone', () => {
  test('a delayed commit is not reported early', async () => {
    const db = fakeDb();
    const tx = idb.idbTransaction(db, 's', 'readwrite');
    let state = 'pending';
    idb.idbTxDone(tx).then(() => { state = 'resolved'; });
    await tick(30);
    expect(state).toBe('pending');
    tx.fire('complete');
    await tick();
    expect(state).toBe('resolved');
  });

  test('a quota abort raised at commit rejects with that error', async () => {
    const db = fakeDb();
    const tx = idb.idbTransaction(db, 's', 'readwrite');
    const done = settle(idb.idbTxDone(tx));
    await tick(10);
    const quota = Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
    tx.fire('abort', quota);
    expect(await done).toBe(quota);
  });

  test('a late abort with no error object still rejects', async () => {
    const db = fakeDb();
    const tx = idb.idbTransaction(db, 's', 'readwrite');
    const done = settle(idb.idbTxDone(tx));
    await tick(20);
    tx.fire('abort');
    const err = await done;
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('AbortError');
  });

  test('completion that fires before idbTxDone is awaited is not missed', async () => {
    const db = fakeDb();
    const tx = idb.idbTransaction(db, 's', 'readwrite');
    tx.fire('complete');
    await tick();
    await expect(idb.idbTxDone(tx)).resolves.toBeUndefined();
  });

  test('existing on* handlers are preserved on handler-only transactions', async () => {
    const tx = { oncomplete: null, onabort: null, error: null };
    let seen = 0;
    tx.oncomplete = () => { seen += 1; };
    const db = { transaction: () => tx };
    const t = idb.idbTransaction(db, 's', 'readwrite');
    const done = idb.idbTxDone(t);
    tx.oncomplete({});
    await expect(done).resolves.toBeUndefined();
    expect(seen).toBe(1);
  });
});
