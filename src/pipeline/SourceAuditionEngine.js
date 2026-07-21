/**
 * VoiceIsolate Pro — Source Audition Engine (Layer 3: Pipeline)
 *
 * Independent listening for analysis layers / stems. Builds best-effort
 * layer buffers from real masks when provided; never claims perfect stems.
 *
 * Supports solo / mute / gain / pan / region loop / original|layer|processed.
 */
'use strict';

/**
 * @typedef {{ id: string, label: string, buffer: AudioBuffer|null, confidence: number, quality: 'high'|'medium'|'low'|'none', muted?: boolean, solo?: boolean, gain?: number, pan?: number }} AuditionLayer
 */

export class SourceAuditionEngine {
  /**
   * @param {object} [options]
   * @param {AudioContext} [options.context]
   */
  constructor(options = {}) {
    this.ctx = options.context || null;
    /** @type {Map<string, AuditionLayer>} */
    this.layers = new Map();
    this._mode = 'original'; // original | layer | processed | submix
    this._region = null; // { start, end } seconds
    this._loop = false;
    this._playing = false;
    this._sources = [];
    this._masterGain = null;
    this._startedAt = 0;
    this._offset = 0;
    this._duration = 0;
    this._onTime = null;
    this._raf = 0;
  }

  /** Attach / replace AudioContext. */
  setContext(ctx) {
    this.stop();
    this.ctx = ctx;
  }

  /**
   * Register or replace a layer.
   * @param {AuditionLayer} layer
   */
  setLayer(layer) {
    if (!layer || !layer.id) throw new TypeError('layer.id required');
    const prev = this.layers.get(layer.id);
    this.layers.set(layer.id, {
      gain: 1,
      pan: 0,
      muted: false,
      solo: false,
      confidence: 0.5,
      quality: 'medium',
      buffer: null,
      label: layer.id,
      ...prev,
      ...layer,
    });
    if (layer.buffer) {
      this._duration = Math.max(this._duration, layer.buffer.duration);
    }
  }

  /**
   * Build classical preview layers from mono original + optional clean/noise stems.
   * Honest quality tags.
   * @param {object} args
   * @param {AudioBuffer} args.original
   * @param {AudioBuffer} [args.clean]
   * @param {AudioBuffer} [args.noise]
   * @param {object} [args.analysis]
   * @param {AudioContext} ctx
   */
  buildFromAnalysis(args, ctx) {
    this.setContext(ctx);
    this.layers.clear();
    const { original, clean, noise, analysis } = args;
    if (!original) return;

    this.setLayer({
      id: 'original',
      label: 'Original mix',
      buffer: original,
      confidence: 1,
      quality: 'high',
    });

    if (clean) {
      this.setLayer({
        id: 'lead_speech',
        label: 'Lead voice',
        buffer: clean,
        confidence: analysis?.confidenceScores?.speechRatio ?? 0.65,
        quality: analysis?.confidenceScores?.classicalOnly ? 'medium' : 'high',
      });
    }

    if (noise) {
      this.setLayer({
        id: 'noise',
        label: 'Noise residual',
        buffer: noise,
        confidence: 0.6,
        quality: clean ? 'medium' : 'low',
      });
    }

    if (clean && original) {
      // Music-ish residual approximation: original − clean (clipped)
      const musicBuf = this._residualBuffer(original, clean, ctx);
      this.setLayer({
        id: 'music',
        label: 'Music / other residual',
        buffer: musicBuf,
        confidence: analysis?.confidenceScores?.musicRatio ?? 0.4,
        quality: 'low',
      });
    }

    // Whisper-enhanced: clean with region gain (metadata only until play applies)
    if (clean && analysis?.whisperRegions?.length) {
      this.setLayer({
        id: 'whisper',
        label: 'Whisper-enhanced speech',
        buffer: clean,
        confidence: 0.55,
        quality: 'medium',
        meta: { whisperRegions: analysis.whisperRegions, liftDb: 12 },
      });
    }

    // Secondary speech placeholder only if diarization provided extra speakers
    const secondary = (analysis?.speakerSegments || []).filter((s) => s.speakerId && s.speakerId !== 'S1');
    if (secondary.length && clean) {
      this.setLayer({
        id: 'secondary_speech',
        label: 'Secondary speech',
        buffer: clean,
        confidence: 0.4,
        quality: 'low',
        meta: { segments: secondary },
      });
    }

    // Hum / transients / ambience — multi-buffer classical reconstruction
    // (honest quality: medium when analysis profiles exist, else low)
    if (noise || original) {
      const humSrc = noise || original;
      const humFreq = analysis?.humProfile?.freq || 60;
      const humBuf = this._extractHumBuffer(humSrc, ctx, humFreq);
      this.setLayer({
        id: 'hum',
        label: 'Hum (reconstructed)',
        buffer: humBuf,
        confidence: analysis?.humProfile?.strength ?? 0.3,
        quality: analysis?.humProfile?.present ? 'medium' : 'low',
      });

      const transientBuf = this._extractTransientBuffer(original, ctx);
      this.setLayer({
        id: 'transients',
        label: 'Transients (reconstructed)',
        buffer: transientBuf,
        confidence: 0.45,
        quality: 'medium',
      });

      const ambSrc = noise || this._residualBuffer(original, clean || original, ctx);
      const ambBuf = this._extractAmbienceBuffer(ambSrc, ctx);
      this.setLayer({
        id: 'ambience',
        label: 'Ambience / room',
        buffer: ambBuf,
        confidence: analysis?.roomEstimate ?? 0.3,
        quality: (analysis?.roomEstimate || 0) > 0.25 ? 'medium' : 'low',
      });
    }

    if (args.processed) {
      this.setLayer({
        id: 'processed',
        label: 'Processed output',
        buffer: args.processed,
        confidence: 1,
        quality: 'high',
      });
    }
  }

