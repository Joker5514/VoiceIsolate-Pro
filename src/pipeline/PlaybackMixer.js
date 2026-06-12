/**
 * VoiceIsolate Pro — Live-Mix Playback Engine (Layer 3: Pipeline)
 *
 * Routes the offline-processed stems through a real-time Web Audio graph:
 *
 *   Clean stem ─► Source ─► SpeakerGain ─► CleanGain ─► VoiceMute ─┐
 *                                                                  ├─► lowShelf ─► highShelf ─► Master ─► destination
 *   Noise stem ─► Source ───────────────► NoiseGain ─► NoiseMute ─┘
 *
 * SpeakerGain is a per-speaker automation lane: diarization segments
 * (src/core/diarization.js) schedule gain ramps so individual speakers can
 * be muted/soloed/attenuated during playback. VoiceMute/NoiseMute are
 * dedicated mute lanes so toggling mute never disturbs slider state.
 *
 * Every control method only touches AudioParams (setTargetAtTime for
 * click-free transitions). ML inference is NEVER triggered from here —
 * that is the core "Stem-Split & Live-Mix" contract (CLAUDE.md §1).
 *
 * AudioBufferSourceNodes are one-shot by spec, so play() builds fresh
 * sources each time; gain/EQ nodes persist so slider state survives
 * play/pause/seek cycles.
 */
'use strict';

import { SAMPLE_RATE, PARAM_SMOOTHING, verifyContextSampleRate } from '../core/audio-config.js';

export class PlaybackMixer {
  /**
   * @param {object} [options]
   * @param {AudioContext} [options.context]  injectable for tests
   */
  constructor(options = {}) {
    const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!options.context && !Ctx) {
      throw new Error('[VIP][PlaybackMixer] Web Audio API is not available.');
    }
    /** @type {AudioContext} */
    this.ctx = options.context || new Ctx({ sampleRate: SAMPLE_RATE });
    verifyContextSampleRate(this.ctx);

    // ── Persistent graph (built once) ────────────────────────────────────
    this.speakerGain = this.ctx.createGain();
    this.cleanGain = this.ctx.createGain();
    this.voiceMuteGain = this.ctx.createGain();
    this.noiseGain = this.ctx.createGain();
    this.noiseMuteGain = this.ctx.createGain();
    this.lowShelf = this.ctx.createBiquadFilter();
    this.highShelf = this.ctx.createBiquadFilter();
    this.masterGain = this.ctx.createGain();
    this.analyser = this.ctx.createAnalyser();

    this.lowShelf.type = 'lowshelf';
    this.lowShelf.frequency.value = 250;
    this.highShelf.type = 'highshelf';
    this.highShelf.frequency.value = 4000;
    this.analyser.fftSize = 2048;

