#!/usr/bin/env node
/**
 * sync-model-manifests.mjs — regenerate the packaging model registry from the
 * canonical registry (VIP-012, per IMPLEMENTATION_READINESS_AUDIT_2026-11-02).
 *
 * `src/core/ModelManifest.js` is the single source of truth for model identity
 * (CLAUDE.md §3). `public/app/models-manifest.json` is a derived *packaging*
 * registry consumed by scripts/validate-onnx-models.js (delivery liveness),
 * public/app/model-cdn-loader.js (health probe + eager preload) and
 * scripts/hash-worklets.js (worklets section). Its `models` section used to be
 * hand-maintained and drifted (4 entries while 7 files ship). This generator
 * rebuilds that section deterministically from ModelManifest.js so drift
 * cannot return silently.
 *
 * Derived-entry rule (documented and enforced by tests/model-manifest-sync.test.js):
 *   include every manifest entry that is a real deliverable, i.e.
 *   `url` starts with '/app/models/' AND `sizeBytes` is a positive integer.
 *   Placeholder entries with `sizeBytes: null` (bsrnn_complex, sam_audio,
 *   universal_separator) are NOT deliverables yet and stay out of packaging
 *   registries. Optional/unshipped entries (demucs, ecapa_tdnn) are included
 *   with `optional: true` / `shipped: false` so validators never treat them as
 *   required.
 *
 * Preserved verbatim: `_note`, `schemaVersion`, `_sha256_note`, `worklets`
 * (owned by `pnpm worklets:hash`), and per-entry legacy fields that are not
 * derivable (`eager` preload flags, entry `_note`s).
 *
 * The hand-maintained model-card document `public/app/models/models-manifest.json`
 * (I/O tensors, training notes, licenses) is NOT rewritten by this script; a
 * consistency test keeps its filenames aligned.
 *
 * Usage:
 *   node scripts/sync-model-manifests.mjs           # write the manifest
 *   node scripts/sync-model-manifests.mjs --check   # exit 1 if out of sync
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = path.join(ROOT, 'public', 'app', 'models-manifest.json');
const CANONICAL = path.join(ROOT, 'src', 'core', 'ModelManifest.js');

/**
 * Legacy key aliases kept for runtime consumers that still index the
 * packaging manifest by pre-canonical ids (public/app/model-status-ui.js pill
 * keys via app.js MODEL_STATUS_KEYS = ['demucs','bsrnn','rnnoise','silero_vad'],
 * and model-cdn-loader.js fetchWithFallback lookups). Each alias maps the
 * legacy key to the canonical ModelManifest id; the generated entry is
 * identical under both keys.
 */
export const LEGACY_ALIASES = Object.freeze({
  silero_vad: 'vad',
  bsrnn: 'bsrnn_vocals',
});

/** Deterministic derived entry for one deliverable manifest record. */
export function deriveEntry(id, entry, previous = {}) {
  const filename = path.basename(entry.url);
  const derived = {
    filename,
    sizeBytes: entry.sizeBytes,
  };
  // Legacy preload hint is not derivable from ModelManifest: keep the recorded
  // value for existing ids, default to lazy (false) for new ones.
  derived.eager = previous.eager === true;
  if (entry.optional === true) derived.optional = true;
  if (entry.shipped === false) derived.shipped = false;
  if (typeof previous._note === 'string') derived._note = previous._note;
  if (typeof entry.sha256 === 'string') derived.sha256 = entry.sha256;
  derived.sources = [{ provider: 'same-origin', url: entry.url }];
  return derived;
}

/** Find the previous manifest record for an entry (by id, else by filename). */
export function previousFor(id, entry, previousModels = {}) {
  const filename = path.basename(entry.url);
  if (previousModels[id]) return previousModels[id];
  return Object.values(previousModels).find((p) => p && p.filename === filename) || {};
}

/**
 * Deliverables = real files that ship or have a pinned optional delivery.
 * @param {object} manifest MODEL_MANIFEST
 * @returns {Array<[string, object]>}
 */
export function deliverables(manifest) {
  return Object.entries(manifest).filter(([, e]) =>
    e && typeof e.url === 'string' && e.url.startsWith('/app/models/')
    && Number.isInteger(e.sizeBytes) && e.sizeBytes > 0);
}

/** Rebuild the `models` section of the packaging manifest. */
export function buildModelsSection(manifest, previousModels = {}) {
  const out = {};
  for (const [id, entry] of deliverables(manifest)) {
    const derived = deriveEntry(id, entry, previousFor(id, entry, previousModels));
    out[id] = derived;
  }
  // Alias keys after canonical keys so MODEL_STATUS_KEYS lookups keep working.
  for (const [alias, canonical] of Object.entries(LEGACY_ALIASES)) {
    if (out[canonical]) out[alias] = { ...out[canonical] };
  }
  return out;
}

function sameModels(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function main() {
  const check = process.argv.includes('--check');
  // Windows absolute paths are not valid import specifiers (protocol "c:").
  const { MODEL_MANIFEST } = await import(pathToFileURL(CANONICAL).href);
  const current = JSON.parse(fs.readFileSync(TARGET, 'utf8'));
  const next = buildModelsSection(MODEL_MANIFEST, current.models || {});

  if (check) {
    if (!sameModels(current.models || {}, next)) {
      const have = Object.keys(current.models || {});
      const want = Object.keys(next);
      const missing = want.filter((k) => !have.includes(k));
      const extra = have.filter((k) => !want.includes(k));
      const changed = want.filter((k) => have.includes(k)
        && !sameModels({ [k]: current.models[k] }, { [k]: next[k] }));
      console.error('[sync-model-manifests] public/app/models-manifest.json is OUT OF SYNC with src/core/ModelManifest.js');
      if (missing.length) console.error(`  missing entries: ${missing.join(', ')}`);
      if (extra.length) console.error(`  extra entries:   ${extra.join(', ')}`);
      if (changed.length) console.error(`  drifted entries: ${changed.join(', ')}`);
      console.error('  run: node scripts/sync-model-manifests.mjs');
      process.exit(1);
    }
    console.log('[sync-model-manifests] OK — packaging registry matches ModelManifest.js');
    return;
  }

  const out = { ...current, models: next };
  fs.writeFileSync(TARGET, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`[sync-model-manifests] wrote ${path.relative(ROOT, TARGET)} (${Object.keys(next).length} deliverables)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('[sync-model-manifests] fatal:', err.message);
    process.exit(1);
  });
}
