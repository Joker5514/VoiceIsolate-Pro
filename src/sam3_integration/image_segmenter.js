/**
 * Image-level promptable segmentation for the SAM 3 sidecar.
 *
 * Without a local browser-compatible SAM 3 checkpoint this uses a
 * **deterministic local heuristic** (explicit status: ready-heuristic).
 * It never fetches remote models. Real ORT/WebGPU inference plugs in via
 * setBackend() once a licensed local asset exists.
 */
'use strict';

import { validatePromptCommand } from './text_prompt_handler.js';
import { validateFrameResult, SAM3_LIMITS } from './types.js';
import { assertLocalModelAsset } from './policy.js';

/**
 * @typedef {import('./text_prompt_handler.js').Sam3PromptCommand} Sam3PromptCommand
 * @typedef {import('./types.js').Sam3FrameResult} Sam3FrameResult
 */

/**
 * Simple IoU for axis-aligned boxes [x,y,w,h].
 * @param {number[]} a
 * @param {number[]} b
 */
export function boxIoU(a, b) {
  const ax2 = a[0] + a[2];
  const ay2 = a[1] + a[3];
  const bx2 = b[0] + b[2];
  const by2 = b[1] + b[3];
  const ix1 = Math.max(a[0], b[0]);
  const iy1 = Math.max(a[1], b[1]);
  const ix2 = Math.min(ax2, bx2);
  const iy2 = Math.min(ay2, by2);
  const iw = Math.max(0, ix2 - ix1);
  const ih = Math.max(0, iy2 - iy1);
  const inter = iw * ih;
  const uni = a[2] * a[3] + b[2] * b[3] - inter;
  return uni > 0 ? inter / uni : 0;
}

/**
 * Hash string → [0,1) for stable mock placement.
 * @param {string} s
 */
