/**
 * VoiceIsolate Pro — Engineer Provenance Coordinator (Layer 3: Pipeline)
 *
 * VIP-020: Coordinates source SHA-256 hashing on file import, chronological
 * operation history (`completed`, `cancelled`, `failed`), deterministic dither
 * seeding for forensic reruns, export `.viprovenance.json` sidecar creation
 * across all Engineer export paths, and live/external verification.
 */
'use strict';

import {
  buildProvenanceRecord,
  provenanceFilenameFor,
  classifyProvenanceVerification,
  PROVENANCE_NON_CERTIFICATION_DISCLAIMER,
} from '../core/Provenance.js';
import {
  MODEL_MANIFEST,
  INFERENCE_REVISION,
  modelChainRevision,
} from '../core/ModelManifest.js';
import { snapshotParams } from '../core/ParameterSchema.js';
import { hashSourceBlob } from './SourceHash.js';

const MAX_OPERATIONS = 200;

/**
 * Derive a deterministic uint32 dither seed from a 64-hex SHA-256 digest
 * (or fallback string) so Forensic-mode exports are bit-reproducible (VIP-040).
 * @param {string|null} sha256Hex
 * @returns {number}
 */
export function deriveDitherSeedFromHash(sha256Hex) {
  if (typeof sha256Hex === 'string' && /^[0-9a-f]{8}/i.test(sha256Hex)) {
    const parsed = Number.parseInt(sha256Hex.slice(0, 8), 16) >>> 0;
    return parsed || 0x56495031;
  }
  return 0x56495031; // 'VIP1'
}

export class EngineerProvenanceCoordinator {
  /**
   * @param {{
   *   hashBlobFn?: (blob: Blob, opts?: object) => Promise<{ hex: string, bytes: number }>,
   *   fetchVersionFn?: () => Promise<string|null>,
   * }} [opts]
   */
  constructor(opts = {}) {
    this._hashBlobFn = opts.hashBlobFn || hashSourceBlob;
    this._fetchVersionFn = opts.fetchVersionFn || (async () => {
      try {
        if (typeof globalThis.fetch !== 'function') return null;
        const r = await globalThis.fetch('/manifest.json');
        if (!r.ok) return null;
        const j = await r.json();
        return j?.version || null;
      } catch {
        return null;
      }
    });

    this._listeners = new Set();
    this._sourceAbort = null;
    this._sourcePromise = null;
    this._appVersionPromise = null;
    this.reset();
  }

  reset() {
    try { this._sourceAbort?.abort(); } catch { /* ignore */ }
    this._sourceAbort = null;
    this._sourcePromise = null;
    this._source = null; // { file, name, sizeBytes, mimeType, sha256, status, importedAt, error }
    this._operations = [];
    this._lastExport = null; // { record, sidecarFilename, sidecarBlob, outputBlob, outputFilename }
    this._lastVerification = null;
    this._lastProcessSnapshot = null; // { modelIds, processingEngine, effectiveParams, timestamp }
    this._notify();
  }

