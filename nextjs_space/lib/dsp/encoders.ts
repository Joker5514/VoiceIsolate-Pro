// Audio encoders: WAV (16-bit PCM and 24-bit PCM) and MP3 (via on-the-fly lamejs).
// We avoid shipping heavyweight libs by implementing WAV locally and MP3 via a small dedicated util.

export function audioBufferToWav(buffer: AudioBuffer, bitDepth: 16 | 24 = 16): Blob {
  const numCh = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const length = buffer.length;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numCh * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = length * blockAlign;
  const headerSize = 44;
  const arr = new ArrayBuffer(headerSize + dataSize);
  const view = new DataView(arr);

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  // RIFF header
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  // fmt chunk
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numCh, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  // data chunk
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  // interleave + write samples
  const channels: Float32Array[] = [];
  for (let c = 0; c < numCh; c++) channels.push(buffer.getChannelData(c));

  let offset = headerSize;
  for (let i = 0; i < length; i++) {
    for (let c = 0; c < numCh; c++) {
      let sample = Math.max(-1, Math.min(1, channels[c]?.[i] ?? 0));
      if (bitDepth === 16) {
        const s = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
        view.setInt16(offset, s, true);
        offset += 2;
      } else {
        // 24-bit
        const s = Math.round(sample * 0x7fffff);
        view.setUint8(offset, s & 0xff);
        view.setUint8(offset + 1, (s >> 8) & 0xff);
        view.setUint8(offset + 2, (s >> 16) & 0xff);
        offset += 3;
      }
    }
  }

  return new Blob([arr], { type: 'audio/wav' });
}

/** Trigger a file download in the browser */
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/**
 * MP3 encode via dynamically-loaded lamejs. Returns a Blob audio/mpeg.
 * lamejs accepts 16-bit Int16 samples. We down-mix stereo to L/R channels.
 */
export async function audioBufferToMp3(
  buffer: AudioBuffer,
  bitrateKbps: number = 192,
  onProgress?: (p: number) => void
): Promise<Blob> {
  // Dynamic import avoids SSR problems
  const lameMod: any = await import('lamejs');
  const lamejs: any = lameMod.default ?? lameMod;

  const channels = Math.min(buffer.numberOfChannels, 2);
  const sampleRate = buffer.sampleRate;
  const encoder = new lamejs.Mp3Encoder(channels, sampleRate, bitrateKbps);

  const samplesPerChunk = 1152;
  const left32 = buffer.getChannelData(0);
  const right32 = channels === 2 ? buffer.getChannelData(1) : left32;

  // Convert Float32 [-1,1] to Int16
  const toInt16 = (arr: Float32Array, start: number, len: number): Int16Array => {
    const out = new Int16Array(len);
    for (let i = 0; i < len; i++) {
      const v = Math.max(-1, Math.min(1, arr[start + i] ?? 0));
      out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
    return out;
  };

  const mp3Data: Uint8Array[] = [];
  const total = buffer.length;
  for (let i = 0; i < total; i += samplesPerChunk) {
    const chunkLen = Math.min(samplesPerChunk, total - i);
    const l = toInt16(left32, i, chunkLen);
    const r = toInt16(right32, i, chunkLen);
    const buf: Int8Array = channels === 2 ? encoder.encodeBuffer(l, r) : encoder.encodeBuffer(l);
    if (buf.length > 0) mp3Data.push(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
    if (onProgress && i % (samplesPerChunk * 50) === 0) {
      onProgress(i / total);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  const endBuf: Int8Array = encoder.flush();
  if (endBuf.length > 0) mp3Data.push(new Uint8Array(endBuf.buffer, endBuf.byteOffset, endBuf.byteLength));
  onProgress?.(1);

  return new Blob(mp3Data, { type: 'audio/mpeg' });
}