function hash01(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

export class ImageSegmenter {
  /**
   * @param {{
   *   maxTracks?: number,
   *   confidenceThreshold?: number,
   *   modelPath?: string|null,
   * }} [opts]
   */
  constructor(opts = {}) {
    this.maxTracks = Math.min(
      SAM3_LIMITS.MAX_TRACKS,
      Math.max(1, opts.maxTracks ?? 10),
    );
    this.confidenceThreshold = opts.confidenceThreshold ?? 0.35;
    this.modelPath = opts.modelPath ?? null;
    this._backend = null; // optional real inference backend
    this._nextId = 1;
    this._activePrompts = [];
    if (this.modelPath) {
      const p = assertLocalModelAsset(this.modelPath);
      if (!p.ok) {
        throw new Error(`[SAM3][ImageSegmenter] model path rejected: ${p.reason}`);
      }
      this.modelPath = p.normalized;
    }
  }

  /**
   * Plug-in for future local ORT/WebGPU SAM 3 backend.
   * @param {{ segment: Function }|null} backend
   */
  setBackend(backend) {
    this._backend = backend;
  }

  /**
   * @param {Sam3PromptCommand|object} command
   */
  setPrompt(command) {
    const v = validatePromptCommand(command);
    if (!v.ok) return { ok: false, reason: v.reason };
    if (v.command.kind === 'clear') {
      this._activePrompts = [];
      return { ok: true, command: v.command };
    }
    this._activePrompts.push(v.command);
    // Cap stored prompts (must cover multi-instance / maxTracks tests)
    const maxPrompts = Math.max(8, this.maxTracks + 4);
    if (this._activePrompts.length > maxPrompts) {
      this._activePrompts = this._activePrompts.slice(-maxPrompts);
    }
    if (v.command.confidenceThreshold != null) {
      this.confidenceThreshold = v.command.confidenceThreshold;
    }
    return { ok: true, command: v.command };
  }

  clearPrompts() {
    this._activePrompts = [];
  }

  /**
   * Segment a single frame.
   * @param {{
   *   frameIndex: number,
   *   timestampMs: number,
   *   width: number,
   *   height: number,
   *   // Optional: ImageData / RGBA buffer — unused by heuristic
   *   rgba?: Uint8ClampedArray|Uint8Array|null,
   * }} frame
   * @returns {Promise<Sam3FrameResult>}
   */
  async segment(frame) {
    const frameIndex = Number(frame?.frameIndex);
    const timestampMs = Number(frame?.timestampMs);
    const width = Number(frame?.width) || 1;
    const height = Number(frame?.height) || 1;
    if (!Number.isInteger(frameIndex) || frameIndex < 0) {
      throw new Error('[SAM3][ImageSegmenter] invalid frameIndex');
    }
    if (!Number.isFinite(timestampMs) || timestampMs < 0) {
      throw new Error('[SAM3][ImageSegmenter] invalid timestampMs');
    }
    if (width > SAM3_LIMITS.MAX_FRAME_WIDTH || height > SAM3_LIMITS.MAX_FRAME_HEIGHT) {
      throw new Error('[SAM3][ImageSegmenter] frame dimensions exceed limits');
    }

    if (this._backend && typeof this._backend.segment === 'function') {
      const raw = await this._backend.segment({
        frame,
        prompts: this._activePrompts.slice(),
        confidenceThreshold: this.confidenceThreshold,
        maxTracks: this.maxTracks,
      });
      const v = validateFrameResult(raw, { maxTracks: this.maxTracks });
      if (!v.ok) throw new Error(`[SAM3][ImageSegmenter] backend invalid: ${v.reason}`);
      return /** @type {import('./types.js').Sam3FrameResult} */ (v.result);
    }

    // Local heuristic (no network, no heavy model)
    const tracks = this._heuristicTracks(width, height);
    const result = {
      frameIndex,
      timestampMs,
      tracks,
    };
    const v = validateFrameResult(result, { maxTracks: this.maxTracks });
    if (!v.ok) throw new Error(`[SAM3][ImageSegmenter] heuristic invalid: ${v.reason}`);
    return /** @type {import('./types.js').Sam3FrameResult} */ (v.result);
  }

  /**
   * @param {number} width
   * @param {number} height
   */
  _heuristicTracks(width, height) {
    const prompts = this._activePrompts;
    if (!prompts.length) return [];

    /** @type {import('./types.js').Sam3Track[]} */
    const tracks = [];
    for (const p of prompts) {
      if (tracks.length >= this.maxTracks) break;
      if (p.kind === 'box' && p.box) {
        const score = Math.max(this.confidenceThreshold, 0.72);
        if (score < this.confidenceThreshold) continue;
        tracks.push({
          trackId: this._nextId++,
          label: p.text || 'box',
          score,
          box: [...p.box],
          mask: null,
        });
        continue;
      }
      if (p.kind === 'click' && p.point) {
        const size = Math.min(width, height) * 0.12;
        const x = Math.max(0, p.point[0] - size / 2);
        const y = Math.max(0, p.point[1] - size / 2);
        tracks.push({
          trackId: this._nextId++,
          label: p.label === 0 ? 'negative' : 'click',
          score: p.label === 0 ? 0.2 : 0.8,
          box: [x, y, size, size],
          mask: null,
        });
        continue;
      }
      if (p.kind === 'text' && p.text) {
        // Stable pseudo-box from text hash — deterministic for tests / UI scaffolding
        const hx = hash01(p.text);
        const hy = hash01(`${p.text}:y`);
        const bw = width * (0.18 + 0.12 * hash01(`${p.text}:w`));
        const bh = height * (0.22 + 0.1 * hash01(`${p.text}:h`));
        const x = hx * Math.max(1, width - bw);
        const y = hy * Math.max(1, height - bh);
        // Multi-instance: up to 3 related boxes for exhaustive-ish mock
        const count = 1 + Math.floor(hash01(`${p.text}:n`) * 2);
        for (let i = 0; i < count && tracks.length < this.maxTracks; i++) {
          const ox = (i * bw * 0.35) % Math.max(1, width - bw);
          tracks.push({
            trackId: this._nextId++,
            label: p.text,
            score: Math.min(0.95, 0.55 + 0.15 * (count - i)),
            box: [x + ox * 0.1, y, bw, bh],
            mask: null,
          });
        }
      }
    }
    return tracks
      .filter((t) => t.score >= this.confidenceThreshold)
      .slice(0, this.maxTracks);
  }
}

export default ImageSegmenter;
