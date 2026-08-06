/**
 * Temporal track association / smoothing for SAM 3 frame results.
 * Does not run inference — consumes ImageSegmenter outputs.
 * Never blocks; O(T²) with small T (≤ MAX_TRACKS).
 */
'use strict';

import { validateFrameResult, SAM3_LIMITS } from './types.js';
import { boxIoU } from './image_segmenter.js';

/**
 * @typedef {import('./types.js').Sam3FrameResult} Sam3FrameResult
 * @typedef {import('./types.js').Sam3Track} Sam3Track
 */

/**
 * Reorder / reject out-of-order frames.
 */
export class FrameOrderGate {
  /**
   * @param {{ maxPending?: number }} [opts]
   */
  constructor(opts = {}) {
    this.maxPending = opts.maxPending ?? SAM3_LIMITS.MAX_PENDING_OUT_OF_ORDER;
    this._lastIndex = -1;
    /** @type {Map<number, Sam3FrameResult>} */
    this._pending = new Map();
  }

  reset() {
    this._lastIndex = -1;
    this._pending.clear();
  }

  /**
   * @param {Sam3FrameResult} result
   * @returns {{ emit: Sam3FrameResult[], rejected: string|null }}
   */
  push(result) {
    const v = validateFrameResult(result);
    if (!v.ok || !v.result) return { emit: [], rejected: v.reason || 'invalid' };
    const r = v.result;
    const emit = [];

    if (r.frameIndex <= this._lastIndex) {
      return { emit: [], rejected: 'stale-or-duplicate-frame' };
    }

    if (this._lastIndex < 0 || r.frameIndex === this._lastIndex + 1) {
      emit.push(r);
      this._lastIndex = r.frameIndex;
      // Drain pending contiguous
      while (this._pending.has(this._lastIndex + 1)) {
        const next = this._pending.get(this._lastIndex + 1);
        this._pending.delete(this._lastIndex + 1);
        emit.push(/** @type {Sam3FrameResult} */ (next));
        this._lastIndex += 1;
      }
      return { emit, rejected: null };
    }

    // Gap — buffer
    if (this._pending.size >= this.maxPending) {
      return { emit: [], rejected: 'pending-overflow' };
    }
    this._pending.set(r.frameIndex, r);
    return { emit: [], rejected: null };
  }
}

export class VideoTracker {
  /**
   * @param {{
   *   maxTracks?: number,
   *   iouThreshold?: number,
   *   scoreDecay?: number,
   *   maxAgeFrames?: number,
   * }} [opts]
   */
  constructor(opts = {}) {
    this.maxTracks = Math.min(SAM3_LIMITS.MAX_TRACKS, opts.maxTracks ?? 10);
    this.iouThreshold = opts.iouThreshold ?? 0.3;
    this.scoreDecay = opts.scoreDecay ?? 0.92;
    this.maxAgeFrames = opts.maxAgeFrames ?? 45;
    /** @type {Map<number, { track: Sam3Track, age: number, miss: number }>} */
    this._tracks = new Map();
    this._nextId = 1;
    this.orderGate = new FrameOrderGate();
    this._lastFrameIndex = -1;
  }

  reset() {
    this._tracks.clear();
    this._nextId = 1;
    this.orderGate.reset();
    this._lastFrameIndex = -1;
  }

  /**
   * Manually correct / override a track (UI hook).
   * @param {number} trackId
   * @param {Partial<Sam3Track>} patch
   */
  correctTrack(trackId, patch) {
    const row = this._tracks.get(trackId);
    if (!row) return { ok: false, reason: 'unknown-track' };
    if (patch.box && Array.isArray(patch.box) && patch.box.length === 4) {
      row.track.box = /** @type {[number,number,number,number]} */ ([...patch.box]);
    }
    if (typeof patch.label === 'string') row.track.label = patch.label.slice(0, 256);
    if (typeof patch.score === 'number' && Number.isFinite(patch.score)) {
      row.track.score = Math.min(1, Math.max(0, patch.score));
    }
    row.miss = 0;
    return { ok: true, track: { ...row.track } };
  }

