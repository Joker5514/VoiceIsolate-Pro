/**
 * SAM 3 vision worker (module worker).
 * Off-main-thread segmentation + tracking. No audio, no cloud.
 *
 * Protocol:
 *   → { type: 'init', requestId?, options? }
 *   → { type: 'setPrompt', requestId?, command }
 *   → { type: 'clearPrompts', requestId? }
 *   → { type: 'segment', requestId, frame: { frameIndex, timestampMs, width, height } }
 *   → { type: 'correctTrack', requestId?, trackId, patch }
 *   → { type: 'capabilities', requestId? }
 *   ← { type: 'ready' | 'result' | 'error' | 'capabilities' | 'prompt-ok', ... }
 */
'use strict';

import { ImageSegmenter } from './image_segmenter.js';
import { VideoTracker } from './video_tracker.js';
import { validatePromptCommand } from './text_prompt_handler.js';
import { toWorkletMetadata, validateFrameResult } from './types.js';
import { probeSam3Runtime } from './runtime.js';
import { isSam3Enabled } from './featureFlag.js';

/** @type {ImageSegmenter|null} */
let segmenter = null;
/** @type {VideoTracker|null} */
let tracker = null;

function ensureEngines(options = {}) {
  if (!segmenter) {
    segmenter = new ImageSegmenter({
      maxTracks: options.maxTracks ?? 10,
      confidenceThreshold: options.confidenceThreshold ?? 0.35,
      modelPath: options.modelPath ?? null,
    });
  }
  if (!tracker) {
    tracker = new VideoTracker({
      maxTracks: options.maxTracks ?? 10,
      iouThreshold: options.iouThreshold ?? 0.3,
    });
  }
}

/**
 * @param {MessageEvent} event
 */
self.onmessage = async (event) => {
  const msg = event.data || {};
  const requestId = msg.requestId;
  try {
    switch (msg.type) {
      case 'init': {
        if (!isSam3Enabled(null, { queryParam: false }) && !msg.force) {
          // Allow init for probing, but flag disabled
        }
        ensureEngines(msg.options || {});
        if (msg.reset) {
          tracker?.reset();
          segmenter?.clearPrompts();
        }
        self.postMessage({
          type: 'ready',
          requestId,
          runtime: probeSam3Runtime(),
        });
        break;
      }
      case 'capabilities': {
        self.postMessage({
          type: 'capabilities',
          requestId,
          runtime: probeSam3Runtime(),
        });
        break;
      }
      case 'setPrompt': {
        ensureEngines();
        const v = validatePromptCommand(msg.command);
        if (!v.ok) {
          self.postMessage({ type: 'error', requestId, message: v.reason });
          break;
        }
        const r = segmenter.setPrompt(v.command);
        self.postMessage({ type: 'prompt-ok', requestId, ok: r.ok, reason: r.reason });
        break;
      }
      case 'clearPrompts': {
        ensureEngines();
        segmenter.clearPrompts();
        tracker.reset();
        self.postMessage({ type: 'prompt-ok', requestId, ok: true, cleared: true });
        break;
      }
      case 'correctTrack': {
        ensureEngines();
        const r = tracker.correctTrack(Number(msg.trackId), msg.patch || {});
        self.postMessage({ type: 'correct-ok', requestId, ...r });
        break;
      }
      case 'segment': {
        ensureEngines();
        const frame = msg.frame || {};
        const raw = await segmenter.segment(frame);
        const { results, rejected } = tracker.ingest(raw);
        // If order-gated, may emit 0..n; always include latest association when empty emit but raw ok
        const outList = results.length ? results : [];
        if (!outList.length && !rejected) {
          // Buffered for future drain
          self.postMessage({
            type: 'result',
            requestId,
            buffered: true,
            frameIndex: frame.frameIndex,
            results: [],
          });
          break;
        }
        if (rejected && !outList.length) {
          self.postMessage({
            type: 'error',
            requestId,
            message: rejected,
            code: 'frame-order',
          });
          break;
        }
        const payload = outList.map((fr) => {
          const v = validateFrameResult(fr);
          const worklet = v.ok && v.result ? toWorkletMetadata(v.result) : { ok: false };
          return {
            frame: v.result || fr,
            workletMeta: worklet.ok ? worklet.meta : null,
          };
        });
        self.postMessage({
          type: 'result',
          requestId,
          buffered: false,
          results: payload,
        });
        break;
      }
      default:
        self.postMessage({
          type: 'error',
          requestId,
          message: `Unknown message type '${msg.type}'`,
        });
    }
  } catch (err) {
    self.postMessage({
      type: 'error',
      requestId,
      message: err?.message || String(err),
    });
  }
};

// Announce load
self.postMessage({ type: 'boot', runtime: probeSam3Runtime() });
