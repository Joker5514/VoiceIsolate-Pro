/**
 * VoiceIsolate Pro — Audio Encoder Worker (Layer 2: Workers)
 *
 * Web Worker that encodes audio data to WAV or MP3 format.
 * Runs encoding off the main thread to keep the UI responsive.
 *
 * Supported Formats:
 * - WAV: PCM 16-bit (standard uncompressed format)
 * - MP3: MPEG-1 Layer 3 using lamejs (pure JS encoder)
 *
 * Message Protocol:
 * - 'encode': { requestId, channels, sampleRate, format, bitrate }
 *   → 'result': { requestId, blob, format }
 *   → 'error': { requestId, error }
 *   → 'progress': { requestId, progress, stage }
 *
 * Architecture:
 * - Module worker (ES6 imports allowed)
 * - Stateless: each encode request is independent
 * - Transfers Float32Array buffers for zero-copy efficiency
 * - Returns Blob ready for download
 */
'use strict';

/**
 * Encode Float32 samples to WAV format (PCM 16-bit).
 * @param {Float32Array[]} channels - Audio channel data
 * @param {number} sampleRate - Sample rate in Hz
 * @returns {Blob}
 */
function encodeWAV(channels, sampleRate) {
  const numChannels = channels.length;
  const length = channels[0].length;
  const bytesPerSample = 2; // 16-bit PCM
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = length * blockAlign;
  const bufferSize = 44 + dataSize; // WAV header is 44 bytes

  const buffer = new ArrayBuffer(bufferSize);
  const view = new DataView(buffer);

  // WAV header (RIFF)
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true); // File size - 8
  writeString(view, 8, 'WAVE');

  // fmt chunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bits per sample

  // data chunk
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  // Interleave channels and convert Float32 → Int16
  let offset = 44;
  for (let i = 0; i < length; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = Math.max(-1, Math.min(1, channels[ch][i])); // Clamp
      const int16 = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
      view.setInt16(offset, int16, true);
      offset += 2;
    }
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

/**
 * Write ASCII string to DataView.
 * @param {DataView} view
 * @param {number} offset
 * @param {string} string
 */
function writeString(view, offset, string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

/**
 * Encode Float32 samples to MP3 format using lamejs.
 * @param {Float32Array[]} channels - Audio channel data
 * @param {number} sampleRate - Sample rate in Hz
 * @param {number} bitrate - Bitrate in kbps (128, 192, 256, 320)
 * @param {(progress: number) => void} onProgress - Progress callback
 * @returns {Promise<Blob>}
 */
async function encodeMP3(channels, sampleRate, bitrate, onProgress) {
  // Dynamically import lamejs (it's a UMD module, but we'll use it as ES6)
  // Note: lamejs must be installed via npm and bundled, or loaded from CDN
  // For now, we'll use a dynamic import that works with the installed package
  let lamejs;
  try {
    // Try to import from node_modules (works in bundled environments)
    lamejs = await import('lamejs');
  } catch (err) {
    // Fallback: try global (if loaded via script tag)
    if (typeof self.lamejs !== 'undefined') {
      lamejs = self.lamejs;
    } else {
      throw new Error('[VIP][AudioEncoderWorker] lamejs library not available. Install via: pnpm install lamejs');
    }
  }

  const numChannels = channels.length;
  const length = channels[0].length;
  
  // lamejs expects Int16 samples
  const int16Channels = channels.map(ch => floatTo16BitPCM(ch));

  // Create MP3 encoder
  const mp3encoder = new lamejs.Mp3Encoder(numChannels, sampleRate, bitrate);
  const mp3Data = [];

  // Encode in chunks (lamejs processes 1152 samples at a time for MPEG-1)
  const samplesPerFrame = 1152;
  const totalFrames = Math.ceil(length / samplesPerFrame);

  for (let i = 0; i < length; i += samplesPerFrame) {
    const frameNum = Math.floor(i / samplesPerFrame);
    const remaining = length - i;
    const frameSize = Math.min(samplesPerFrame, remaining);

    // Extract frame from each channel
    const leftFrame = int16Channels[0].subarray(i, i + frameSize);
    const rightFrame = numChannels > 1 ? int16Channels[1].subarray(i, i + frameSize) : leftFrame;

    // Encode frame
    const mp3buf = mp3encoder.encodeBuffer(leftFrame, rightFrame);
    if (mp3buf.length > 0) {
      mp3Data.push(mp3buf);
    }

    // Report progress every 10 frames
    if (frameNum % 10 === 0) {
      onProgress(frameNum / totalFrames);
    }
  }

  // Flush encoder
  const mp3buf = mp3encoder.flush();
  if (mp3buf.length > 0) {
    mp3Data.push(mp3buf);
  }

  onProgress(1);

  // Combine all MP3 chunks into a single Blob
  return new Blob(mp3Data, { type: 'audio/mpeg' });
}

/**
 * Convert Float32Array to Int16Array (PCM conversion).
 * @param {Float32Array} float32Array
 * @returns {Int16Array}
 */
function floatTo16BitPCM(float32Array) {
  const int16Array = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    const sample = Math.max(-1, Math.min(1, float32Array[i])); // Clamp
    int16Array[i] = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
  }
  return int16Array;
}

// ─────────────────────────────────────────────────────────────────────────────
// Worker Message Handler
// ─────────────────────────────────────────────────────────────────────────────

self.onmessage = async (e) => {
  const { type, requestId, channels, sampleRate, format, bitrate } = e.data;

  if (type === 'encode') {
    try {
      // Validate inputs
      if (!Array.isArray(channels) || channels.length === 0) {
        throw new TypeError('Invalid channels array.');
      }
      if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
        throw new TypeError('Invalid sample rate.');
      }
      if (!['wav', 'mp3'].includes(format)) {
        throw new TypeError('Invalid format. Use "wav" or "mp3".');
      }

      let blob;
      if (format === 'wav') {
        self.postMessage({ type: 'progress', requestId, progress: 0.5, stage: 'encoding-wav' });
        blob = encodeWAV(channels, sampleRate);
        self.postMessage({ type: 'progress', requestId, progress: 1, stage: 'complete' });
      } else if (format === 'mp3') {
        self.postMessage({ type: 'progress', requestId, progress: 0, stage: 'encoding-mp3' });
        blob = await encodeMP3(channels, sampleRate, bitrate || 192, (progress) => {
          self.postMessage({ type: 'progress', requestId, progress, stage: 'encoding-mp3' });
        });
      }

      // Send result back to main thread
      self.postMessage({
        type: 'result',
        requestId,
        blob,
        format,
      });
    } catch (error) {
      console.error('[VIP][AudioEncoderWorker] Encoding error:', error);
      self.postMessage({
        type: 'error',
        requestId,
        error: error.message || 'Encoding failed.',
      });
    }
  }
};

// Signal that worker is ready
self.postMessage({ type: 'ready' });

console.log('[VIP][AudioEncoderWorker] Worker initialized and ready.');

// Made with Bob
