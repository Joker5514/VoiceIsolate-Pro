/**
 * Runtime validation for SAM 3 vision sidecar messages and frame results.
 * Pure module — no DOM, no network, no audio.
 */
'use strict';

/** Default hard caps (memory / real-time safety). */
export const SAM3_LIMITS = Object.freeze({
  MAX_TRACKS: 16,
  MAX_PROMPT_CHARS: 256,
  MAX_FRAME_WIDTH: 4096,
  MAX_FRAME_HEIGHT: 4096,
  MAX_MASK_BYTES: 4096 * 4096,
  MAX_PENDING_OUT_OF_ORDER: 32,
  MIN_SCORE: 0,
  MAX_SCORE: 1,
});

/**
 * @typedef {[number, number, number, number]} Sam3Box  // x,y,w,h normalized or px
 * @typedef {{
 *   trackId: number,
 *   label: string,
 *   score: number,
 *   box: Sam3Box,
 *   mask?: Uint8Array|null,
 * }} Sam3Track
 * @typedef {{
 *   frameIndex: number,
 *   timestampMs: number,
 *   tracks: Sam3Track[],
 * }} Sam3FrameResult
 */

/**
 * @param {unknown} box
 * @returns {box is Sam3Box}
 */
export function isValidBox(box) {
  if (!Array.isArray(box) || box.length !== 4) return false;
  return box.every((n) => typeof n === 'number' && Number.isFinite(n));
}

/**
 * @param {unknown} track
 * @param {{ maxMaskBytes?: number }} [opts]
 * @returns {{ ok: boolean, reason?: string, track?: Sam3Track }}
 */
export function validateTrack(track, opts = {}) {
  const maxMask = opts.maxMaskBytes ?? SAM3_LIMITS.MAX_MASK_BYTES;
  if (!track || typeof track !== 'object') return { ok: false, reason: 'track-not-object' };
  const t = /** @type {Record<string, unknown>} */ (track);
  const trackId = Number(t.trackId);
  if (!Number.isInteger(trackId) || trackId < 0) return { ok: false, reason: 'bad-trackId' };
  const label = t.label == null ? '' : String(t.label);
  if (label.length > SAM3_LIMITS.MAX_PROMPT_CHARS) return { ok: false, reason: 'label-too-long' };
  const score = Number(t.score);
  if (!Number.isFinite(score) || score < SAM3_LIMITS.MIN_SCORE || score > SAM3_LIMITS.MAX_SCORE) {
    return { ok: false, reason: 'bad-score' };
  }
  if (!isValidBox(t.box)) return { ok: false, reason: 'bad-box' };
  let mask = null;
  if (t.mask != null) {
    if (t.mask instanceof Uint8Array) {
      if (t.mask.byteLength > maxMask) return { ok: false, reason: 'mask-too-large' };
      mask = t.mask;
    } else if (ArrayBuffer.isView(t.mask)) {
      const u8 = new Uint8Array(t.mask.buffer, t.mask.byteOffset, t.mask.byteLength);
      if (u8.byteLength > maxMask) return { ok: false, reason: 'mask-too-large' };
      mask = u8;
    } else {
      return { ok: false, reason: 'mask-type' };
    }
  }
  return {
    ok: true,
    track: {
      trackId,
      label,
      score,
      box: /** @type {Sam3Box} */ ([.../** @type {number[]} */ (t.box)]),
      mask,
    },
  };
}

/**
 * @param {unknown} result
 * @param {{ maxTracks?: number }} [opts]
 * @returns {{ ok: boolean, reason?: string, result?: Sam3FrameResult }}
 */
export function validateFrameResult(result, opts = {}) {
  const maxTracks = opts.maxTracks ?? SAM3_LIMITS.MAX_TRACKS;
  if (!result || typeof result !== 'object') return { ok: false, reason: 'result-not-object' };
  const r = /** @type {Record<string, unknown>} */ (result);
  const frameIndex = Number(r.frameIndex);
  if (!Number.isInteger(frameIndex) || frameIndex < 0) {
    return { ok: false, reason: 'bad-frameIndex' };
  }
  const timestampMs = Number(r.timestampMs);
  if (!Number.isFinite(timestampMs) || timestampMs < 0) {
    return { ok: false, reason: 'bad-timestampMs' };
  }
  if (!Array.isArray(r.tracks)) return { ok: false, reason: 'tracks-not-array' };
  if (r.tracks.length > maxTracks) return { ok: false, reason: 'too-many-tracks' };

  /** @type {Sam3Track[]} */
  const tracks = [];
  for (let i = 0; i < r.tracks.length; i++) {
    const v = validateTrack(r.tracks[i]);
    if (!v.ok) return { ok: false, reason: `track[${i}]:${v.reason}` };
    tracks.push(/** @type {Sam3Track} */ (v.track));
  }
  return {
    ok: true,
    result: { frameIndex, timestampMs, tracks },
  };
}

/**
 * Compact metadata safe for AudioWorklet port messages (no masks, bounded).
 * @param {Sam3FrameResult} result
 * @param {{ maxTracks?: number, minScore?: number }} [opts]
 */
export function toWorkletMetadata(result, opts = {}) {
  const maxTracks = opts.maxTracks ?? 8;
  const minScore = opts.minScore ?? 0.25;
  const v = validateFrameResult(result, { maxTracks: SAM3_LIMITS.MAX_TRACKS });
  if (!v.ok || !v.result) return { ok: false, reason: v.reason, meta: null };
  const tracks = v.result.tracks
    .filter((t) => t.score >= minScore)
    .slice(0, maxTracks)
    .map((t) => ({
      trackId: t.trackId,
      label: t.label.slice(0, 64),
      score: Math.round(t.score * 1000) / 1000,
      box: t.box.map((n) => Math.round(n * 1000) / 1000),
    }));
  return {
    ok: true,
    meta: {
      type: 'sam3-tracks',
      frameIndex: v.result.frameIndex,
      timestampMs: v.result.timestampMs,
      tracks,
    },
  };
}

export default {
  SAM3_LIMITS,
  isValidBox,
  validateTrack,
  validateFrameResult,
  toWorkletMetadata,
};
