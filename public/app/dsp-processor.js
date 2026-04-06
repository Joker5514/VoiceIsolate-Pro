// voice-isolate-processor.js - AudioWorkletProcessor

class VoiceIsolateProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'gateThreshold', defaultValue: -42, minValue: -96, maxValue: 0 },
      { name: 'outputGain', defaultValue: 1, minValue: 0, maxValue: 2 },
      { name: 'dryWet', defaultValue: 1, minValue: 0, maxValue: 1 }
    ];
  }

  constructor() {
    super();
    this.frameSize = 4096;
    this.quantumSize = 128;
    this.inRing = new Float32Array(this.frameSize);
    this.inIndex = 0;
    this.outRing = new Float32Array(this.frameSize);
    this.outIndex = 0;
    this.sharedIn = null;
    this.sharedMask = null;
    this.sharedControl = null; // Uint32Array for atomic read/write pointers

    // Derived values caching
    this.prevGate = -42;
    this.prevGain = 1;
    this.prevDryWet = 1;
    this.threshLin = Math.pow(10, -42 / 20);

    // FFT internal buffers
    this.re = new Float32Array(this.frameSize);
    this.im = new Float32Array(this.frameSize);
    this.window = new Float32Array(this.frameSize);
    for (let i = 0; i < this.frameSize; i++) {
      this.window[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (this.frameSize - 1)));
    }

    // Overlap Add Buffer
    this.olaBuffer = new Float32Array(this.frameSize);
    this.hopSize = this.frameSize / 4; // 75% overlap
    this.olaOffset = 0;

    this.port.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'initSAB') {
        this.sharedIn = new Float32Array(msg.inputSAB);
        this.sharedMask = new Float32Array(msg.maskSAB);
        this.sharedControl = new Int32Array(msg.controlSAB);
      }
    };
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input[0] || !output || !output[0]) return true;

    const inChannel = input[0];
    const outChannel = output[0];

    // Update derived params
    const gateParam = parameters.gateThreshold?.length > 1 ? parameters.gateThreshold[0] : parameters.gateThreshold;
    if (gateParam !== undefined && gateParam !== this.prevGate) {
      this.threshLin = Math.pow(10, gateParam / 20);
      this.prevGate = gateParam;
    }
    const outGain = parameters.outputGain?.length > 1 ? parameters.outputGain[0] : (parameters.outputGain || 1);
    const dryWet = parameters.dryWet?.length > 1 ? parameters.dryWet[0] : (parameters.dryWet || 1);

    // Accumulate into ring buffer
    for (let i = 0; i < this.quantumSize; i++) {
      this.inRing[this.inIndex++] = inChannel[i];
      if (this.inIndex >= this.frameSize) {
        this.processFrame();
        this.inIndex -= this.hopSize; // Slide window by hop size
        // Shift remaining data to start
        this.inRing.copyWithin(0, this.hopSize, this.frameSize);
      }

      // Overlap-add output pulling
      outChannel[i] = this.olaBuffer[this.olaOffset] * outGain;
      this.olaBuffer[this.olaOffset] = 0; // Clear after read
      this.olaOffset = (this.olaOffset + 1) % this.frameSize;
    }

    return true;
  }

  processFrame() {
    if (!this.sharedControl || !this.sharedIn || !this.sharedMask) return;

    // Push audio frame to shared SAB (non-blocking)
    const writeIdx = Atomics.load(this.sharedControl, 0);
    this.sharedIn.set(this.inRing, writeIdx * this.frameSize);
    Atomics.store(this.sharedControl, 0, (writeIdx + 1) % 4); // assume 4 frame circular queue for worker

    // Try pull mask
    const readIdx = Atomics.load(this.sharedControl, 1);
    let mask = null;
    if (readIdx !== writeIdx) { // rough check for mask available
       mask = new Float32Array(this.sharedMask.buffer, readIdx * this.frameSize * 4, this.frameSize);
       Atomics.store(this.sharedControl, 1, (readIdx + 1) % 4);
    }

    // Process frequency domain
    for (let i = 0; i < this.frameSize; i++) {
      this.re[i] = this.inRing[i] * this.window[i];
      this.im[i] = 0;
    }

    this.radix2FFT(this.re, this.im, false);

    // Apply Mask & Gate
    const half = this.frameSize / 2;
    for (let i = 0; i <= half; i++) {
       let mag = Math.sqrt(this.re[i]*this.re[i] + this.im[i]*this.im[i]);
       if (mag < this.threshLin) {
         this.re[i] = 0; this.im[i] = 0;
       } else if (mask) {
         this.re[i] *= mask[i];
         this.im[i] *= mask[i];
       }
       if (i > 0 && i < half) {
         this.re[this.frameSize - i] = this.re[i];
         this.im[this.frameSize - i] = -this.im[i];
       }
    }

    this.radix2FFT(this.re, this.im, true);

    // OLA
    for(let i=0; i<this.frameSize; i++) {
        const idx = (this.olaOffset + i) % this.frameSize;
        this.olaBuffer[idx] += this.re[i] * this.window[i];
    }
  }

  radix2FFT(re, im, inverse) {
    const N = this.frameSize;
    let j = 0;
    // Bit-reversal
    for (let i = 0; i < N - 1; i++) {
      if (i < j) {
        let tr = re[i]; let ti = im[i];
        re[i] = re[j]; im[i] = im[j];
        re[j] = tr; im[j] = ti;
      }
      let m = N >> 1;
      while (m >= 1 && j >= m) {
        j -= m;
        m >>= 1;
      }
      j += m;
    }

    // Cooley-Tukey
    const dir = inverse ? 1 : -1;
    for (let m = 2; m <= N; m <<= 1) {
      const w = 2 * Math.PI / m;
      const wpr = Math.cos(w);
      const wpi = dir * Math.sin(w);
      let wr = 1;
      let wi = 0;
      const m2 = m >> 1;
      for (let j = 0; j < m2; j++) {
        for (let i = j; i < N; i += m) {
          const k = i + m2;
          const tr = wr * re[k] - wi * im[k];
          const ti = wr * im[k] + wi * re[k];
          re[k] = re[i] - tr;
          im[k] = im[i] - ti;
          re[i] += tr;
          im[i] += ti;
        }
        let tpr = wr;
        wr = wr * wpr - wi * wpi;
        wi = wi * wpr + tpr * wpi;
      }
    }

    if (inverse) {
      for (let i = 0; i < N; i++) {
        re[i] /= N;
        im[i] /= N;
      }
    }
  }
}

registerProcessor('voice-isolate-processor', VoiceIsolateProcessor);
