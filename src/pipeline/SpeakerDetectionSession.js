/**
 * VoiceIsolate Pro — per-file speaker detection state (Layer 3: Pipeline).
 *
 * Runs speaker detection once per Process on the clean stem and holds the
 * labeled result. Each run() or reset() supersedes earlier runs, so a result
 * that resolves after the file changed is discarded instead of overwriting
 * the current file's state.
 */
'use strict';

const defaultDetect = async (clean, sampleRate) => {
  const { detectSpeakers } = await import('./SpeakerDetection.js');
  return detectSpeakers(clean, sampleRate);
};

export class SpeakerDetectionSession {
  /**
   * @param {{ detect?: Function, onChange?: (session: SpeakerDetectionSession) => void }} [opts]
   */
  constructor({ detect = defaultDetect, onChange = null } = {}) {
    this._detect = detect;
    this._onChange = onChange;
    this._seq = 0;
    this._clear(null);
  }

  _clear(state) {
    /** @type {null|'running'|'done'|'error'} */
    this.state = state;
    this.segments = [];
    this.speakers = [];
    this.method = null;
    this.error = null;
  }

  _emit() {
    try { this._onChange?.(this); } catch (err) {
      console.warn('[VIP][SpeakerDetectionSession] onChange failed:', err);
    }
  }

  /** Drop results and invalidate any in-flight run (file changed or cleared). */
  reset() {
    this._seq++;
    this._clear(null);
    this._emit();
  }

  /**
   * Detect and label speakers on a mono clean-stem channel.
   * @param {Float32Array} channel
   * @param {number} sampleRate
   * @returns {Promise<boolean>} true when this run's result was applied
   */
  async run(channel, sampleRate) {
    const seq = ++this._seq;
    this._clear('running');
    this._emit();
    try {
      if (!channel?.length) throw new Error('no clean stem');
      const { segments, speakers, method } = await this._detect([channel], sampleRate);
      if (seq !== this._seq) return false;
      this.segments = segments || [];
      this.speakers = speakers || [];
      this.method = method || null;
      this.state = 'done';
    } catch (err) {
      if (seq !== this._seq) return false;
      this.state = 'error';
      this.error = err;
      console.warn('[VIP][SpeakerDetectionSession] speaker detection failed:', err?.message || err);
    }
    this._emit();
    return this.state === 'done';
  }
}

export default SpeakerDetectionSession;
