/**
 * Map absolute canonical frames onto a source-rate slice that starts at srcStart.
 *
 * Bandlimited Kaiser windowed-sinc (src/core/BandlimitedResampler.js). The
 * kernel is centered on each output time, so a window matches a one-shot
 * resample when the slice covers `sourceSpan` — that is the context
 * ChunkedExtraction and CompressedAudioReader read around every chunk.
 */
import { SAMPLE_RATE } from '../core/audio-config.js';
import {
  kernelRadius,
  resampleWindow as resampleBandlimited,
  sourceSpan as spanAt,
} from '../core/BandlimitedResampler.js';

/** Kernel half-width in source samples. Zero when `fromRate` is already canonical. */
export function sourceMargin(fromRate, toRate = SAMPLE_RATE) {
  return kernelRadius(fromRate, toRate);
}

/**
 * Source frames [srcStart, srcEnd) that the kernel reads for canonical frames
 * [canonStart, canonStart + outFrames). srcStart may be negative at file start.
 */
export function sourceSpan(fromRate, canonStart, outFrames, toRate = SAMPLE_RATE) {
  return spanAt(canonStart, outFrames, fromRate, toRate);
}

export function resampleWindow(channels, srcStart, fromRate, canonStart, outFrames) {
  return resampleBandlimited(channels, srcStart, fromRate, canonStart, outFrames, SAMPLE_RATE);
}
