/** Pure click-safe speaker automation shared by preview and export. */
'use strict';

export const SPEAKER_GAIN_RAMP_SEC = 0.012;

export function effectiveSpeakerGain(state, speakerId, soloId = null) {
  if (!state) return 1;
  if (state.muted || (soloId && soloId !== speakerId)) return 0;
  const volume = Number(state.volume);
  return Number.isFinite(volume) ? Math.max(0, Math.min(2, volume)) : 1;
}

/**
 * Build a linear, 12 ms look-behind envelope matching Web Audio automation.
 * Segments are clipped; malformed/empty segments are ignored. For overlaps,
 * the later segment in chronological/input order wins deterministically.
 */
export function buildSpeakerGainEnvelope({
  length,
  sampleRate,
  segments = [],
  getState,
  soloId = null,
  rampSeconds = SPEAKER_GAIN_RAMP_SEC,
}) {
  const size = Math.max(0, Math.floor(Number(length) || 0));
  const rate = Math.max(1, Number(sampleRate) || 48000);
  const envelope = new Float32Array(size);
  envelope.fill(1);
  const ordered = segments
    .map((segment, index) => ({ segment, index }))
    .filter(({ segment }) => Number.isFinite(Number(segment?.start))
      && Number.isFinite(Number(segment?.end)) && Number(segment.end) > Number(segment.start))
    .sort((a, b) => Number(a.segment.start) - Number(b.segment.start) || a.index - b.index);
  for (const { segment } of ordered) {
    const start = Math.max(0, Math.min(size, Math.floor(Number(segment.start) * rate)));
    const end = Math.max(start, Math.min(size, Math.floor(Number(segment.end) * rate)));
    const gain = effectiveSpeakerGain(getState?.(segment.speakerId), segment.speakerId, soloId);
    envelope.fill(gain, start, end);
  }
  const target = new Float32Array(envelope);
  const rampSamples = Math.max(1, Math.round(Math.max(0, rampSeconds) * rate));
  for (let boundary = 1; boundary < size; boundary++) {
    if (target[boundary] === target[boundary - 1]) continue;
    const from = target[boundary - 1];
    const to = target[boundary];
    const begin = Math.max(0, boundary - rampSamples);
    const span = Math.max(1, boundary - begin);
    for (let i = begin; i <= boundary; i++) {
      envelope[i] = from + (to - from) * ((i - begin) / span);
    }
  }
  return envelope;
}

export default buildSpeakerGainEnvelope;
