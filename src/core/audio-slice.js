'use strict';

/** Copy a time slice from an AudioBuffer into a new buffer. */
export function sliceAudioBuffer(ctx, buf, startSec, endSec) {
  if (!buf || !ctx) return buf;
  const sr = buf.sampleRate;
  const start = Math.max(0, Math.floor(startSec * sr));
  const end = Math.min(buf.length, Math.floor(endSec * sr));
  const len = Math.max(1, end - start);
  const out = ctx.createBuffer(buf.numberOfChannels, len, sr);
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const slice = buf.getChannelData(ch).subarray(start, end);
    const dest = new Float32Array(len);
    dest.set(slice);
    out.copyToChannel(dest, ch);
  }
  return out;
}