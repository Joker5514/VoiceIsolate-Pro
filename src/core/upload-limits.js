/**
 * VoiceIsolate Pro — upload size & memory policy (Layer 1: Core)
 *
 * VIP-009 (IMPLEMENTATION_READINESS_AUDIT_2026-11-02). The ingestion path used
 * to accept any file size (`MAX_FILE_BYTES = Number.MAX_SAFE_INTEGER`) and
 * decode it whole; a file larger than device memory could OOM the tab before
 * any timeout fired. This module makes the policy explicit and device-aware:
 *
 *  - a **file-bytes hard cap** per performance tier refuses absurd uploads
 *    before any read/decode work;
 *  - a **WAV header probe** derives duration / channel / sample-rate facts
 *    before decoding (WAV is effectively raw PCM, so its decoded size is
 *    predictable) and refuses early when the decoded PCM would exceed the
 *    tier budget;
 *  - a **decoded-PCM budget** is also enforceable post-decode (the reliable
 *    check for compressed containers whose decoded size is unknowable
 *    up-front) — `assertDecodedWithinBudget`;
 *  - a **soft warning** threshold reports large-but-accepted inputs so the UI
 *    can warn without blocking legitimate workflows.
 *
 * Policy principles (per implementation brief):
 *  - never silently downsample or truncate;
 *  - refusal messages must say what the user can do next;
 *  - limits are derived from measured anchors: one full-length stereo stem
 *    pair is ~384 KB per second of 48 kHz audio (see MLStemCache/PerformanceTier),
 *    and the pipeline transiently holds several full-length copies
 *    (decoded channels, stems, playback buffers, analysis passes).
 *
 * Pure module: no DOM, no Web Audio, no I/O. `probeWavHeader` parses a byte
 * header the caller read from the blob.
 */
'use strict';

import { detectPerformanceTier } from './PerformanceTier.js';

const MB = 1024 * 1024;
const GB = 1024 * MB;

/**
 * Per-tier upload policy.
 *
 * fileBytes — hard refusal before reading/decoding anything.
 *   Sized far above any realistic compressed recording for the tier while
 *   still bounding the worst case (a WAV carries ~1:1 PCM bytes).
 * decodedPcmBytes — hard cap on decoded float32 PCM (channels × frames × 4),
 *   measured against the pipeline's several-full-length-copies behaviour.
 * warnFileBytes — soft-warning threshold (still accepted).
 *
 * Anchors: 5 min of 48 kHz stereo decodes to ~115 MB float32 and its stem
 * pair alone is ~230 MB (MLStemCache docs); the perf harness validates
 * 300 s stereo. Budgets stay ~2× beyond that anchor on constrained devices
 * and grow with tier. These are safety ceilings, not target sizes.
 */
export const UPLOAD_POLICY = Object.freeze({
  HIGH: Object.freeze({
    fileBytes: 8 * GB,
    decodedPcmBytes: 3 * GB,
    warnFileBytes: 512 * MB,
  }),
  BALANCED: Object.freeze({
    fileBytes: 2 * GB,
    decodedPcmBytes: 768 * MB,
    warnFileBytes: 256 * MB,
  }),
  CONSTRAINED: Object.freeze({
    fileBytes: 512 * MB,
    decodedPcmBytes: 192 * MB,
    warnFileBytes: 64 * MB,
  }),
});

/** Absolute backstop regardless of tier (browser Blob limits are lower). */
export const ABSOLUTE_MAX_FILE_BYTES = 8 * GB;

export const UPLOAD_SEVERITY = Object.freeze({ OK: 'ok', WARN: 'warn', REFUSE: 'refuse' });

export const UPLOAD_CODES = Object.freeze({
  OK: 'OK',
  WARN_LARGE_FILE: 'WARN_LARGE_FILE',
  REFUSE_FILE_BYTES: 'REFUSE_FILE_BYTES',
  REFUSE_DECODED_PCM: 'REFUSE_DECODED_PCM',
});

