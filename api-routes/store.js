/**
 * VoiceIsolate Pro — backend persistence (licenses, webhook ledger, outbox,
 * usage, cloud-sync data).
 *
 * Every mutation runs through transact(): the callback edits a private copy of
 * the state and the copy is committed only if it returns without throwing, so
 * a request (or a webhook) either applies all of its changes or none.
 *
 *   memory — tests and local development only; lost on restart.
 *   file   — VIP_DATA_DIR/vip-backend.json, written via temp file + rename
 *            (atomic on POSIX). Survives restarts on a persistent volume.
 *            Single instance only: there is no cross-process lock, so two
 *            servers sharing the file would overwrite each other's commits.
 *
 * There is no database adapter. A multi-instance deployment needs one (a new
 * service), and readiness reports `multiInstanceSafe: false` until it exists.
 */
'use strict';

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const EMPTY = () => ({
  schema: 1,
  licenses: {},
  processedEvents: {},
  outbox: [],
  usage: [],
  sync: {},
});

/** Webhook ids are kept long enough to absorb Stripe's 3-day retry window. */
const EVENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_USAGE_ROWS = 100_000;
/** Sent and failed rows are history; keep the outbox bounded. */
const MAX_OUTBOX_ROWS = 10_000;

function prune(state, now) {
  for (const [id, at] of Object.entries(state.processedEvents)) {
    if (now - at > EVENT_TTL_MS) delete state.processedEvents[id];
  }
  if (state.usage.length > MAX_USAGE_ROWS) state.usage.splice(0, state.usage.length - MAX_USAGE_ROWS);
  if (state.outbox.length > MAX_OUTBOX_ROWS) state.outbox.splice(0, state.outbox.length - MAX_OUTBOX_ROWS);
}

/**
 * @param {{ kind: 'memory' } | { kind: 'file', dir: string }} config
 */
export function createStore(config) {
  const kind = config?.kind === 'file' ? 'file' : 'memory';
  const file = kind === 'file' ? join(config.dir, 'vip-backend.json') : null;
  let memory = EMPTY();
  let chain = Promise.resolve();

  // Licence, customer and sync data: owner-only, whatever the umask.
  if (file) mkdirSync(config.dir, { recursive: true, mode: 0o700 });

  const load = () => {
    if (!file) return structuredClone(memory);
    if (!existsSync(file)) return EMPTY();
    return { ...EMPTY(), ...JSON.parse(readFileSync(file, 'utf8')) };
  };
  const commit = (state) => {
    if (!file) { memory = state; return; }
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    renameSync(tmp, file);
  };

  return {
    kind,
    durable: kind === 'file',
    multiInstanceSafe: false,
    path: file,
    /** Read-only snapshot. */
    async read() {
      await chain;
      return load();
    },
    /**
     * Run `fn(draft)` and commit the draft atomically. Transactions are
     * serialized in this process; a throw commits nothing.
     * @template T
     * @param {(draft: ReturnType<typeof EMPTY>) => T | Promise<T>} fn
     * @returns {Promise<T>}
     */
    transact(fn) {
      const run = chain.then(async () => {
        const draft = load();
        const result = await fn(draft);
        prune(draft, Date.now());
        commit(draft);
        return result;
      });
      chain = run.catch(() => {});
      return run;
    },
  };
}

let _store;

/**
 * Process-wide store from the environment. Production requires a durable
 * store (VIP_DATA_DIR); without it this returns null and the paid and sync
 * endpoints answer 503 instead of pretending to persist.
 * @returns {ReturnType<typeof createStore>|null}
 */
export function getStore() {
  if (_store !== undefined) return _store;
  if (process.env.VIP_DATA_DIR) _store = createStore({ kind: 'file', dir: process.env.VIP_DATA_DIR });
  else if (process.env.NODE_ENV === 'production') _store = null;
  else _store = createStore({ kind: 'memory' });
  return _store;
}

/** Tests: replace (or reset with undefined) the process-wide store. */
export function _setStoreForTests(store) {
  _store = store;
}

/** Truthful readiness of the persistence layer. */
export function storeReadiness() {
  let store;
  try {
    store = getStore();
  } catch (err) {
    // e.g. VIP_DATA_DIR cannot be created: report it, keep /health alive.
    return { ready: false, kind: 'error', durable: false, multiInstanceSafe: false, reason: err?.code || 'store-init-failed' };
  }
  if (!store) return { ready: false, kind: 'none', durable: false, multiInstanceSafe: false, reason: 'VIP_DATA_DIR is not set' };
  return { ready: true, kind: store.kind, durable: store.durable, multiInstanceSafe: store.multiInstanceSafe };
}

export default { createStore, getStore, storeReadiness };
