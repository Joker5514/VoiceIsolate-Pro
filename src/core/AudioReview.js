/** Pure validation and RMS statistics; called in AudioReviewWorker. */
export function measureChannels(channels) {
  const length = channels?.[0]?.length;
  if (!length || !channels.every((channel) => channel instanceof Float32Array && channel.length === length)) {
    throw new Error('Audio has missing or mismatched channels. Process the file again.');
  }
  let sum = 0;
  let peak = 0;
  let clipped = 0;
  for (const channel of channels) {
    for (let i = 0; i < length; i++) {
      const sample = channel[i];
      if (!Number.isFinite(sample)) throw new Error('Audio contains non-finite samples. Lower the mix levels and retry.');
      sum += sample * sample;
      peak = Math.max(peak, Math.abs(sample));
      if (Math.abs(sample) > 1) clipped++;
    }
  }
  return { rms: Math.sqrt(sum / (length * channels.length)), peak, clipped, length, channels: channels.length };
}

/** Match average level by attenuation only, with a common peak ceiling. Not LUFS. */
export function reviewGains(original, cleaned) {
  if (original.rms < 1e-7 || cleaned.rms < 1e-7) return { original: 1, cleaned: 1, matched: false };
  const target = Math.min(original.rms, cleaned.rms);
  const a = target / original.rms;
  const b = target / cleaned.rms;
  const headroom = Math.min(1, 0.98 / Math.max(original.peak * a, cleaned.peak * b));
  return { original: a * headroom, cleaned: b * headroom, matched: true };
}