/** @param {number} bytes @returns {string} */
export function humanBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown size';
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`;
  if (bytes >= MB) return `${(bytes / MB).toFixed(0)} MB`;
  return `${Math.ceil(bytes / 1024)} KB`;
}

/** @returns {Readonly<{fileBytes:number, decodedPcmBytes:number, warnFileBytes:number}>} */
export function policyFor(tier) {
  return UPLOAD_POLICY[tier] || UPLOAD_POLICY.HIGH;
}

/**
 * Parse a WAV/RIFF header prefix for decode-cost facts.
 * Returns null (not an error) for anything that is not a well-formed
 * PCM/float WAVE header — callers fall back to file-size heuristics and the
 * decoder stays the final judge.
 *
 * @param {ArrayBuffer|Uint8Array} head first ≥ 44 bytes of the file
 * @returns {{channels:number, sampleRate:number, bitsPerSample:number, dataBytes:number, durationSec:number}|null}
 */
export function probeWavHeader(head) {
  const bytes = head instanceof Uint8Array ? head : new Uint8Array(head || 0);
  if (bytes.length < 44) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;

  // Walk chunks so a large fmt/list chunk cannot hide the data chunk. The
  // probe only ever reads the provided prefix: dataBytes comes from the
  // chunk header, not from scanning the payload.
  let dataBytes = null;
  let fmt = null;
  let off = 12;
  while (off + 8 <= bytes.length) {
    const id = tag(off);
    const size = view.getUint32(off + 4, true);
    if (id === 'fmt ' && off + 8 + 16 <= bytes.length) {
      fmt = {
        audioFormat: view.getUint16(off + 8, true),
        channels: view.getUint16(off + 10, true),
        sampleRate: view.getUint32(off + 12, true),
        bitsPerSample: view.getUint16(off + 22, true),
      };
    } else if (id === 'data') {
      dataBytes = size;
      break;
    }
    if (!Number.isFinite(size) || size < 0) return null;
    off += 8 + size + (size % 2);
    if (off > bytes.length) break;
  }
  if (!fmt || dataBytes == null) return null;
  const { channels, sampleRate, bitsPerSample } = fmt;
  if (!(channels >= 1 && channels <= 32) || !(sampleRate >= 1000 && sampleRate <= 768_000)) return null;
  if (![8, 16, 24, 32, 64].includes(bitsPerSample)) return null;
  const bytesPerSample = bitsPerSample / 8;
  const frameBytes = bytesPerSample * channels;
  if (frameBytes <= 0) return null;
  // 0xFFFFFFFF data size = streaming/unknown length — treat as unknown.
  const known = dataBytes !== 0xFFFFFFFF && dataBytes > 0;
  return {
    channels,
    sampleRate,
    bitsPerSample,
    dataBytes: known ? dataBytes : null,
    durationSec: known ? dataBytes / frameBytes / sampleRate : null,
  };
}

/**
 * Evaluate an upload against the tier policy.
 *
 * @param {object} input
 * @param {number} input.sizeBytes            file size in bytes (required)
 * @param {ReturnType<typeof probeWavHeader>} [input.probe]  WAV probe result, if any
 * @param {number} [input.sampleRate]         probe sample rate for PCM math
 * @param {'HIGH'|'BALANCED'|'CONSTRAINED'} [input.tier]
 * @returns {{severity:'ok'|'warn'|'refuse', code:string, message:string|null,
 *            tier:string, estimates:{decodedBytesEstimate:number|null, durationSecEstimate:number|null}}}
 */
export function evaluateUpload({ sizeBytes, probe = null, tier } = {}) {
  const resolvedTier = tier || detectPerformanceTier();
  const policy = policyFor(resolvedTier);
  const size = Number(sizeBytes);
  const estimates = { decodedBytesEstimate: null, durationSecEstimate: null };

  if (!Number.isFinite(size) || size < 0) {
    return {
      severity: UPLOAD_SEVERITY.REFUSE,
      code: UPLOAD_CODES.REFUSE_FILE_BYTES,
      message: '[VIP][FileIngestion] Could not determine the file size.',
      tier: resolvedTier,
      estimates,
    };
  }

  if (size > policy.fileBytes || size > ABSOLUTE_MAX_FILE_BYTES) {
    return {
      severity: UPLOAD_SEVERITY.REFUSE,
      code: UPLOAD_CODES.REFUSE_FILE_BYTES,
      message:
        `[VIP][FileIngestion] This file (${humanBytes(size)}) exceeds the ${humanBytes(Math.min(policy.fileBytes, ABSOLUTE_MAX_FILE_BYTES))} ` +
        'limit for this device. Try a shorter recording, split the file, or use a device with more memory.',
      tier: resolvedTier,
      estimates,
    };
  }

  // WAV (and only WAV): decoded size is knowable exactly before decoding.
  // A header claiming more payload than the file physically holds is corrupt
  // (truncated download, bogus writer) — ignore the probe rather than refuse
  // with a misleading "recording too long" message; the decoder will surface
  // the real failure.
  const probeTrustworthy = probe && probe.dataBytes != null && probe.dataBytes <= size;
  if (probeTrustworthy) {
    const decodedBytes = probe.dataBytes / (probe.bitsPerSample / 8) * 4; // → float32
    estimates.decodedBytesEstimate = decodedBytes;
    estimates.durationSecEstimate = probe.durationSec;
    if (decodedBytes > policy.decodedPcmBytes) {
      const minutes = Number.isFinite(probe.durationSec) ? ` (${Math.round(probe.durationSec / 60)} min)` : '';
      return {
        severity: UPLOAD_SEVERITY.REFUSE,
        code: UPLOAD_CODES.REFUSE_DECODED_PCM,
        message:
          `[VIP][FileIngestion] This recording${minutes} would decode to about ${humanBytes(decodedBytes)} of audio data, ` +
          `over the ${humanBytes(policy.decodedPcmBytes)} processing budget for this device. ` +
          'Trim the recording, lower the sample rate, or use a desktop device.',
        tier: resolvedTier,
        estimates,
      };
    }
  }

  if (size > policy.warnFileBytes) {
    return {
      severity: UPLOAD_SEVERITY.WARN,
      code: UPLOAD_CODES.WARN_LARGE_FILE,
      message:
        `[VIP][FileIngestion] Large file (${humanBytes(size)}) — processing may take several minutes and use significant memory on this device.`,
      tier: resolvedTier,
      estimates,
    };
  }
  return { severity: UPLOAD_SEVERITY.OK, code: UPLOAD_CODES.OK, message: null, tier: resolvedTier, estimates };
}

/**
 * Post-decode guard for containers whose decoded size is unknowable before
 * decoding (mp3/m4a/…). Throws a descriptive RangeError when the decoded PCM
 * exceeds the tier budget. Never truncates: the caller must refuse.
 *
 * @param {number} decodedBytes total bytes across decoded float32 channels
 * @param {'HIGH'|'BALANCED'|'CONSTRAINED'} [tier]
 * @param {number} [sampleRate] for the message's duration estimate (default 48 kHz)
 */
export function assertDecodedWithinBudget(decodedBytes, tier, sampleRate = 48_000) {
  const resolvedTier = tier || detectPerformanceTier();
  const policy = policyFor(resolvedTier);
  const bytes = Number(decodedBytes);
  if (!Number.isFinite(bytes) || bytes < 0) return;
  if (bytes > policy.decodedPcmBytes) {
    const seconds = bytes / (sampleRate * 2 * 4); // stereo float32 estimate
    const minutes = Number.isFinite(seconds) ? ` (~${Math.round(seconds / 60)} min stereo)` : '';
    throw new RangeError(
      `[VIP][FileIngestion] The decoded audio${minutes} is about ${humanBytes(bytes)}, ` +
      `over the ${humanBytes(policy.decodedPcmBytes)} processing budget for this device. ` +
      'Trim the recording, lower the sample rate, or use a desktop device.'
    );
  }
}

export default { evaluateUpload, probeWavHeader, assertDecodedWithinBudget, policyFor, humanBytes, UPLOAD_POLICY };
