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

export function measureAudioBuffer(buffer, options) {
  return audioWorkerTask('/src/workers/AudioReviewWorker.js', { channels: copyChannels(buffer) }, options);
}

export function encodeReviewedWav(buffer, options) {
  return audioWorkerTask('/src/workers/AudioEncoderWorker.js', {
    type: 'encode', requestId: 1, format: 'wav', sampleRate: buffer.sampleRate, channels: copyChannels(buffer),
  }, { ...options, encoder: true });
}
