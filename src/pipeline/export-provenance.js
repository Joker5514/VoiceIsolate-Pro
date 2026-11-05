/**
 * VoiceIsolate Pro — export integrity sidecar (Layer 3: Pipeline)
 *
 * VIP-010 follow-through: Landing already downloads a `.viprovenance.json`
 * record. Engineer Save Processed, Drive save, video remux, and the Analysis
 * Workspace export did not. This helper builds the same schema-v1 record and
 * hands the sidecar to the caller.
 *
 * The record is an integrity check, not a signature and not certification.
 * A failure here must not block the audio the user asked to save. Cancellation
 * still aborts, so a cancelled export does not leave a half-written pair.
 */
'use strict';

import {
  buildProvenanceRecord,
  provenanceFilenameFor,
} from '../core/Provenance.js';
import {
  INFERENCE_REVISION,
  MODEL_MANIFEST,
  modelChainRevision,
} from '../core/ModelManifest.js';
import { hashSourceBlob, HashAbortError } from './SourceHash.js';
import { triggerBlobDownload } from './video-export.js';

function isCancellation(err, signal) {
  return Boolean(signal?.aborted)
    || err instanceof HashAbortError
    || err?.name === 'AbortError'
    || err?.name === 'CancellationError'
    || err?.code === 'CANCELLED';
}

async function readAppVersion() {
  if (typeof fetch !== 'function') return null;
  try {
    const response = await fetch('/manifest.json');
    if (!response?.ok) return null;
    const manifest = await response.json();
    return typeof manifest?.version === 'string' && manifest.version ? manifest.version : null;
  } catch {
    return null;
  }
}

/**
 * Hash the export (and the original file, when we still have it), build the
 * provenance record, and deliver the sidecar.
 *
 * @param {object} input
 * @param {Blob} input.outputBlob
 * @param {string} input.filename
 * @param {string} [input.format]
 * @param {Blob|File|null} [input.sourceFile]
 * @param {AbortSignal|null} [input.signal]
 * @param {object} [input.options]
 * @param {object|null} [input.parameters]
 * @param {Array<{id?: string, status?: string, detail?: string}>|null} [input.operations]
 * @param {string[]} [input.modelIds]
 * @param {string|null} [input.appVersion]
 * @param {(blob: Blob, filename: string) => void} [input.deliver]
 * @returns {Promise<{ ok: boolean, filename?: string, record?: object, blob?: Blob, error?: string }>}
 */
export async function publishExportProvenance(input = {}) {
  const {
    outputBlob,
    filename,
    format = 'wav',
    sourceFile = null,
    signal = null,
    options = {},
    parameters = null,
    operations = null,
    modelIds = [],
    appVersion = null,
    deliver = triggerBlobDownload,
  } = input;

  if (!outputBlob || typeof filename !== 'string' || !filename) {
    return { ok: false, error: 'Export provenance needs the output blob and filename.' };
  }
  if (signal?.aborted) throw new HashAbortError();

  try {
    const ids = Array.isArray(modelIds) ? modelIds.filter((id) => typeof id === 'string' && id) : [];
    const [outHash, srcHash, version] = await Promise.all([
      hashSourceBlob(outputBlob, { signal }),
      sourceFile ? hashSourceBlob(sourceFile, { signal }) : Promise.resolve(null),
      appVersion != null ? Promise.resolve(appVersion) : readAppVersion(),
    ]);
    if (signal?.aborted) throw new HashAbortError();

    const record = buildProvenanceRecord({
      source: sourceFile ? {
        name: sourceFile.name || null,
        sizeBytes: Number.isFinite(sourceFile.size) ? sourceFile.size : null,
        mimeType: sourceFile.type || null,
        sha256: srcHash?.hex || null,
      } : null,
      export: {
        format,
        options: options && typeof options === 'object' ? options : {},
        output: {
          filename,
          sizeBytes: Number.isFinite(outputBlob.size) ? outputBlob.size : null,
          sha256: outHash?.hex || null,
        },
      },
      application: {
        version: version || null,
        inferenceRevision: INFERENCE_REVISION,
        modelChainRevision: ids.length ? modelChainRevision(ids) : null,
        modelIds: ids,
        models: ids.map((id) => ({ id, sha256: MODEL_MANIFEST[id]?.sha256 || null })),
      },
      processing: {
        parameters: parameters && typeof parameters === 'object' ? parameters : null,
        operations: Array.isArray(operations) ? operations : null,
      },
    });

    const sidecarName = provenanceFilenameFor(filename);
    const sidecarBlob = new Blob(
      [JSON.stringify(record, null, 2)],
      { type: 'application/json' },
    );
    if (typeof deliver === 'function') deliver(sidecarBlob, sidecarName);
    return { ok: true, filename: sidecarName, record, blob: sidecarBlob };
  } catch (err) {
    if (isCancellation(err, signal)) throw err;
    console.warn('[VIP][provenance] sidecar unavailable (export continues)', err);
    return { ok: false, error: err?.message || String(err) };
  }
}

export default { publishExportProvenance };