  subscribe(fn) {
    if (typeof fn !== 'function') return () => {};
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _notify() {
    const state = this.getState();
    for (const fn of this._listeners) {
      try { fn(state); } catch { /* ignore listener errors */ }
    }
  }

  getState() {
    return {
      disclaimer: PROVENANCE_NON_CERTIFICATION_DISCLAIMER,
      source: this._source ? {
        name: this._source.name,
        sizeBytes: this._source.sizeBytes,
        mimeType: this._source.mimeType,
        sha256: this._source.sha256,
        status: this._source.status,
        importedAt: this._source.importedAt,
        error: this._source.error || null,
      } : null,
      operations: [...this._operations],
      lastProcessSnapshot: this._lastProcessSnapshot ? { ...this._lastProcessSnapshot } : null,
      lastExport: this._lastExport ? {
        record: this._lastExport.record,
        sidecarFilename: this._lastExport.sidecarFilename,
        outputFilename: this._lastExport.outputFilename,
      } : null,
      lastVerification: this._lastVerification,
    };
  }

  /**
   * Append an operation entry (`completed`, `cancelled`, or `failed`).
   * @param {{ id: string, status?: 'completed'|'cancelled'|'failed', detail?: string|null, timestamp?: string }} op
   */
  recordOperation(op) {
    if (!op || !op.id) return;
    const entry = {
      id: String(op.id),
      status: op.status || 'completed',
      timestamp: op.timestamp || new Date().toISOString(),
      detail: op.detail != null ? String(op.detail) : null,
    };
    this._operations.push(entry);
    if (this._operations.length > MAX_OPERATIONS) {
      this._operations.splice(0, this._operations.length - MAX_OPERATIONS);
    }
    this._notify();
  }

  /**
   * Record source file import and start streaming SHA-256 computation.
   * @param {File|Blob} file
   * @returns {Promise<string|null>} resolves to hex SHA-256 or null if cancelled/failed
   */
  recordSourceImport(file) {
    this.reset();
    if (!file) return Promise.resolve(null);

    const ctl = new AbortController();
    this._sourceAbort = ctl;
    const importedAt = new Date().toISOString();
    this._source = {
      file,
      name: file.name || 'unnamed',
      sizeBytes: typeof file.size === 'number' ? file.size : null,
      mimeType: file.type || null,
      sha256: null,
      status: 'hashing',
      importedAt,
      error: null,
    };
    this.recordOperation({
      id: 'import',
      status: 'completed',
      timestamp: importedAt,
      detail: `${this._source.name} (${this._source.sizeBytes ?? 0} bytes)`,
    });

    const promise = this._hashBlobFn(file, { signal: ctl.signal })
      .then((res) => {
        if (ctl.signal.aborted || !this._source || this._source.file !== file) return null;
        this._source.sha256 = res?.hex || null;
        this._source.status = this._source.sha256 ? 'ready' : 'unavailable';
        this._notify();
        return this._source.sha256;
      })
      .catch((err) => {
        if (ctl.signal.aborted || !this._source || this._source.file !== file) return null;
        this._source.status = 'error';
        this._source.error = err?.message || String(err);
        this._notify();
        return null;
      });

    this._sourcePromise = promise;
    return promise;
  }

  /**
   * Capture model chain & effective parameter snapshot at process completion.
   * @param {{ modelIds?: string[], processingEngine?: string, effectiveParams?: object }} info
   */
  recordProcessSnapshot(info = {}) {
    const engine = info.processingEngine || 'ml-worker';
    const rawIds = Array.isArray(info.modelIds)
      ? info.modelIds.filter((id) => typeof id === 'string' && id)
      : [];
    const modelIds = engine === 'dsp-fallback' ? [] : [...rawIds];
    const paramsSnap = info.effectiveParams ? snapshotParams(info.effectiveParams) : null;
    this._lastProcessSnapshot = {
      modelIds,
      processingEngine: engine,
      effectiveParams: paramsSnap,
      timestamp: new Date().toISOString(),
    };
    this.recordOperation({
      id: 'process',
      status: 'completed',
      timestamp: this._lastProcessSnapshot.timestamp,
      detail: engine === 'dsp-fallback'
        ? 'Classical DSP fallback (ML bypassed)'
        : `Model chain: ${modelIds.join(' -> ') || 'none'}`,
    });
  }

  /**
   * Compute a reproducible uint32 dither seed from the source SHA-256.
   */
  getDeterministicDitherSeed() {
    return deriveDitherSeedFromHash(this._source?.sha256 || null);
  }

  async _resolveAppVersion() {
    if (!this._appVersionPromise) {
      this._appVersionPromise = Promise.resolve(this._fetchVersionFn()).catch(() => null);
    }
    return this._appVersionPromise;
  }

  /**
   * Build and store canonical `.viprovenance.json` sidecar for an exported file.
   *
   * @param {{
   *   outputBlob: Blob,
   *   filename: string,
   *   format?: string,
   *   sampleRate?: number|null,
   *   channels?: number|null,
   *   region?: { in: number, out: number }|null,
   *   ditherAmt?: number|null,
   *   ditherSeed?: number|null,
   *   effectiveParams?: object|null,
   *   modelIds?: string[]|null,
   *   processingEngine?: string|null,
   *   destination?: string,
   *   signal?: AbortSignal|null,
   * }} opts
   */
  async recordExport(opts) {
    if (!opts || !opts.outputBlob || !opts.filename) {
      throw new TypeError('[VIP][EngineerProvenance] outputBlob and filename are required');
    }
    const signal = opts.signal || null;
    if (this._sourcePromise) {
      try { await this._sourcePromise; } catch { /* handled on _source */ }
    }
    const [outHash, appVersion] = await Promise.all([
      this._hashBlobFn(opts.outputBlob, { signal }),
      this._resolveAppVersion(),
    ]);

    const engine = opts.processingEngine || this._lastProcessSnapshot?.processingEngine || 'ml-worker';
    const provided = Array.isArray(opts.modelIds)
      ? opts.modelIds
      : this._lastProcessSnapshot?.modelIds;
    const modelIds = engine === 'dsp-fallback'
      ? []
      : (Array.isArray(provided) ? provided.filter((id) => typeof id === 'string' && id) : []);
    const paramsSnap = opts.effectiveParams
      ? snapshotParams(opts.effectiveParams)
      : (this._lastProcessSnapshot?.effectiveParams || null);

    const exportTimestamp = new Date().toISOString();
    const opsWithExport = [
      ...this._operations,
      {
        id: 'export',
        status: 'completed',
        timestamp: exportTimestamp,
        detail: `${opts.filename}${opts.destination ? ` (${opts.destination})` : ''}`,
      },
    ];

    const record = buildProvenanceRecord({
      createdAt: exportTimestamp,
      source: this._source ? {
        name: this._source.name,
        sizeBytes: this._source.sizeBytes,
        mimeType: this._source.mimeType,
        sha256: this._source.sha256,
      } : null,
      export: {
        timestamp: exportTimestamp,
        format: opts.format || (opts.filename.toLowerCase().endsWith('.mp4') ? 'mp4' : 'wav'),
        options: {
          sampleRate: opts.sampleRate ?? null,
          channels: opts.channels ?? null,
          region: opts.region || null,
          ditherAmt: opts.ditherAmt ?? null,
          ditherSeed: Number.isFinite(opts.ditherSeed) ? opts.ditherSeed : null,
          processingEngine: engine,
        },
        output: {
          filename: opts.filename,
          sizeBytes: opts.outputBlob.size ?? outHash?.bytes ?? null,
          sha256: outHash?.hex || null,
        },
      },
      application: {
        version: appVersion,
        inferenceRevision: INFERENCE_REVISION,
        modelChainRevision: modelIds.length ? modelChainRevision(modelIds) : null,
        modelIds,
        models: modelIds.map((id) => ({
          id,
          sha256: MODEL_MANIFEST[id]?.sha256 || null,
        })),
      },
      processing: {
        parameters: paramsSnap,
        operations: opsWithExport,
      },
    });

    this.recordOperation({
      id: 'export',
      status: 'completed',
      timestamp: exportTimestamp,
      detail: `${opts.filename}${opts.destination ? ` (${opts.destination})` : ''}`,
    });

    const sidecarFilename = provenanceFilenameFor(opts.filename);
    const jsonText = JSON.stringify(record, null, 2);
    const sidecarBlob = new Blob([jsonText], { type: 'application/json' });

    this._lastExport = {
      record,
      jsonText,
      sidecarFilename,
      sidecarBlob,
      outputBlob: opts.outputBlob,
      outputFilename: opts.filename,
    };

    // Immediately run self-verification against the live session blobs so the
    // Forensic Inspector displays verified status out of the box.
    this._lastVerification = await classifyProvenanceVerification(record, {
      sourceBlob: this._source?.file || null,
      outputBlob: opts.outputBlob,
      hashFn: async (b) => (await this._hashBlobFn(b)).hex,
    });
    this._notify();
    return this._lastExport;
  }

  getLastExport() {
    return this._lastExport;
  }

  /**
   * Re-verify the current session's latest export record against live source & output blobs.
   */
  async verifyCurrentSession() {
    const res = await classifyProvenanceVerification(
      this._lastExport?.record || null,
      {
        sourceBlob: this._source?.file || null,
        outputBlob: this._lastExport?.outputBlob || null,
        hashFn: async (b) => (await this._hashBlobFn(b)).hex,
      },
    );
    this._lastVerification = res;
    this._notify();
    return res;
  }

  /**
   * Verify an arbitrary `.viprovenance.json` sidecar file/text against optional
   * user-supplied source and output files.
   *
   * @param {{ sidecarText?: string|object|null, sourceBlob?: Blob|null, outputBlob?: Blob|null }} input
   */
  async verifyExternalSidecar(input = {}) {
    const res = await classifyProvenanceVerification(
      input.sidecarText ?? null,
      {
        sourceBlob: input.sourceBlob || null,
        outputBlob: input.outputBlob || null,
        hashFn: async (b) => (await this._hashBlobFn(b)).hex,
      },
    );
    this._lastVerification = res;
    this._notify();
    return res;
  }
}

export default {
  EngineerProvenanceCoordinator,
  deriveDitherSeedFromHash,
};
