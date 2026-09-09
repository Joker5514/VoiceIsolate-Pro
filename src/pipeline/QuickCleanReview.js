import { measureAudioBuffer, reviewGains } from './AudioReview.js';
import { PARAM_SMOOTHING } from '../core/audio-config.js';

/** Matched reference playback over a rendered snapshot of the shared mixer. */
export class QuickCleanReview {
  constructor(mixer) { this.mixer = mixer; this.sources = []; this.ready = false; }

  async prepare(originalChannels, { signal } = {}) {
    this.clear();
    const cleaned = await this.mixer.renderMix({ signal });
    const original = this.mixer.ctx.createBuffer(originalChannels.length, originalChannels[0].length, cleaned.sampleRate);
    originalChannels.forEach((channel, index) => original.copyToChannel(channel, index));
    const a = await measureAudioBuffer(original, { signal });
    const b = await measureAudioBuffer(cleaned, { signal });
    if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
    this.gains = reviewGains(a, b);
    this.buffers = { original, cleaned };
    this.ready = true;
    return this.gains;
  }

  async listen(which) {
    if (!this.ready || !['original', 'cleaned'].includes(which)) return;
    const ctx = this.mixer.ctx;
    if (ctx.state === 'suspended') await ctx.resume();
    if (!this.ready) return;
    if (!this.sources.length) {
      const offset = this.mixer.currentTime() >= this.mixer.duration() ? 0 : this.mixer.currentTime();
      this.mixer.pause();
      const when = ctx.currentTime + 0.01;
      for (const key of ['original', 'cleaned']) {
        const source = ctx.createBufferSource();
        const gain = ctx.createGain();
        source.buffer = this.buffers[key];
        gain.gain.value = key === which ? this.gains[key] : 0;
        source.connect(gain);
        gain.connect(ctx.destination);
        source.start(when, offset);
        this.sources.push({ source, gain, key });
        source.onended = () => { if (this.sources.some((entry) => entry.source === source)) this.stop(); };
      }
    }
    for (const { gain, key } of this.sources) gain.gain.setTargetAtTime(key === which ? this.gains[key] : 0, ctx.currentTime, PARAM_SMOOTHING);
  }

  stop() {
    const sources = this.sources.splice(0);
    for (const { source, gain } of sources) {
      source.onended = null;
      try { source.stop(); source.disconnect(); gain.disconnect(); } catch { /* already stopped */ }
    }
  }

  clear() { this.stop(); this.ready = false; this.buffers = null; }
}