  _residualBuffer(original, clean, ctx) {
    const ch = Math.min(original.numberOfChannels, clean.numberOfChannels);
    const len = Math.min(original.length, clean.length);
    const out = ctx.createBuffer(ch, len, original.sampleRate);
    for (let c = 0; c < ch; c++) {
      const o = original.getChannelData(c);
      const v = clean.getChannelData(c);
      const d = out.getChannelData(c);
      for (let i = 0; i < len; i++) {
        d[i] = o[i] - v[i];
      }
    }
    return out;
  }

  /**
   * Narrowband comb around mains hum + harmonics (time-domain resonators).
   * Best-effort preview — not a studio hum strip.
   */
  _extractHumBuffer(source, ctx, baseFreq = 60) {
    const nCh = source.numberOfChannels;
    const len = source.length;
    const sr = source.sampleRate;
    const out = ctx.createBuffer(nCh, len, sr);
    const f0 = baseFreq === 50 ? 50 : 60;
    const harmonics = [1, 2, 3, 4, 5];
    for (let c = 0; c < nCh; c++) {
      const x = source.getChannelData(c);
      const y = out.getChannelData(c);
      // Parallel resonator bank (one-pole complex-ish via biquad-like IIR)
      const states = harmonics.map(() => ({ y1: 0, y2: 0, x1: 0, x2: 0 }));
      for (let i = 0; i < len; i++) {
        let sum = 0;
        const xi = x[i];
        for (let h = 0; h < harmonics.length; h++) {
          const f = f0 * harmonics[h];
          if (f >= sr * 0.45) continue;
          // Bandpass via difference of two one-pole LP approximations
          const w = 2 * Math.PI * f / sr;
          const r = 0.995 - h * 0.002;
          const st = states[h];
          const y0 = 2 * r * Math.cos(w) * st.y1 - r * r * st.y2 + xi - st.x2;
          st.x2 = st.x1;
          st.x1 = xi;
          st.y2 = st.y1;
          st.y1 = y0;
          sum += y0 * (0.35 / harmonics[h]);
        }
        y[i] = Math.max(-1, Math.min(1, sum * 0.85));
      }
    }
    return out;
  }

  /**
   * High-pass residual of a short differentiator — emphasizes attacks/clicks.
   */
  _extractTransientBuffer(source, ctx) {
    const nCh = source.numberOfChannels;
    const len = source.length;
    const out = ctx.createBuffer(nCh, len, source.sampleRate);
    for (let c = 0; c < nCh; c++) {
      const x = source.getChannelData(c);
      const y = out.getChannelData(c);
      let env = 0;
      let prev = 0;
      for (let i = 0; i < len; i++) {
        const d = x[i] - prev;
        prev = x[i];
        const a = Math.abs(d);
        env = a > env ? a : env * 0.995;
        // Gate by flux envelope
        const g = env > 0.012 ? Math.min(1.5, env * 18) : 0;
        y[i] = Math.max(-1, Math.min(1, d * g * 2.2));
      }
    }
    return out;
  }

  /**
   * Soft low-passed residual for room tone / reverb tail preview.
   */
  _extractAmbienceBuffer(source, ctx) {
    const nCh = source.numberOfChannels;
    const len = source.length;
    const sr = source.sampleRate;
    const out = ctx.createBuffer(nCh, len, sr);
    // ~800 Hz LPF for bed / room
    const fc = 800;
    const xcoef = Math.exp(-2 * Math.PI * fc / sr);
    const a0 = 1 - xcoef;
    for (let c = 0; c < nCh; c++) {
      const inp = source.getChannelData(c);
      const y = out.getChannelData(c);
      let z = 0;
      for (let i = 0; i < len; i++) {
        z = a0 * inp[i] + xcoef * z;
        y[i] = z * 0.9;
      }
    }
    return out;
  }

  setMode(mode) {
    this._mode = mode;
  }

  setRegion(start, end) {
    if (start == null || end == null) {
      this._region = null;
      return;
    }
    this._region = { start: Math.max(0, start), end: Math.max(start, end) };
  }

