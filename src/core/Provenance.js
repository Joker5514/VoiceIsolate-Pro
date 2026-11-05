/**
 * VoiceIsolate Pro — export provenance record (Layer 1: Core)
 *
 * VIP-010 / VIP-040 (IMPLEMENTATION_READINESS_AUDIT_2026-11-02): a versioned
 * `.viprovenance.json` integrity record for exported audio.
 *
 * What this IS: an integrity record. `manifestDigest` is a SHA-256 over a
 * canonical serialization of the record — it detects accidental edits and
 * naive tampering of the JSON. It is NOT a signature, NOT a trusted timestamp,
 * NOT legal evidence, and NOT forensic certification: anyone holding the file
 * can recompute the digest after rewriting the record. Its value is that a
 * *changed* record without a recomputed digest fails verification, and the
 * record carries the hashes needed to compare artifacts independently.
 *
 * Field policy (mandatory vs unavailable):
 *   mandatory  — schema, schemaVersion, createdAt, export.timestamp,
 *                manifestDigest. buildProvenanceRecord throws without them.
 *   hashable   — source.sha256, export.output.sha256: REQUIRED for
 *                verification but may be null when the caller could not
 *                compute them (crypto unavailable, user cancelled). null means
 *                "not measured", never a placeholder value.
 *   optional   — everything else; unavailable values are explicitly null.
 * Nothing is ever fabricated: callers pass what they measured.
 *
 * Pure module: no DOM, no I/O. Uses src/core/sha256.js (cross-checked against
 * Node crypto and SubtleCrypto in tests/source-hash.test.js).
 */
'use strict';

import { Sha256 } from './sha256.js';

export const PROVENANCE_SCHEMA = 'vip-provenance';
export const PROVENANCE_SCHEMA_VERSION = 1;
export const PROVENANCE_FILENAME_SUFFIX = '.viprovenance.json';

/**
 * Canonical user-facing verification verdicts for VIP-020 Forensic Inspector UX.
 */
export const PROVENANCE_VERDICT = Object.freeze({
  VERIFIED: 'verified',
  MISMATCH: 'mismatch',
  MALFORMED_METADATA: 'malformed_metadata',
  MISSING_SIDECAR: 'missing_sidecar',
  UNSUPPORTED_SCHEMA: 'unsupported_schema',
});

/**
 * Mandatory honesty disclaimer displayed in all provenance/forensic UI surfaces
 * and documentation (VIP-020).
 */
export const PROVENANCE_NON_CERTIFICATION_DISCLAIMER =
  'Local SHA-256 integrity and processing provenance metadata only. '
  + 'This record is NOT legal certification, NOT a cryptographic digital signature, '
  + 'NOT a trusted timestamp, and NOT chain-of-custody or authenticity proof.';

const SHA256_RE = /^[0-9a-f]{64}$/;

function sha(data) {
  return new Sha256().update(data).digestHex();
}

function utf8(text) {
  return new TextEncoder().encode(text);
}

/**
 * Deterministic serialization: object keys sorted recursively, arrays keep
 * their order (operation history is chronological and order matters),
 * undefined treated as null. Same logical record ⇒ same bytes ⇒ same digest.
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return 'null';
}

/** Normalise a hash-ish value: lowercase hex or null. Never invents one. */
function hashOrNull(value) {
  if (typeof value !== 'string') return null;
  const v = value.toLowerCase();
  return SHA256_RE.test(v) ? v : null;
}

