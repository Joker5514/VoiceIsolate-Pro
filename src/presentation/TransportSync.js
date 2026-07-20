/**
 * VoiceIsolate Pro — Transport Sync (Layer 4: Presentation)
 *
 * Keeps playhead UI, timeline, and audition/mixer clocks aligned.
 */
'use strict';

export class TransportSync {
  constructor() {
    /** @type {Set<Function>} */
    this._listeners = new Set();
    this._time = 0;
    this._duration = 0;
    this._playing = false;
    this._raf = 0;
    this._clock = null; // () => seconds
  }

  /**
   * @param {() => number} clockFn returns current media time in seconds
   */
  attachClock(clockFn) {
    this._clock = clockFn;
  }

  setDuration(d) {
    this._duration = Math.max(0, d || 0);
  }

  get time() {
    return this._time;
  }

  get duration() {
    return this._duration;
  }

  get playing() {
    return this._playing;
  }

  onUpdate(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _emit() {
    for (const fn of this._listeners) {
      try { fn(this._time, this._duration, this._playing); } catch { /* ignore */ }
    }
  }

  seek(t) {
    this._time = Math.max(0, Math.min(this._duration || t, t));
    this._emit();
  }

  start() {
    this._playing = true;
    this._loop();
  }

  stop(reset = false) {
    this._playing = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
    if (reset) {
      this._time = 0;
      this._emit();
    }
  }

  _loop() {
    if (!this._playing) return;
    if (this._clock) {
      try {
        this._time = this._clock();
      } catch { /* ignore */ }
    }
    this._emit();
    this._raf = requestAnimationFrame(() => this._loop());
  }

  dispose() {
    this.stop(true);
    this._listeners.clear();
    this._clock = null;
  }
}

export default TransportSync;