  /**
   * Ingest a new frame result; returns ordered, associated results (0+).
   * @param {Sam3FrameResult} frameResult
   * @returns {{ results: Sam3FrameResult[], rejected: string|null }}
   */
  ingest(frameResult) {
    const ordered = this.orderGate.push(frameResult);
    if (ordered.rejected && !ordered.emit.length) {
      return { results: [], rejected: ordered.rejected };
    }
    const results = [];
    for (const fr of ordered.emit) {
      results.push(this._associate(fr));
    }
    return { results, rejected: ordered.rejected };
  }

  /**
   * @param {Sam3FrameResult} fr
   * @returns {Sam3FrameResult}
   */
  _associate(fr) {
    this._lastFrameIndex = fr.frameIndex;
    const detections = fr.tracks.slice(0, this.maxTracks);
    const usedDet = new Set();
    const usedTrack = new Set();

    // Greedy match by IoU × label similarity
    /** @type {Array<{ tid: number, di: number, iou: number }>} */
    const pairs = [];
    for (const [tid, row] of this._tracks) {
      for (let di = 0; di < detections.length; di++) {
        const det = detections[di];
        const iou = boxIoU(row.track.box, det.box);
        if (iou < this.iouThreshold) continue;
        const sameLabel = !row.track.label || !det.label
          || row.track.label.toLowerCase() === det.label.toLowerCase();
        if (!sameLabel && iou < this.iouThreshold + 0.15) continue;
        pairs.push({ tid, di, iou });
      }
    }
    pairs.sort((a, b) => b.iou - a.iou);

    for (const p of pairs) {
      if (usedTrack.has(p.tid) || usedDet.has(p.di)) continue;
      usedTrack.add(p.tid);
      usedDet.add(p.di);
      const row = this._tracks.get(p.tid);
      const det = detections[p.di];
      if (!row) continue;
      // EMA box smooth
      const a = 0.55;
      const nb = det.box.map((v, i) => a * v + (1 - a) * row.track.box[i]);
      row.track = {
        trackId: p.tid,
        label: det.label || row.track.label,
        score: Math.min(1, det.score * 0.7 + row.track.score * 0.3),
        box: /** @type {[number,number,number,number]} */ (nb),
        mask: det.mask || null,
      };
      row.age += 1;
      row.miss = 0;
    }

    // Unmatched detections → new tracks
    for (let di = 0; di < detections.length; di++) {
      if (usedDet.has(di)) continue;
      if (this._tracks.size >= this.maxTracks) break;
      const det = detections[di];
      const id = this._nextId++;
      this._tracks.set(id, {
        track: {
          trackId: id,
          label: det.label,
          score: det.score,
          box: [...det.box],
          mask: det.mask || null,
        },
        age: 1,
        miss: 0,
      });
    }

    // Age unmatched tracks
    for (const [tid, row] of this._tracks) {
      if (usedTrack.has(tid)) continue;
      row.miss += 1;
      row.track.score *= this.scoreDecay;
      if (row.miss > this.maxAgeFrames || row.track.score < 0.05) {
        this._tracks.delete(tid);
      }
    }

    // Enforce maxTracks by dropping lowest score
    while (this._tracks.size > this.maxTracks) {
      let worst = null;
      let worstScore = Infinity;
      for (const [tid, row] of this._tracks) {
        if (row.track.score < worstScore) {
          worstScore = row.track.score;
          worst = tid;
        }
      }
      if (worst != null) this._tracks.delete(worst);
      else break;
    }

    const tracks = [...this._tracks.values()].map((r) => ({
      trackId: r.track.trackId,
      label: r.track.label,
      score: r.track.score,
      box: /** @type {[number,number,number,number]} */ ([...r.track.box]),
      mask: r.track.mask || null,
    }));

    return {
      frameIndex: fr.frameIndex,
      timestampMs: fr.timestampMs,
      tracks,
    };
  }

  /** Snapshot of active tracks (for UI). */
  listTracks() {
    return [...this._tracks.values()].map((r) => ({ ...r.track, age: r.age, miss: r.miss }));
  }
}

export default VideoTracker;
