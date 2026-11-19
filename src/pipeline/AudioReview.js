import { CancellationError } from './JobController.js';
export { reviewGains } from '../core/AudioReview.js';

/** One-shot worker with bounded lifetime; termination cancels CPU-bound encoding too. */
function audioWorkerTask(url, message, { signal, encoder = false } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new CancellationError()); return; }
    const worker = new Worker(url, { type: 'module' });
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      worker.terminate();
      if (error) reject(error); else resolve(result);
    };
    const abort = () => finish(new CancellationError());
    const timer = setTimeout(() => finish(new Error('Audio preparation timed out. Retry with a shorter file.')), 120000);
    signal?.addEventListener('abort', abort, { once: true });
    const send = () => {
      try { worker.postMessage(message, message.channels.map((channel) => channel.buffer)); }
      catch (err) { finish(err); }
    };
    worker.onerror = (event) => finish(new Error(event.message || 'Audio worker failed. Retry the export.'));
    worker.onmessage = ({ data }) => {
      if (encoder && data.type === 'ready') { send(); return; }
      if (data.error) finish(new Error(data.error));
      else if (encoder ? data.type === 'result' : data.result) finish(null, encoder ? data.blob : data.result);
    };
    if (!encoder) send();
  });
}

function copyChannels(buffer) {
  return Array.from({ length: buffer.numberOfChannels }, (_, ch) => buffer.getChannelData(ch).slice());
}

/**
 * Copy only the requested [startSec, endSec) window of an AudioBuffer's
 * channels (pure helper, no worker). Without a window the whole buffer is
 * copied, as before. Callers that run per slider move MUST pass a bounded
 * window: copying a long file's channels on the main thread is a freeze
 * (a 522 s mono file is ~100 MB per channel).
 * @param {AudioBuffer} buffer
 * @param {{ startSec?: number, endSec?: number }} [window]
 * @returns {Float32Array[]}
 */
export function sliceBufferChannels(buffer, { startSec, endSec } = {}) {
  const sr = Number.isFinite(buffer.sampleRate) && buffer.sampleRate > 0 ? buffer.sampleRate : 48000;
  const length = buffer.length ?? buffer.getChannelData(0)?.length ?? 0;
  const start = startSec != null
    ? Math.max(0, Math.min(length, Math.floor(startSec * sr)))
    : 0;
  const end = endSec != null
    ? Math.max(start, Math.min(length, Math.ceil(endSec * sr)))
    : length;
  return Array.from(
    { length: buffer.numberOfChannels },
    (_, ch) => buffer.getChannelData(ch).subarray(start, end).slice(),
  );
}

export function measureAudioBuffer(buffer, options) {
  const { signal, startSec, endSec } = options || {};
  return audioWorkerTask(
    '/src/workers/AudioReviewWorker.js',
    { channels: sliceBufferChannels(buffer, { startSec, endSec }) },
    { signal },
  );
}

export function encodeReviewedWav(buffer, options) {
  return audioWorkerTask('/src/workers/AudioEncoderWorker.js', {
    type: 'encode', requestId: 1, format: 'wav', sampleRate: buffer.sampleRate, channels: copyChannels(buffer),
  }, { ...options, encoder: true });
}
