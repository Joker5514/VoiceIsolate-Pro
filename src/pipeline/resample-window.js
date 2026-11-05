/** Map absolute canonical frames onto a source-rate slice that starts at srcStart. */
import { SAMPLE_RATE } from '../core/audio-config.js';

export function resampleWindow(channels, srcStart, fromRate, canonStart, outFrames) {
  const out = channels.map(() => new Float32Array(outFrames));
  const srcLen = channels[0]?.length || 0;
  if (!srcLen || outFrames < 1) return out;
  const scale = fromRate / SAMPLE_RATE;
  for (let i = 0; i < outFrames; i++) {
    const pos = (canonStart + i) * scale - srcStart;
    const i0 = Math.max(0, Math.min(srcLen - 1, Math.floor(pos)));
    const i1 = Math.min(srcLen - 1, i0 + 1);
    const t = Math.max(0, Math.min(1, pos - Math.floor(pos)));
    for (let c = 0; c < channels.length; c++) {
      out[c][i] = channels[c][i0] * (1 - t) + channels[c][i1] * t;
    }
  }
  return out;
}