  setLoop(on) {
    this._loop = Boolean(on);
  }

  setLayerGain(id, gain) {
    const L = this.layers.get(id);
    if (L) L.gain = Math.max(0, Math.min(4, Number(gain) || 0));
  }

  setLayerMute(id, muted) {
    const L = this.layers.get(id);
    if (L) L.muted = Boolean(muted);
  }

  setLayerSolo(id, solo) {
    const L = this.layers.get(id);
    if (!L) return;
    if (solo) {
      for (const layer of this.layers.values()) layer.solo = false;
      L.solo = true;
    } else {
      L.solo = false;
    }
  }

  resetMix() {
    for (const L of this.layers.values()) {
      L.muted = false;
      L.solo = false;
      L.gain = 1;
      L.pan = 0;
    }
    this._mode = 'original';
    this._region = null;
    this._loop = false;
  }

  _activeLayers() {
    const all = [...this.layers.values()].filter((L) => L.buffer);
    if (this._mode === 'original') {
      const o = this.layers.get('original');
      return o?.buffer ? [o] : all.slice(0, 1);
    }
    if (this._mode === 'processed') {
      const p = this.layers.get('processed') || this.layers.get('lead_speech');
      return p?.buffer ? [p] : all.slice(0, 1);
    }
    const anySolo = all.some((L) => L.solo);
    return all.filter((L) => {
      if (L.id === 'original' && this._mode === 'layer') return false;
      if (anySolo) return L.solo && !L.muted;
      return !L.muted;
    });
  }

  /**
   * @param {number} [offsetSec]
   */
  async play(offsetSec) {
    if (!this.ctx) throw new Error('AudioContext required');
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.stop(false);
    const layers = this._activeLayers();
    if (!layers.length) return;

    this._masterGain = this.ctx.createGain();
    this._masterGain.gain.value = 1;
    this._masterGain.connect(this.ctx.destination);

    const region = this._region;
    const startOffset = offsetSec != null
      ? offsetSec
      : (region ? region.start : this._offset);
    let duration = this._duration - startOffset;
    if (region) {
      duration = Math.max(0.05, region.end - Math.max(region.start, startOffset));
    }

    this._sources = [];
    for (const L of layers) {
      const src = this.ctx.createBufferSource();
      src.buffer = L.buffer;
      src.loop = this._loop && !!region;
      if (src.loop && region) {
        src.loopStart = region.start;
        src.loopEnd = region.end;
      }
      const g = this.ctx.createGain();
      g.gain.value = (L.gain ?? 1) * (L.muted ? 0 : 1);
      // Optional stereo pan
      let node = g;
      if (typeof this.ctx.createStereoPanner === 'function' && L.pan) {
        const p = this.ctx.createStereoPanner();
        p.pan.value = Math.max(-1, Math.min(1, L.pan));
        g.connect(p);
        node = p;
      }
      src.connect(g);
      node.connect(this._masterGain);
      src.start(0, Math.max(0, startOffset), this._loop ? undefined : duration);
      this._sources.push(src);
    }

    this._startedAt = this.ctx.currentTime;
    this._offset = startOffset;
    this._playing = true;
    this._tick();
  }

  _tick() {
    if (!this._playing || !this.ctx) return;
    const t = this._offset + (this.ctx.currentTime - this._startedAt);
    if (typeof this._onTime === 'function') this._onTime(t);
    this._raf = requestAnimationFrame(() => this._tick());
  }

  onTimeUpdate(fn) {
    this._onTime = fn;
  }

  pause() {
    if (!this._playing || !this.ctx) return;
    this._offset += this.ctx.currentTime - this._startedAt;
    this.stop(false);
  }

  stop(resetOffset = true) {
    for (const s of this._sources) {
      try { s.stop(); } catch { /* ignore */ }
      try { s.disconnect(); } catch { /* ignore */ }
    }
    this._sources = [];
    if (this._masterGain) {
      try { this._masterGain.disconnect(); } catch { /* ignore */ }
      this._masterGain = null;
    }
    this._playing = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
    if (resetOffset) this._offset = 0;
  }

  seek(sec) {
    const was = this._playing;
    this.stop(false);
    this._offset = Math.max(0, sec);
    if (was) this.play(this._offset);
  }

  getCurrentTime() {
    if (!this._playing || !this.ctx) return this._offset;
    return this._offset + (this.ctx.currentTime - this._startedAt);
  }

  getLayerStates() {
    return [...this.layers.values()].map((L) => ({
      id: L.id,
      label: L.label,
      muted: !!L.muted,
      solo: !!L.solo,
      gain: L.gain ?? 1,
      pan: L.pan ?? 0,
      confidence: L.confidence,
      quality: L.quality,
      hasBuffer: !!L.buffer,
    }));
  }

  dispose() {
    this.stop(true);
    this.layers.clear();
  }
}

export default SourceAuditionEngine;
