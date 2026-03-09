/* ============================================
   VoiceIsolate Pro — AudioWorklet Processor
   Phase 3: Low-latency live-mode DSP (<10ms)
   Threads from Space v8 · dsp-worker.js
   ============================================ */

class VoiceIsolateProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super(options);
    // Current DSP parameter values — updated via port messages from main thread
    this.params = {
      hpFreq: 80, hpQ: 0.71,
      lpFreq: 14000, lpQ: 0.71,
      gateThresh: -42, gateRelease: 80,
      compThresh: -24, compRatio: 4, compAttack: 8, compRelease: 200, compKnee: 6,
      compMakeup: 6, limThresh: -1, outGain: 0
    };
    // Biquad filter state (2 channels × HP + LP)
    this._hpState = [[0,0,0,0],[0,0,0,0]]; // [ch][x1,x2,y1,y2]
    this._lpState = [[0,0,0,0],[0,0,0,0]];
    // Gate state
    this._gateGain = [1, 1];
    // Compressor envelope follower
    this._compEnv = [0, 0];
    // Biquad coefficients (pre-computed at sampleRate)
    this._hp = null; this._lp = null;
    this._sr = sampleRate; // AudioWorklet global sampleRate
    this._computeCoeffs();

    // Accept parameter updates from main thread
    this.port.onmessage = (e) => {
      if (e.data && e.data.sliders) {
        Object.assign(this.params, e.data.sliders);
        this._computeCoeffs();
      }
    };
  }

  // Pre-compute biquad coefficients and linear gains from current params
  _computeCoeffs() {
    const sr = this._sr;
    // High-pass Butterworth
    this._hp = this._biquadHP(this.params.hpFreq, this.params.hpQ, sr);
    // Low-pass Butterworth
    this._lp = this._biquadLP(this.params.lpFreq, this.params.lpQ, sr);

    // Gate constants
    this._gateThreshLin = Math.pow(10, this.params.gateThresh / 20);
    this._gateReleaseCoef = Math.exp(-1 / (sr * (this.params.gateRelease / 1000)));

    // Compressor constants
    this._compThreshLin = Math.pow(10, this.params.compThresh / 20);
    const ratio = Math.max(1, this.params.compRatio);
    this._compSlope = 1 - 1 / ratio;
    this._compAttackCoef = Math.exp(-1 / (sr * (this.params.compAttack / 1000)));
    this._compReleaseCoef = Math.exp(-1 / (sr * (this.params.compRelease / 1000)));
    this._compMakeupLin = Math.pow(10, this.params.compMakeup / 20);

    // Limiter constants
    this._limThreshLin = Math.pow(10, this.params.limThresh / 20);

    // Global output gain
    this._outGainLin = Math.pow(10, (this.params.outGain || 0) / 20);
  }

  // Biquad high-pass coefficients
  _biquadHP(freq, Q, sr) {
    const w0 = 2 * Math.PI * freq / sr;
    const alpha = Math.sin(w0) / (2 * Q);
    const cos0 = Math.cos(w0);
    const b0 = (1 + cos0) / 2, b1 = -(1 + cos0), b2 = (1 + cos0) / 2;
    const a0 = 1 + alpha, a1 = -2 * cos0, a2 = 1 - alpha;
    return { b0:b0/a0, b1:b1/a0, b2:b2/a0, a1:a1/a0, a2:a2/a0 };
  }

  // Biquad low-pass coefficients
  _biquadLP(freq, Q, sr) {
    const w0 = 2 * Math.PI * freq / sr;
    const alpha = Math.sin(w0) / (2 * Q);
    const cos0 = Math.cos(w0);
    const b0 = (1 - cos0) / 2, b1 = 1 - cos0, b2 = (1 - cos0) / 2;
    const a0 = 1 + alpha, a1 = -2 * cos0, a2 = 1 - alpha;
    return { b0:b0/a0, b1:b1/a0, b2:b2/a0, a1:a1/a0, a2:a2/a0 };
  }

  // Apply a biquad filter in-place to a single-channel block
  _applyBiquad(block, coeff, state) {
    const { b0, b1, b2, a1, a2 } = coeff;
    let [x1, x2, y1, y2] = state;
    for (let i = 0; i < block.length; i++) {
      const x = block[i];
      const y = b0*x + b1*x1 + b2*x2 - a1*y1 - a2*y2;
      x2 = x1; x1 = x; y2 = y1; y1 = y;
      block[i] = y;
    }
    state[0] = x1; state[1] = x2; state[2] = y1; state[3] = y2;
  }

  // Simple RMS-based noise gate (time domain)
  _applyGate(block, ch) {
    const threshLin = this._gateThreshLin;
    const releaseCoef = this._gateReleaseCoef;
    let g = this._gateGain[ch];
    for (let i = 0; i < block.length; i++) {
      const abs = Math.abs(block[i]);
      const target = abs >= threshLin ? 1 : 0.001;
      g = target > g ? target : g * releaseCoef + target * (1 - releaseCoef);
      block[i] *= g;
    }
    this._gateGain[ch] = g;
  }

  // Feed-forward compressor with makeup gain
  _applyComp(block, ch) {
    const threshLin = this._compThreshLin;
    const slope = this._compSlope;
    const attackCoef = this._compAttackCoef;
    const releaseCoef = this._compReleaseCoef;
    const makeupLin = this._compMakeupLin;
    const limThreshLin = this._limThreshLin;
    let env = this._compEnv[ch];
    for (let i = 0; i < block.length; i++) {
      const abs = Math.abs(block[i]);
      // Envelope follower
      env = abs > env ? abs * (1 - attackCoef) + env * attackCoef : abs * (1 - releaseCoef) + env * releaseCoef;
      let gain = 1;
      if (env > threshLin) {
        const overDb = 20 * Math.log10(env / threshLin);
        const gainDb = overDb * slope;
        gain = Math.pow(10, -gainDb / 20);
      }
      // Brickwall limiter
      const out = block[i] * gain * makeupLin;
      block[i] = Math.max(-limThreshLin, Math.min(limThreshLin, out));
    }
    this._compEnv[ch] = env;
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input.length) return true;

    for (let ch = 0; ch < input.length; ch++) {
      const inCh = input[ch];
      const outCh = output[ch];
      if (!inCh || !outCh) continue;

      // Copy input to output buffer for in-place processing
      outCh.set(inCh);

      // HP filter
      if (this._hp) this._applyBiquad(outCh, this._hp, this._hpState[ch] || (this._hpState[ch] = [0,0,0,0]));
      // LP filter
      if (this._lp) this._applyBiquad(outCh, this._lp, this._lpState[ch] || (this._lpState[ch] = [0,0,0,0]));
      // Noise gate
      this._applyGate(outCh, ch);
      // Compressor + limiter
      this._applyComp(outCh, ch);

      // Output gain
      const outGainLin = this._outGainLin;
      for (let i = 0; i < outCh.length; i++) outCh[i] *= outGainLin;
    }
    return true; // keep processor alive
  }
}

registerProcessor('voice-isolate-processor', VoiceIsolateProcessor);