    this.speakerGain.connect(this.cleanGain);
    this.cleanGain.connect(this.voiceMuteGain);
    this.voiceMuteGain.connect(this.lowShelf);
    this.noiseGain.connect(this.noiseMuteGain);
    this.noiseMuteGain.connect(this.lowShelf);
    this.lowShelf.connect(this.highShelf);
    this.highShelf.connect(this.masterGain);
    this.masterGain.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);

    // Default: 100% noise reduction off → both stems audible? No — default
    // to the product intent: full voice, noise fully suppressed.
    this.cleanGain.gain.value = 1;
    this.noiseGain.gain.value = 0;
    this.speakerGain.gain.value = 1;
    this.voiceMuteGain.gain.value = 1;
    this.noiseMuteGain.gain.value = 1;

    // ── Transport state ──────────────────────────────────────────────────
    /** @type {AudioBuffer|null} */ this.cleanBuffer = null;
    /** @type {AudioBuffer|null} */ this.noiseBuffer = null;
    /** @type {AudioBufferSourceNode|null} */ this._cleanSource = null;
    /** @type {AudioBufferSourceNode|null} */ this._noiseSource = null;
    this._isPlaying = false;
    this._startedAt = 0;    // ctx.currentTime when playback began
    this._offset = 0;       // seconds into the stems

    // ── Mute + per-speaker state ─────────────────────────────────────────
    this._voiceMuted = false;
    this._noiseMuted = false;
    /** @type {Array<{speakerId: string, start: number, end: number}>} */
    this._segments = [];
    /** @type {Map<string, {volume: number, muted: boolean}>} */
    this._speakers = new Map();
    /** @type {string|null} */
    this._soloId = null;
  }

  // ─── Stem loading ──────────────────────────────────────────────────────

  /**
   * Load stems produced by MLWorker.
   * @param {Float32Array[]} cleanChannels
   * @param {Float32Array[]} noiseChannels
   * @param {number} [sampleRate]
   */
  loadStems(cleanChannels, noiseChannels, sampleRate = SAMPLE_RATE) {
    if (!cleanChannels?.length || !noiseChannels?.length) {
      throw new TypeError('[VIP][PlaybackMixer] loadStems requires non-empty channel arrays.');
    }
    this.stop();
    this.cleanBuffer = this._toAudioBuffer(cleanChannels, sampleRate);
    this.noiseBuffer = this._toAudioBuffer(noiseChannels, sampleRate);
    this._offset = 0;
    // New stems invalidate any previous diarization.
    this.loadSpeakerSegments([]);
  }

  _toAudioBuffer(channels, sampleRate) {
    const buf = this.ctx.createBuffer(channels.length, channels[0].length, sampleRate);
    channels.forEach((data, ch) => buf.copyToChannel(data, ch));
    return buf;
  }

  // ─── Transport ─────────────────────────────────────────────────────────

  /** Begin (or resume) playback of both stems, sample-locked. */
  async play() {
    if (!this.cleanBuffer || !this.noiseBuffer) {
      throw new Error('[VIP][PlaybackMixer] No stems loaded.');
    }
    if (this._isPlaying) return;
    if (this.ctx.state === 'suspended') await this.ctx.resume();

    this._teardownSources();
    this._cleanSource = this.ctx.createBufferSource();
    this._cleanSource.buffer = this.cleanBuffer;
    this._cleanSource.connect(this.speakerGain);

    this._noiseSource = this.ctx.createBufferSource();
    this._noiseSource.buffer = this.noiseBuffer;
    this._noiseSource.connect(this.noiseGain);

    // Single shared start time keeps the stems phase-aligned.
    const when = this.ctx.currentTime + 0.01;
    this._cleanSource.start(when, this._offset);
    this._noiseSource.start(when, this._offset);
    this._startedAt = when - this._offset;
    this._isPlaying = true;
    this._scheduleSpeakerAutomation();

    this._cleanSource.onended = () => {
      if (this._isPlaying && this.currentTime() >= this.duration()) {
        this._isPlaying = false;
        this._offset = 0;
      }
    };
  }

  /** Pause, retaining position. */
  pause() {
    if (!this._isPlaying) return;
    this._offset = this.currentTime();
    this._teardownSources();
    this._isPlaying = false;
    this._scheduleSpeakerAutomation(); // clear stale ramps from the old timeline
  }

  /** Stop and rewind. */
  stop() {
    this._teardownSources();
    this._isPlaying = false;
    this._offset = 0;
    this._scheduleSpeakerAutomation();
  }

  /** Seek to an absolute position (seconds); keeps play state. */
  async seek(seconds) {
    const target = Math.max(0, Math.min(seconds, this.duration()));
    const wasPlaying = this._isPlaying;
    this._teardownSources();
    this._isPlaying = false;
    this._offset = target;
    if (wasPlaying) await this.play();
  }

  _teardownSources() {
    for (const src of [this._cleanSource, this._noiseSource]) {
      if (!src) continue;
      try { src.onended = null; src.stop(); } catch { /* not started */ }
      try { src.disconnect(); } catch { /* already disconnected */ }
    }
    this._cleanSource = null;
    this._noiseSource = null;
  }

  // ─── Real-time controls (AudioParam only — never ML) ──────────────────

  /**
   * While stems are audibly playing, approach the target with
   * setTargetAtTime so transitions are click-free. When idle (paused/
   * stopped/ended) nothing is rendering, so a click is impossible — snap
   * exactly to the target so the next play starts from the precise value.
   * (Smoothing-only also stalls on browsers that freeze the context clock
   * when the graph has no active sources.)
   * @param {AudioParam} param
   * @param {number} target
   */
  _applyParam(param, target) {
    const now = this.ctx.currentTime;
    if (this._isPlaying) {
      param.setTargetAtTime(target, now, PARAM_SMOOTHING);
    } else {
      param.cancelScheduledValues(now);
      param.value = target;
    }
  }

  /**
   * Noise reduction, 0–100. 100 = noise stem fully muted; 0 = original mix.
   * Inversely drives NoiseGain.
   * @param {number} percentage
   */
  setNoiseReduction(percentage) {
    const pct = clamp(percentage, 0, 100);
    this._applyParam(this.noiseGain.gain, 1 - pct / 100);
  }

  /**
   * Voice level, 0–100 (100 = unity, allows >100 for up to +6 dB boost).
   * @param {number} percentage
   */
  setVoiceLevel(percentage) {
    this._applyParam(this.cleanGain.gain, clamp(percentage, 0, 200) / 100);
  }

  /**
   * Master output volume, 0–100.
   * @param {number} percentage
   */
  setVolume(percentage) {
    this._applyParam(this.masterGain.gain, clamp(percentage, 0, 100) / 100);
  }

  /**
   * Low-shelf EQ gain in dB (−24 … +24) at 250 Hz.
   * @param {number} db
   */
  setLowShelf(db) {
    this._applyParam(this.lowShelf.gain, clamp(db, -24, 24));
  }

  /**
   * High-shelf EQ gain in dB (−24 … +24) at 4 kHz.
   * @param {number} db
   */
  setHighShelf(db) {
    this._applyParam(this.highShelf.gain, clamp(db, -24, 24));
  }

  /**
   * Hard-mute the voice stem without disturbing the Voice Level slider.
   * @param {boolean} muted
   */
  setVoiceMuted(muted) {
    this._voiceMuted = Boolean(muted);
    this._applyParam(this.voiceMuteGain.gain, this._voiceMuted ? 0 : 1);
  }

  /**
   * Hard-mute the background/noise stem without disturbing the
   * Noise Reduction slider.
   * @param {boolean} muted
   */
  setNoiseMuted(muted) {
    this._noiseMuted = Boolean(muted);
    this._applyParam(this.noiseMuteGain.gain, this._noiseMuted ? 0 : 1);
  }

  isVoiceMuted() { return this._voiceMuted; }

  isNoiseMuted() { return this._noiseMuted; }

  // ─── Per-speaker controls (diarization-driven gain automation) ─────────

  /**
   * Load diarization segments for the current stems. Segments must be
   * time-ordered and non-overlapping (the diarizeChannel contract).
   * Speaker state (volume/mute/solo) resets with each new segment set.
   * @param {Array<{speakerId: string, start: number, end: number}>} segments
   */
  loadSpeakerSegments(segments) {
    this._segments = (segments || [])
      .filter((s) => s && typeof s.speakerId === 'string' &&
        Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
      .slice()
      .sort((a, b) => a.start - b.start);
    this._speakers = new Map();
    for (const seg of this._segments) {
      if (!this._speakers.has(seg.speakerId)) {
        this._speakers.set(seg.speakerId, { volume: 1, muted: false });
      }
    }
    this._soloId = null;
    this._scheduleSpeakerAutomation();
  }

  /** Speaker ids present in the loaded segments, in first-appearance order. */
  speakerIds() { return [...this._speakers.keys()]; }

  /** @returns {{volume: number, muted: boolean, solo: boolean}|null} */
  getSpeakerState(speakerId) {
    const s = this._speakers.get(speakerId);
    return s ? { volume: s.volume, muted: s.muted, solo: this._soloId === speakerId } : null;
  }

  /** Segments currently driving the speaker lane (read-only copy). */
  getSpeakerSegments() { return this._segments.slice(); }

  /**
   * Per-speaker volume, 0–100.
   * @param {string} speakerId
   * @param {number} percentage
   */
  setSpeakerVolume(speakerId, percentage) {
    const s = this._speakers.get(speakerId);
    if (!s) return;
    s.volume = clamp(percentage, 0, 100) / 100;
    this._scheduleSpeakerAutomation();
  }

  /**
   * Mute/unmute one speaker. Volume is preserved across mute toggles.
   * @param {string} speakerId
   * @param {boolean} muted
   */
  setSpeakerMuted(speakerId, muted) {
    const s = this._speakers.get(speakerId);
    if (!s) return;
    s.muted = Boolean(muted);
    this._scheduleSpeakerAutomation();
  }

  /**
   * Solo one speaker (all others silenced), or pass null to clear solo.
   * @param {string|null} speakerId
   */
  setSpeakerSolo(speakerId) {
    this._soloId = speakerId !== null && this._speakers.has(speakerId) ? speakerId : null;
    this._scheduleSpeakerAutomation();
  }

  getSoloSpeaker() { return this._soloId; }

  _effectiveSpeakerVolume(speakerId) {
    const s = this._speakers.get(speakerId);
    if (!s) return 1;
    if (s.muted) return 0;
    if (this._soloId && this._soloId !== speakerId) return 0;
    return s.volume;
  }

  /**
   * (Re)schedule the speaker lane's gain automation from the current
   * playback position. Cheap enough to rebuild wholesale on every state
   * change — it is AudioParam events only, never ML (CLAUDE.md §1).
   */
  _scheduleSpeakerAutomation() {
    const g = this.speakerGain.gain;
    const now = this.ctx.currentTime;
    g.cancelScheduledValues(now);

    if (!this._isPlaying) {
      g.value = 1; // play() reschedules; idle lane stays transparent
      return;
    }
    if (this._segments.length === 0) {
      g.setTargetAtTime(1, now, PARAM_SMOOTHING);
      return;
    }

    const offset = this.currentTime();
    // ctx time at which stem position `pos` is audible (play() set _startedAt).
    const timeAt = (pos) => this._startedAt + pos;

    // Value at the current position, applied immediately…
    let current = 1;
    for (const seg of this._segments) {
      if (offset >= seg.start && offset < seg.end) {
        current = this._effectiveSpeakerVolume(seg.speakerId);
        break;
      }
    }
    g.setTargetAtTime(current, now, PARAM_SMOOTHING);

    // …then boundary ramps for everything still ahead. Gaps between
    // segments return to 1 (the clean stem is silent there anyway). When the
    // next segment starts exactly at this one's end (the common case — the
    // diarizer splits on frame boundaries), skip the restore ramp: two events
    // at the same instant would collide on the AudioParam, and the next
    // segment's own ramp governs the boundary.
    for (let i = 0; i < this._segments.length; i++) {
      const seg = this._segments[i];
      if (seg.end <= offset) continue;
      const vol = this._effectiveSpeakerVolume(seg.speakerId);
      if (seg.start > offset) {
        g.setTargetAtTime(vol, timeAt(seg.start), PARAM_SMOOTHING);
      }
      const next = this._segments[i + 1];
      if (!next || next.start > seg.end) {
        g.setTargetAtTime(1, timeAt(seg.end), PARAM_SMOOTHING);
      }
    }
  }

  // ─── Introspection ─────────────────────────────────────────────────────

  isPlaying() { return this._isPlaying; }

  duration() { return this.cleanBuffer ? this.cleanBuffer.duration : 0; }

  currentTime() {
    if (!this._isPlaying) return this._offset;
    const elapsed = this.ctx.currentTime - this._startedAt;
    return Math.max(this._offset, Math.min(elapsed, this.duration()));
  }

  /** AnalyserNode for visualizers (post-EQ, post-master). */
  getAnalyser() { return this.analyser; }

  /** Release all audio resources. The instance is unusable afterwards. */
  async dispose() {
    this.stop();
    for (const node of [this.speakerGain, this.cleanGain, this.voiceMuteGain,
      this.noiseGain, this.noiseMuteGain, this.lowShelf,
      this.highShelf, this.masterGain, this.analyser]) {
      try { node.disconnect(); } catch { /* already disconnected */ }
    }
    try { await this.ctx.close(); } catch { /* already closed */ }
  }
}

function clamp(v, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

export default PlaybackMixer;
