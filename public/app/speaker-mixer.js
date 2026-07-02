/**
 * speaker-mixer.js — Per-speaker Web Audio gain graph for VoiceIsolate Pro
 *
 * Each detected speaker gets an independent GainNode driven by a precomputed
 * activity mask (setValueCurveAtTime). Muting uses linearRampToValueAtTime —
 * never zeroes PCM buffers directly.
 */
'use strict';

export class SpeakerMixer {
  /**
   * @param {AudioContext|OfflineAudioContext} audioContext
   * @param {AudioNode} destination  post-iSTFT bus (not context.destination)
   */
  constructor(audioContext, destination) {
    if (!audioContext || !destination) {
      throw new TypeError('[SpeakerMixer] audioContext and destination are required.');
    }
    this.ctx = audioContext;
    this.destination = destination;
    /** @type {Map<string, GainNode>} */
    this.speakerGains = new Map();
    /** @type {Map<string, boolean>} */
    this.muteStates = new Map();
    /** @type {Map<string, number>} */
    this.baseGains = new Map();
    /** @type {Map<string, Float32Array>} */
    this.maskBuffers = new Map();
    /** @type {AudioNode|null} */
    this._sourceNode = null;
    this._duration = 0;
  }

  /**
   * Build parallel speaker branches: source → per-speaker GainNode → destination.
   * Each gain node follows its timeline mask via setValueCurveAtTime.
   *
   * @param {import('./speaker-diarizer.js').SpeakerTimeline} timeline
   * @param {AudioNode} sourceNode  iSTFT / processed output node
   * @param {import('./speaker-diarizer.js').SpeakerDiarizer} [diarizer]  mask builder
   */
  buildGraph(timeline, sourceNode, diarizer = null) {
    this.destroy();
    if (!timeline?.speakers?.size || !sourceNode) return;

    this._sourceNode = sourceNode;
    this._duration = timeline.durationSec
      || (timeline.totalSamples / (timeline.analysisSampleRate || 16000));

    const sr = this.ctx.sampleRate;
    const totalSamples = Math.max(1, Math.ceil(this._duration * sr));
    const curveDuration = this._duration;
    const now = this.ctx.currentTime;

    for (const [speakerId] of timeline.speakers) {
      const gainNode = this.ctx.createGain();
      gainNode.gain.value = 1;

      let mask;
      if (diarizer && typeof diarizer.buildMaskBuffer === 'function') {
        mask = diarizer.buildMaskBuffer(timeline, speakerId, totalSamples);
      } else {
        mask = this._buildMaskFallback(timeline, speakerId, totalSamples);
      }
      this.maskBuffers.set(speakerId, mask);

      // Web Audio requires ≥ 2 points for setValueCurveAtTime.
      const curve = mask.length >= 2 ? mask : new Float32Array([mask[0] || 0, mask[0] || 0]);
      try {
        gainNode.gain.cancelScheduledValues(now);
        gainNode.gain.setValueCurveAtTime(curve, now, curveDuration);
      } catch (err) {
        console.warn(`[SpeakerMixer] setValueCurveAtTime failed for ${speakerId}:`, err);
        gainNode.gain.value = 1;
      }

      sourceNode.connect(gainNode);
      gainNode.connect(this.destination);

      this.speakerGains.set(speakerId, gainNode);
      this.muteStates.set(speakerId, false);
      this.baseGains.set(speakerId, 1);
    }
  }

  /** Fallback mask when diarizer instance is not passed. */
  _buildMaskFallback(timeline, targetSpeakerId, totalSamples) {
    const mask = new Float32Array(totalSamples);
    const analysisTotal = timeline.totalSamples || totalSamples;
    const scale = totalSamples / Math.max(1, analysisTotal);
    const ramp = Math.max(1, Math.floor(0.005 * (timeline.analysisSampleRate || 16000) * scale));
    for (const seg of timeline.segments || []) {
      if (seg.speakerId !== targetSpeakerId) continue;
      const s0 = Math.floor(seg.startSample * scale);
      const s1 = Math.min(totalSamples, Math.ceil(seg.endSample * scale));
      for (let i = s0; i < s1; i++) mask[i] = 1;
      for (let r = 0; r < ramp && s0 + r < totalSamples; r++) mask[s0 + r] = r / ramp;
      for (let r = 0; r < ramp && s1 - 1 - r >= 0; r++) mask[s1 - 1 - r] = r / ramp;
    }
    return mask;
  }

  /**
   * Read current mask-scaled gain at playback time.
   * @param {string} speakerId
   * @returns {number}
   */
  _maskValueAt(speakerId, timeSec) {
    const mask = this.maskBuffers.get(speakerId);
    if (!mask?.length || this._duration <= 0) return 1;
    const idx = Math.min(mask.length - 1, Math.max(0, Math.floor((timeSec / this._duration) * mask.length)));
    return mask[idx];
  }

  /**
   * Toggle mute for one speaker. Returns new mute state (true = muted).
   * @param {string} speakerId
   * @returns {boolean}
   */
  toggleMute(speakerId) {
    const gainNode = this.speakerGains.get(speakerId);
    if (!gainNode) return false;

    const wasMuted = this.muteStates.get(speakerId) || false;
    const nowMuted = !wasMuted;
    this.muteStates.set(speakerId, nowMuted);

    const now = this.ctx.currentTime;
    const base = this.baseGains.get(speakerId) ?? 1;
    const maskNow = this._maskValueAt(speakerId, Math.max(0, now - (this.ctx.currentTime || 0)));
    const target = nowMuted ? 0 : base * maskNow;

    gainNode.gain.cancelScheduledValues(now);
    gainNode.gain.setValueAtTime(gainNode.gain.value, now);
    gainNode.gain.linearRampToValueAtTime(target, now + 0.02);

    return nowMuted;
  }

  /**
   * Set per-speaker base gain (0..2). Applied over 10 ms ramp.
   * @param {string} speakerId
   * @param {number} gainValue
   */
  setSpeakerGain(speakerId, gainValue) {
    const gainNode = this.speakerGains.get(speakerId);
    if (!gainNode) return;

    const g = Math.max(0, Math.min(2, Number(gainValue) || 0));
    this.baseGains.set(speakerId, g);

    if (this.muteStates.get(speakerId)) return;

    const now = this.ctx.currentTime;
    const maskNow = this._maskValueAt(speakerId, 0);
    gainNode.gain.cancelScheduledValues(now);
    gainNode.gain.setValueAtTime(gainNode.gain.value, now);
    gainNode.gain.linearRampToValueAtTime(g * maskNow, now + 0.01);
  }

  /** @returns {boolean} */
  isMuted(speakerId) {
    return Boolean(this.muteStates.get(speakerId));
  }

  /** Disconnect all nodes and clear state. Call before rebuilding the graph. */
  destroy() {
    for (const [, node] of this.speakerGains) {
      try { node.disconnect(); } catch { /* already disconnected */ }
    }
    // Do not disconnect _sourceNode — owned by the host pipeline graph.
    this.speakerGains.clear();
    this.muteStates.clear();
    this.baseGains.clear();
    this.maskBuffers.clear();
    this._sourceNode = null;
    this._duration = 0;
  }
}

export default SpeakerMixer;