function strOrNull(value) {
  return typeof value === 'string' && value.length ? value : null;
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

/**
 * Build a schema-conforming record. Throws only for missing MANDATORY fields.
 *
 * @param {object} input
 * @param {object} [input.source]   { name, sizeBytes, mimeType, sha256 }
 * @param {object} [input.export]   { timestamp?, format, options, output: { filename, sizeBytes, sha256 } }
 * @param {object} [input.application] { version, inferenceRevision, modelChainRevision, modelIds, models }
 * @param {object} [input.processing]  { parameters, operations }
 * @param {string} [input.createdAt]
 * @returns {object} provenance record incl. manifestDigest
 */
export function buildProvenanceRecord(input = {}) {
  const createdAt = strOrNull(input.createdAt) || new Date().toISOString();
  const exportInfo = input.export || {};
  const timestamp = strOrNull(exportInfo.timestamp) || createdAt;

  const record = {
    schema: PROVENANCE_SCHEMA,
    schemaVersion: PROVENANCE_SCHEMA_VERSION,
    createdAt,
    source: input.source ? {
      name: strOrNull(input.source.name),
      sizeBytes: finiteOrNull(input.source.sizeBytes),
      mimeType: strOrNull(input.source.mimeType),
      sha256: hashOrNull(input.source.sha256),
    } : null,
    export: {
      timestamp,
      format: strOrNull(exportInfo.format) || 'wav',
      options: exportInfo.options && typeof exportInfo.options === 'object' ? { ...exportInfo.options } : {},
      output: input.export?.output ? {
        filename: strOrNull(input.export.output.filename),
        sizeBytes: finiteOrNull(input.export.output.sizeBytes),
        sha256: hashOrNull(input.export.output.sha256),
      } : null,
    },
    application: input.application ? {
      name: strOrNull(input.application.name) || 'VoiceIsolate Pro',
      version: strOrNull(input.application.version),
      inferenceRevision: strOrNull(input.application.inferenceRevision),
      modelChainRevision: strOrNull(input.application.modelChainRevision),
      modelIds: Array.isArray(input.application.modelIds) ? [...input.application.modelIds] : null,
      models: Array.isArray(input.application.models)
        ? input.application.models.map((m) => ({ id: strOrNull(m?.id), sha256: hashOrNull(m?.sha256) }))
        : null,
    } : null,
    processing: input.processing ? {
      parameters: input.processing.parameters && typeof input.processing.parameters === 'object'
        ? { ...input.processing.parameters } : null,
      operations: Array.isArray(input.processing.operations)
        ? input.processing.operations.map((op) => ({
          id: strOrNull(op?.id),
          status: strOrNull(op?.status), // 'completed' | 'failed' | 'cancelled' | …
          detail: strOrNull(op?.detail) || null,
        }))
        : null,
    } : null,
    // integrity fields (computed, never supplied):
    manifestDigest: null,
    digestAlgorithm: 'sha256',
    digestCanonicalization: 'canonical-json-v1 (sorted keys; arrays ordered)',
  };

  if (!record.export.timestamp) {
    throw new TypeError('[VIP][Provenance] export.timestamp is mandatory');
  }
  record.manifestDigest = provenanceManifestDigest(record);
  return record;
}

/**
 * Digest of the canonical form with the integrity fields excluded.
 * @param {object} record
 * @returns {string} hex
 */
export function provenanceManifestDigest(record) {
  const rest = { ...(record || {}) };
  delete rest.manifestDigest;
  delete rest.digestAlgorithm;
  delete rest.digestCanonicalization;
  return sha(utf8(canonicalJson(rest)));
}

/**
 * Verify a record. Checks schema support, internal digest integrity, and —
 * when the caller measured them — source/output hashes against real bytes.
 *
 * @param {object} record
 * @param {{ sourceBlob?: Blob, outputBlob?: Blob, hashFn?: Function }} [evidence]
 *   hashFn: async (blob) => string — inject the streaming hasher (tests pass
 *   a stub; runtime passes hashBlobSha256). When absent, byte-level checks
 *   are reported as 'unverified', never as 'passed'.
 * @returns {Promise<{ok: boolean, checks: object, failures: string[]}>}
 */
export async function verifyProvenanceRecord(record, evidence = {}) {
  const checks = {
    schema: 'unverified',
    manifestDigest: 'unverified',
    outputSha256: 'unverified',
    sourceSha256: 'unverified',
  };
  const failures = [];

  if (!record || typeof record !== 'object') {
    return { ok: false, checks, failures: ['record is not an object'] };
  }
  checks.schema = (record.schema === PROVENANCE_SCHEMA && record.schemaVersion === PROVENANCE_SCHEMA_VERSION)
    ? 'passed' : 'failed';
  if (checks.schema !== 'passed') {
    failures.push(`unsupported schema ${record.schema}/${record.schemaVersion} (expected ${PROVENANCE_SCHEMA}/${PROVENANCE_SCHEMA_VERSION})`);
    return { ok: false, checks, failures };
  }

  const recomputed = provenanceManifestDigest(record);
  checks.manifestDigest = record.manifestDigest === recomputed ? 'passed' : 'failed';
  if (checks.manifestDigest !== 'passed') {
    failures.push('manifestDigest does not match the record contents (record was modified or corrupt)');
  }

  const hashFn = typeof evidence.hashFn === 'function' ? evidence.hashFn : null;
  if (hashFn && evidence.outputBlob) {
    try {
      const actual = await hashFn(evidence.outputBlob);
      const expected = record.export?.output?.sha256;
      if (expected == null) {
        checks.outputSha256 = 'unverified'; // not measured at export time — honest
      } else {
        checks.outputSha256 = actual === expected ? 'passed' : 'failed';
        if (checks.outputSha256 !== 'passed') failures.push('output bytes do not match export.output.sha256');
      }
    } catch (err) {
      checks.outputSha256 = 'failed';
      failures.push(`output hash failed: ${err?.message || err}`);
    }
  }
  if (hashFn && evidence.sourceBlob) {
    try {
      const actual = await hashFn(evidence.sourceBlob);
      const expected = record.source?.sha256;
      if (expected == null) {
        checks.sourceSha256 = 'unverified';
      } else {
        checks.sourceSha256 = actual === expected ? 'passed' : 'failed';
        if (checks.sourceSha256 !== 'passed') failures.push('source bytes do not match source.sha256');
      }
    } catch (err) {
      checks.sourceSha256 = 'failed';
      failures.push(`source hash failed: ${err?.message || err}`);
    }
  }

  return {
    ok: failures.length === 0,
    checks,
    failures,
  };
}

/** Filename sidecar for an export name (strip extension, add suffix). */
export function provenanceFilenameFor(exportFilename) {
  const base = String(exportFilename || 'export').replace(/\.[a-z0-9]+$/i, '');
  return `${base}${PROVENANCE_FILENAME_SUFFIX}`;
}

/**
 * Classify a raw provenance sidecar (JSON string, object, or null/undefined)
 * into an actionable VIP-020 verification result:
 *   - `missing_sidecar`
 *   - `malformed_metadata`
 *   - `unsupported_schema`
 *   - `mismatch`
 *   - `verified` (with explicit `partialByteVerification` note if source or
 *     output files were not supplied for byte-level SHA-256 comparison)
 *
 * @param {string|object|null|undefined} rawSidecar
 * @param {{ sourceBlob?: Blob|null, outputBlob?: Blob|null, hashFn?: Function }} [evidence]
 */
export async function classifyProvenanceVerification(rawSidecar, evidence = {}) {
  const emptyChecks = {
    schema: 'unverified',
    manifestDigest: 'unverified',
    outputSha256: 'unverified',
    sourceSha256: 'unverified',
  };

  if (rawSidecar === null || rawSidecar === undefined || rawSidecar === '') {
    return {
      ok: false,
      verdict: PROVENANCE_VERDICT.MISSING_SIDECAR,
      label: 'Missing Sidecar',
      checks: emptyChecks,
      failures: ['No .viprovenance.json sidecar record was provided or exported yet.'],
      action: 'Export a processed file first or choose a .viprovenance.json sidecar file to verify.',
      partialByteVerification: false,
      record: null,
    };
  }

  let parsed = rawSidecar;
  if (typeof rawSidecar === 'string') {
    try {
      parsed = JSON.parse(rawSidecar);
    } catch (err) {
      return {
        ok: false,
        verdict: PROVENANCE_VERDICT.MALFORMED_METADATA,
        label: 'Malformed Metadata',
        checks: emptyChecks,
        failures: [`Invalid JSON in provenance sidecar: ${err?.message || 'parse error'}`],
        action: 'Re-export the file to generate a clean .viprovenance.json sidecar; this JSON file is truncated or syntactically invalid.',
        partialByteVerification: false,
        record: null,
      };
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      verdict: PROVENANCE_VERDICT.MALFORMED_METADATA,
      label: 'Malformed Metadata',
      checks: emptyChecks,
      failures: ['Provenance sidecar root value must be a JSON object.'],
      action: 'Provide a valid .viprovenance.json object generated by VoiceIsolate Pro.',
      partialByteVerification: false,
      record: null,
    };
  }

  if (!('schema' in parsed) && !('schemaVersion' in parsed)) {
    return {
      ok: false,
      verdict: PROVENANCE_VERDICT.MALFORMED_METADATA,
      label: 'Malformed Metadata',
      checks: emptyChecks,
      failures: ['Missing required `schema` and `schemaVersion` fields.'],
      action: 'This JSON file is not a provenance sidecar (for example, it may be a legacy audit array). Export a fresh .viprovenance.json sidecar.',
      partialByteVerification: false,
      record: null,
    };
  }

  if (parsed.schema !== PROVENANCE_SCHEMA || parsed.schemaVersion !== PROVENANCE_SCHEMA_VERSION) {
    return {
      ok: false,
      verdict: PROVENANCE_VERDICT.UNSUPPORTED_SCHEMA,
      label: 'Unsupported Schema',
      checks: { ...emptyChecks, schema: 'failed' },
      failures: [
        `Unsupported schema ${String(parsed.schema)}@${String(parsed.schemaVersion)} `
        + `(expected ${PROVENANCE_SCHEMA}@${PROVENANCE_SCHEMA_VERSION}).`,
      ],
      action: 'Open this sidecar in a compatible version of VoiceIsolate Pro or re-export with schema v1.',
      partialByteVerification: false,
      record: parsed,
    };
  }

  if (typeof parsed.createdAt !== 'string'
    || !parsed.export
    || typeof parsed.export !== 'object'
    || typeof parsed.export.timestamp !== 'string'
    || typeof parsed.manifestDigest !== 'string'
    || !SHA256_RE.test(parsed.manifestDigest)) {
    return {
      ok: false,
      verdict: PROVENANCE_VERDICT.MALFORMED_METADATA,
      label: 'Malformed Metadata',
      checks: { ...emptyChecks, schema: 'passed', manifestDigest: 'failed' },
      failures: ['Missing or malformed mandatory fields (`createdAt`, `export.timestamp`, or 64-hex `manifestDigest`).'],
      action: 'The sidecar is incomplete or damaged. Re-export the processed file to regenerate provenance metadata.',
      partialByteVerification: false,
      record: parsed,
    };
  }

  const base = await verifyProvenanceRecord(parsed, evidence);
  if (!base.ok) {
    return {
      ok: false,
      verdict: PROVENANCE_VERDICT.MISMATCH,
      label: 'Hash / Digest Mismatch',
      checks: base.checks,
      failures: base.failures,
      action: 'One or more SHA-256 digests did not match. Confirm you selected the exact original source file and unmodified exported output.',
      partialByteVerification: false,
      record: parsed,
    };
  }

  const partialByteVerification = base.checks.sourceSha256 !== 'passed'
    || base.checks.outputSha256 !== 'passed';
  const unverifiedParts = [];
  if (base.checks.sourceSha256 !== 'passed') unverifiedParts.push('source bytes');
  if (base.checks.outputSha256 !== 'passed') unverifiedParts.push('output bytes');

  return {
    ok: true,
    verdict: PROVENANCE_VERDICT.VERIFIED,
    label: partialByteVerification ? 'Manifest Verified (Partial Byte Check)' : 'Verified (All Hashes Match)',
    checks: base.checks,
    failures: [],
    action: partialByteVerification
      ? `Manifest digest passed; ${unverifiedParts.join(' and ')} not supplied for byte comparison.`
      : 'Manifest digest, source SHA-256, and exported output SHA-256 all match.',
    partialByteVerification,
    record: parsed,
  };
}

export default {
  buildProvenanceRecord,
  provenanceManifestDigest,
  verifyProvenanceRecord,
  classifyProvenanceVerification,
  canonicalJson,
  provenanceFilenameFor,
  PROVENANCE_SCHEMA,
  PROVENANCE_SCHEMA_VERSION,
  PROVENANCE_VERDICT,
  PROVENANCE_NON_CERTIFICATION_DISCLAIMER,
};
