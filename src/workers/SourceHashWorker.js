/**
 * VoiceIsolate Pro — source hash worker (Layer 2: Workers)
 *
 * VIP-011: streams a source Blob through SHA-256 off the main thread so large
 * files hash without janking the UI. Messages:
 *   → { type: 'hash', requestId, blob }
 *   ← { type: 'progress', requestId, done, total }
 *   ← { type: 'done', requestId, hex, bytes }
 *   ← { type: 'error', requestId, name, message }
 *
 * Cancellation = host terminates this worker (bounded lifetime pattern, see
 * src/pipeline/AudioReview.js); the in-flight hash dies with it and the host
 * reports an AbortError.
 */
'use strict';

import { hashBlobSha256 } from '../core/sha256.js';

self.onmessage = async (ev) => {
  const msg = ev.data || {};
  if (msg.type !== 'hash' || !msg.blob) return;
  const requestId = msg.requestId;
  try {
    const { hex, bytes } = await hashBlobSha256(msg.blob, {
      chunkBytes: 4 * 1024 * 1024,
      onProgress: (done, total) => {
        self.postMessage({ type: 'progress', requestId, done, total });
      },
    });
    self.postMessage({ type: 'done', requestId, hex, bytes });
  } catch (err) {
    self.postMessage({
      type: 'error',
      requestId,
      name: err?.name || 'Error',
      message: err?.message || String(err),
    });
  }
};
