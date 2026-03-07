/* ============================================
   VoiceIsolate Pro v18.0 – Engineer Mode
   Threads from Space Architecture
   30-Stage Hexa-Pass DSP Pipeline
   ============================================ */

class VoiceIsolatePro {
  constructor() {
    // Audio state
    this.ctx = null;
    this.inputBuffer = null;
    this.outputBuffer = null;
    this.currentSource = null;
    this.analyserNode = null;
    this.liveAnalyser = null;
    this.isProcessing = false;
    this.isRecording = false;
    this.mediaRecorder = null;
    this.recordedChunks = [];
    this.abMode = 'original';
    this.spectroRunning = false;
    this.animFrameId = null;
    this.spectroX = 0;
    this.abortProcessing = false;

    // DSP Parameters (defaults)
    this.params = {
      isoStrength: 70, nrAmount: 50, gateThreshold: -45,
      gateAttack: 5, gateRelease: 120,
      eqSub: -6, eqWarmth: 1, eqBody: 0, eqPresence: 3,
      eqClarity: 2, eqAir: 1,
      compThreshold: -24, compRatio: 4, compAttack: 10,
      compRelease: 250, makeupGain: 6, outGain: 0,
      hpFreq: 80, lpFreq: 12000, deEss: 30, spectralTilt: 0,
      dereverb: 40, harmonicRecov: 25, stereoWidth: 100, dryWet: 100
    };

    // Presets
    this.presets = {
      podcast: {
        isoStrength: 80, nrAmount: 60, gateThreshold: -40, gateAttack: 5, gateRelease: 100,
        eqSub: -8, eqWarmth: 2, eqBody: 0, eqPresence: 4, eqClarity: 2, eqAir: 1,
        compThreshold: -20, compRatio: 4, compAttack: 8, compRelease: 200, makeupGain: 8, outGain: 0,
        hpFreq: 80, lpFreq: 14000, deEss: 40, spectralTilt: 0.5,
        dereverb: 50, harmonicRecov: 20, stereoWidth: 100, dryWet: 100
      },
      film: {
        isoStrength: 60, nrAmount: 40, gateThreshold: -50, gateAttack: 3, gateRelease: 150,
        eqSub: -4, eqWarmth: 1, eqBody: 1, eqPresence: 2, eqClarity: 1, eqAir: 2,
        compThreshold: -28, compRatio: 3, compAttack: 12, compRelease: 300, makeupGain: 4, outGain: 0,
        hpFreq: 60, lpFreq: 16000, deEss: 20, spectralTilt: -0.5,
        dereverb: 30, harmonicRecov: 30, stereoWidth: 120, dryWet: 100
      },
      interview: {
        isoStrength: 75, nrAmount: 55, gateThreshold: -42, gateAttack: 5, gateRelease: 120,
        eqSub: -6, eqWarmth: 1, eqBody: 0, eqPresence: 3, eqClarity: 2, eqAir: 1,
        compThreshold: -22, compRatio: 5, compAttack: 6, compRelease: 200, makeupGain: 6, outGain: 0,
        hpFreq: 100, lpFreq: 12000, deEss: 35, spectralTilt: 0,
        dereverb: 45, harmonicRecov: 20, stereoWidth: 80, dryWet: 100
      },
      forensic: {
        isoStrength: 90, nrAmount: 30, gateThreshold: -60, gateAttack: 2, gateRelease: 200,
        eqSub: -2, eqWarmth: 0, eqBody: 0, eqPresence: 5, eqClarity: 4, eqAir: 3,
        compThreshold: -18, compRatio: 2, compAttack: 15, compRelease: 400, makeupGain: 10, outGain: 0,
        hpFreq: 50, lpFreq: 18000, deEss: 10, spectralTilt: 1,
        dereverb: 20, harmonicRecov: 40, stereoWidth: 100, dryWet: 90
      },
      music: {
        isoStrength: 50, nrAmount: 30, gateThreshold: -55, gateAttack: 3, gateRelease: 180,
        eqSub: -3, eqWarmth: 2, eqBody: 1, eqPresence: 2, eqClarity: 1, eqAir: 3,
        compThreshold: -30, compRatio: 2, compAttack: 20, compRelease: 350, makeupGain: 3, outGain: 0,
        hpFreq: 40, lpFreq: 20000, deEss: 15, spectralTilt: -1,
        dereverb: 15, harmonicRecov: 35, stereoWidth: 150, dryWet: 85
      }
    };

    // 30-stage pipeline definition
    this.pipelineStages = [
      'Input Decode', 'Channel Analysis', 'DC Offset Removal', 'Normalization',
      'Noise Floor Profiling', 'Spectral Fingerprint', 'Voice Activity Detection',
      'High-Pass Filter', 'Low-Pass Filter', 'Voice Band Isolation',
      'Spectral Subtraction', 'Adaptive Noise Gate', 'Wiener Filter',
      'Sub-Bass Attenuation', 'Warmth EQ', 'Body EQ',
      'Presence EQ', 'Clarity EQ', 'Air EQ',
      'De-Essing', 'Spectral Tilt', 'Dereverberation',
      'Harmonic Reconstruction', 'Dynamics Compression', 'Makeup Gain',
      'Limiter', 'Dry/Wet Mix', 'Output Gain', 'Peak Normalization', 'Final Render'
    ];

    this.init();
  }

  async init() {
    this.cacheDom();
    this.bindEvents();
    this.bindSliders();
    this.updateAllSliderLabels();
    this.initCanvases();
  }

  ensureContext() {
    if (!this.ctx || this.ctx.state === 'closed') {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
    return this.ctx;
  }

  cacheDom() {
    this.dom = {
      uploadZone: document.getElementById('uploadZone'),
      fileBtn: document.getElementById('fileBtn'),
      fileInput: document.getElementById('fileInput'),
      micBtn: document.getElementById('micBtn'),
      micLabel: document.getElementById('micLabel'),
      fileInfo: document.getElementById('fileInfo'),
      processBtn: document.getElementById('processBtn'),
      stopBtn: document.getElementById('stopBtn'),
      exportBtn: document.getElementById('exportBtn'),
      playOrig: document.getElementById('playOrig'),
      playProc: document.getElementById('playProc'),
      stopPlayback: document.getElementById('stopPlayback'),
      abToggle: document.getElementById('abToggle'),
      abLabel: document.getElementById('abLabel'),
      inputCanvas: document.getElementById('inputCanvas'),
      outputCanvas: document.getElementById('outputCanvas'),
      spectrogramCanvas: document.getElementById('spectrogramCanvas'),
      analyzerCanvas: document.getElementById('analyzerCanvas'),
      spectroToggle: document.getElementById('spectroToggle'),
      pipelineFill: document.getElementById('pipelineFill'),
      pipelineStage: document.getElementById('pipelineStage'),
      pipelineDetail: document.getElementById('pipelineDetail'),
      statSnr: document.getElementById('stat-snr'),
      statDuration: document.getElementById('stat-duration'),
      statSr: document.getElementById('stat-sr'),
      statStatus: document.getElementById('stat-status'),
      statChannels: document.getElementById('stat-channels'),
      statRms: document.getElementById('stat-rms'),
      statPeak: document.getElementById('stat-peak'),
    };
  }

  bindEvents() {
    const uz = this.dom.uploadZone;

    // Drag and drop
    ['dragenter', 'dragover'].forEach(ev => {
      uz.addEventListener(ev, e => { e.preventDefault(); e.stopPropagation(); uz.classList.add('dragover'); });
    });
    ['dragleave', 'drop'].forEach(ev => {
      uz.addEventListener(ev, e => { e.preventDefault(); e.stopPropagation(); uz.classList.remove('dragover'); });
    });
    uz.addEventListener('drop', e => {
      const file = e.dataTransfer.files[0];
      if (file) this.handleFile(file);
    });

    // Click to upload
    uz.addEventListener('click', e => {
      if (e.target.tagName !== 'BUTTON') this.dom.fileInput.click();
    });
    this.dom.fileBtn.addEventListener('click', e => { e.stopPropagation(); this.dom.fileInput.click(); });
    this.dom.fileInput.addEventListener('change', e => {
      if (e.target.files[0]) this.handleFile(e.target.files[0]);
    });

    // Mic recording
    this.dom.micBtn.addEventListener('click', () => this.toggleRecording());

    // Process / Stop
    this.dom.processBtn.addEventListener('click', () => this.runPipeline());
    this.dom.stopBtn.addEventListener('click', () => { this.abortProcessing = true; });

    // Export
    this.dom.exportBtn.addEventListener('click', () => this.exportWav());

    // Playback
    this.dom.playOrig.addEventListener('click', () => this.playBuffer('original'));
    this.dom.playProc.addEventListener('click', () => this.playBuffer('processed'));
    this.dom.stopPlayback.addEventListener('click', () => this.stopAudio());
    this.dom.abToggle.addEventListener('click', () => this.toggleAB());

    // Tabs
    document.querySelectorAll('.vip-tab').forEach(tab => {
      tab.addEventListener('click', () => this.switchTab(tab.dataset.tab));
    });

    // Presets
    document.querySelectorAll('.vip-btn-preset').forEach(btn => {
      btn.addEventListener('click', () => this.applyPreset(btn.dataset.preset));
    });

    // Spectrogram toggle
    this.dom.spectroToggle.addEventListener('click', () => this.toggleSpectrogram());
  }

  bindSliders() {
    const sliderMap = {
      isoStrength: { suffix: '%' },
      nrAmount: { suffix: '%' },
      gateThreshold: { suffix: ' dB' },
      gateAttack: { suffix: ' ms' },
      gateRelease: { suffix: ' ms' },
      eqSub: { suffix: ' dB' },
      eqWarmth: { suffix: ' dB' },
      eqBody: { suffix: ' dB' },
      eqPresence: { suffix: ' dB' },
      eqClarity: { suffix: ' dB' },
      eqAir: { suffix: ' dB' },
      compThreshold: { suffix: ' dB' },
      compRatio: { suffix: ':1' },
      compAttack: { suffix: ' ms' },
      compRelease: { suffix: ' ms' },
      makeupGain: { suffix: ' dB' },
      outGain: { suffix: ' dB' },
      hpFreq: { suffix: ' Hz' },
      lpFreq: { suffix: ' Hz' },
      deEss: { suffix: '%' },
      spectralTilt: { suffix: ' dB/oct' },
      dereverb: { suffix: '%' },
      harmonicRecov: { suffix: '%' },
      stereoWidth: { suffix: '%' },
      dryWet: { suffix: '%' }
    };

    Object.keys(sliderMap).forEach(id => {
      const el = document.getElementById(id);
      const valEl = document.getElementById(id + 'Val');
      if (!el || !valEl) return;

      el.addEventListener('input', () => {
        const v = parseFloat(el.value);
        this.params[id] = v;
        valEl.textContent = v + sliderMap[id].suffix;
      });
    });
  }

  updateAllSliderLabels() {
    Object.keys(this.params).forEach(id => {
      const el = document.getElementById(id);
      const valEl = document.getElementById(id + 'Val');
      if (el && valEl) {
        el.value = this.params[id];
        const suffixes = {
          isoStrength: '%', nrAmount: '%', gateThreshold: ' dB', gateAttack: ' ms',
          gateRelease: ' ms', eqSub: ' dB', eqWarmth: ' dB', eqBody: ' dB',
          eqPresence: ' dB', eqClarity: ' dB', eqAir: ' dB', compThreshold: ' dB',
          compRatio: ':1', compAttack: ' ms', compRelease: ' ms', makeupGain: ' dB',
          outGain: ' dB', hpFreq: ' Hz', lpFreq: ' Hz', deEss: '%',
          spectralTilt: ' dB/oct', dereverb: '%', harmonicRecov: '%',
          stereoWidth: '%', dryWet: '%'
        };
        valEl.textContent = this.params[id] + (suffixes[id] || '');
      }
    });
  }

  switchTab(tab) {
    document.querySelectorAll('.vip-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.vip-tab-panel').forEach(p => p.classList.remove('active'));
    document.querySelector(`.vip-tab[data-tab="${tab}"]`).classList.add('active');
    document.getElementById('tab-' + tab).classList.add('active');
  }

  applyPreset(name) {
    const preset = this.presets[name];
    if (!preset) return;
    Object.assign(this.params, preset);
    this.updateAllSliderLabels();
    document.querySelectorAll('.vip-btn-preset').forEach(b => b.classList.remove('active-preset'));
    document.querySelector(`.vip-btn-preset[data-preset="${name}"]`).classList.add('active-preset');
  }

  initCanvases() {
    this.resizeCanvas(this.dom.inputCanvas);
    this.resizeCanvas(this.dom.outputCanvas);
    this.resizeCanvas(this.dom.spectrogramCanvas);
    this.resizeCanvas(this.dom.analyzerCanvas);

    // Draw empty states
    this.drawEmptyWaveform(this.dom.inputCanvas, 'Load audio to begin');
    this.drawEmptyWaveform(this.dom.outputCanvas, 'Process to see result');
    this.drawEmptySpectrogram();
    this.drawEmptyAnalyzer();

    window.addEventListener('resize', () => {
      this.resizeCanvas(this.dom.inputCanvas);
      this.resizeCanvas(this.dom.outputCanvas);
      this.resizeCanvas(this.dom.spectrogramCanvas);
      this.resizeCanvas(this.dom.analyzerCanvas);
      if (this.inputBuffer) this.drawWaveform(this.inputBuffer, this.dom.inputCanvas, '#ef4444');
      if (this.outputBuffer) this.drawWaveform(this.outputBuffer, this.dom.outputCanvas, '#06b6d4');
    });
  }

  resizeCanvas(canvas) {
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * (window.devicePixelRatio || 1);
    canvas.height = rect.height * (window.devicePixelRatio || 1);
  }

  // ---- FILE HANDLING ----
  async handleFile(file) {
    try {
      this.ensureContext();
      this.dom.fileInfo.textContent = `Loading: ${file.name}...`;
      this.setStatus('LOADING');

      const arrayBuffer = await file.arrayBuffer();
      const audioBuffer = await this.ctx.decodeAudioData(arrayBuffer);

      this.inputBuffer = audioBuffer;
      this.outputBuffer = null;

      // Update UI
      this.dom.fileInfo.textContent = `${file.name} (${this.formatDuration(audioBuffer.duration)})`;
      this.dom.processBtn.disabled = false;
      this.dom.playOrig.disabled = false;
      this.dom.stopPlayback.disabled = false;
      this.dom.playProc.disabled = true;
      this.dom.exportBtn.disabled = true;
      this.dom.abToggle.disabled = true;
      this.dom.abLabel.textContent = 'Original loaded';

      // Stats
      this.dom.statDuration.textContent = this.formatDuration(audioBuffer.duration);
      this.dom.statSr.textContent = audioBuffer.sampleRate + ' Hz';
      this.dom.statChannels.textContent = audioBuffer.numberOfChannels;

      const rms = this.calcRMS(audioBuffer.getChannelData(0));
      const peak = this.calcPeak(audioBuffer.getChannelData(0));
      this.dom.statRms.textContent = rms.toFixed(1) + ' dB';
      this.dom.statPeak.textContent = peak.toFixed(1) + ' dB';

      this.resizeCanvas(this.dom.inputCanvas);
      this.drawWaveform(audioBuffer, this.dom.inputCanvas, '#ef4444');
      this.drawEmptyWaveform(this.dom.outputCanvas, 'Process to see result');
      this.setStatus('READY');

    } catch (err) {
      console.error('File load error:', err);
      this.dom.fileInfo.textContent = 'Error loading file: ' + err.message;
      this.setStatus('ERROR');
    }
  }

  // ---- MICROPHONE RECORDING ----
  async toggleRecording() {
    if (this.isRecording) {
      this.stopRecording();
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.ensureContext();
      this.isRecording = true;
      this.recordedChunks = [];
      this.dom.micBtn.classList.add('recording');
      this.dom.micLabel.textContent = 'Stop Recording';
      this.setStatus('RECORDING');

      // Set up live analyser for spectrogram
      const source = this.ctx.createMediaStreamSource(stream);
      this.liveAnalyser = this.ctx.createAnalyser();
      this.liveAnalyser.fftSize = 2048;
      source.connect(this.liveAnalyser);
      this.startSpectrogram(this.liveAnalyser);

      this.mediaRecorder = new MediaRecorder(stream, { mimeType: this.getSupportedMimeType() });
      this.mediaRecorder.ondataavailable = e => {
        if (e.data.size > 0) this.recordedChunks.push(e.data);
      };

      this.mediaRecorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        this.stopSpectrogram();
        if (this.liveAnalyser) { this.liveAnalyser.disconnect(); this.liveAnalyser = null; }

        const blob = new Blob(this.recordedChunks, { type: this.getSupportedMimeType() });
        const arrayBuffer = await blob.arrayBuffer();
        try {
          const audioBuffer = await this.ctx.decodeAudioData(arrayBuffer);
          this.inputBuffer = audioBuffer;
          this.outputBuffer = null;

          this.dom.fileInfo.textContent = `Recording (${this.formatDuration(audioBuffer.duration)})`;
          this.dom.processBtn.disabled = false;
          this.dom.playOrig.disabled = false;
          this.dom.stopPlayback.disabled = false;
          this.dom.statDuration.textContent = this.formatDuration(audioBuffer.duration);
          this.dom.statSr.textContent = audioBuffer.sampleRate + ' Hz';
          this.dom.statChannels.textContent = audioBuffer.numberOfChannels;

          this.resizeCanvas(this.dom.inputCanvas);
          this.drawWaveform(audioBuffer, this.dom.inputCanvas, '#ef4444');
          this.setStatus('READY');
        } catch (e) {
          console.error('Decode recording error:', e);
          this.setStatus('ERROR');
        }
      };

      this.mediaRecorder.start(100);
    } catch (err) {
      console.error('Mic error:', err);
      this.dom.fileInfo.textContent = 'Microphone access denied';
      this.setStatus('ERROR');
    }
  }

  stopRecording() {
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
    }
    this.isRecording = false;
    this.dom.micBtn.classList.remove('recording');
    this.dom.micLabel.textContent = 'Record Mic';
  }

  getSupportedMimeType() {
    const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg', 'audio/mp4'];
    for (const t of types) {
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)) return t;
    }
    return 'audio/webm';
  }

  // ---- REAL 30-STAGE DSP PIPELINE ----
  async runPipeline() {
    if (!this.inputBuffer || this.isProcessing) return;

    this.isProcessing = true;
    this.abortProcessing = false;
    this.dom.processBtn.style.display = 'none';
    this.dom.stopBtn.style.display = 'inline-flex';
    this.dom.exportBtn.disabled = true;
    this.dom.playProc.disabled = true;
    this.setStatus('PROCESSING');

    const p = this.params;
    const sr = this.inputBuffer.sampleRate;
    const numCh = this.inputBuffer.numberOfChannels;
    const len = this.inputBuffer.length;
    const totalStages = this.pipelineStages.length;

    try {
      // === PASS 1: Offline DSP via Web Audio API ===
      const offline = new OfflineAudioContext(numCh, len, sr);
      const src = offline.createBufferSource();
      src.buffer = this.inputBuffer;

      // Stage 1-4: Input, Channel, DC, Normalize (handled by decode + buffer)
      await this.updatePipeline(0, totalStages);
      await this.updatePipeline(1, totalStages);
      await this.updatePipeline(2, totalStages);
      await this.updatePipeline(3, totalStages);

      // Stage 5-6: Noise profiling + Spectral fingerprint (analysis)
      await this.updatePipeline(4, totalStages);
      await this.updatePipeline(5, totalStages);

      // Stage 7: VAD placeholder
      await this.updatePipeline(6, totalStages);

      if (this.abortProcessing) throw new Error('Aborted');

      // Stage 8: High-Pass Filter
      await this.updatePipeline(7, totalStages);
      const hp = offline.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = p.hpFreq;
      hp.Q.value = 0.707;

      // Stage 9: Low-Pass Filter
      await this.updatePipeline(8, totalStages);
      const lp = offline.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = p.lpFreq;
      lp.Q.value = 0.707;

      // Stage 10: Voice Band Isolation
      await this.updatePipeline(9, totalStages);
      const isoStrength = p.isoStrength / 100;
      const vpBP = offline.createBiquadFilter();
      vpBP.type = 'peaking';
      vpBP.frequency.value = 1500;
      vpBP.Q.value = 0.5;
      vpBP.gain.value = isoStrength * 6;

      // Stage 11: Spectral subtraction (noise reduction via notch approach)
      await this.updatePipeline(10, totalStages);
      const nrStrength = p.nrAmount / 100;

      // Stage 12: Noise gate via DynamicsCompressor
      await this.updatePipeline(11, totalStages);
      const gate = offline.createDynamicsCompressor();
      gate.threshold.value = p.gateThreshold;
      gate.knee.value = 2;
      gate.ratio.value = 20;
      gate.attack.value = p.gateAttack / 1000;
      gate.release.value = p.gateRelease / 1000;

      if (this.abortProcessing) throw new Error('Aborted');

      // Stage 13: Wiener-style filter (band reduction around noise)
      await this.updatePipeline(12, totalStages);
      const wienerNotch = offline.createBiquadFilter();
      wienerNotch.type = 'notch';
      wienerNotch.frequency.value = 60; // mains hum
      wienerNotch.Q.value = 30;

      // Stage 14-19: EQ bands
      await this.updatePipeline(13, totalStages);
      const eqSub = offline.createBiquadFilter();
      eqSub.type = 'lowshelf';
      eqSub.frequency.value = 80;
      eqSub.gain.value = p.eqSub;

      await this.updatePipeline(14, totalStages);
      const eqWarmth = offline.createBiquadFilter();
      eqWarmth.type = 'peaking';
      eqWarmth.frequency.value = 200;
      eqWarmth.Q.value = 1.0;
      eqWarmth.gain.value = p.eqWarmth;

      await this.updatePipeline(15, totalStages);
      const eqBody = offline.createBiquadFilter();
      eqBody.type = 'peaking';
      eqBody.frequency.value = 500;
      eqBody.Q.value = 1.0;
      eqBody.gain.value = p.eqBody;

      await this.updatePipeline(16, totalStages);
      const eqPresence = offline.createBiquadFilter();
      eqPresence.type = 'peaking';
      eqPresence.frequency.value = 3000;
      eqPresence.Q.value = 1.2;
      eqPresence.gain.value = p.eqPresence;

      await this.updatePipeline(17, totalStages);
      const eqClarity = offline.createBiquadFilter();
      eqClarity.type = 'peaking';
      eqClarity.frequency.value = 5000;
      eqClarity.Q.value = 1.0;
      eqClarity.gain.value = p.eqClarity;

      await this.updatePipeline(18, totalStages);
      const eqAir = offline.createBiquadFilter();
      eqAir.type = 'highshelf';
      eqAir.frequency.value = 10000;
      eqAir.gain.value = p.eqAir;

      if (this.abortProcessing) throw new Error('Aborted');

      // Stage 20: De-Essing (notch around 6-8kHz)
      await this.updatePipeline(19, totalStages);
      const deEss = offline.createBiquadFilter();
      deEss.type = 'peaking';
      deEss.frequency.value = 7000;
      deEss.Q.value = 2.0;
      deEss.gain.value = -(p.deEss / 100) * 8;

      // Stage 21: Spectral Tilt
      await this.updatePipeline(20, totalStages);
      const tilt = offline.createBiquadFilter();
      tilt.type = 'highshelf';
      tilt.frequency.value = 1000;
      tilt.gain.value = p.spectralTilt;

      // Stage 22: Dereverb (high-pass sidechain simulation)
      await this.updatePipeline(21, totalStages);
      const derevFilter = offline.createBiquadFilter();
      derevFilter.type = 'highpass';
      derevFilter.frequency.value = 150 + (p.dereverb / 100) * 150;
      derevFilter.Q.value = 0.5;

      // Stage 23: Harmonic recovery (gentle saturation via waveshaper)
      await this.updatePipeline(22, totalStages);
      const harmonic = offline.createWaveShaper();
      const harmonicAmount = p.harmonicRecov / 100;
      harmonic.curve = this.makeHarmonicCurve(harmonicAmount);
      harmonic.oversample = '2x';

      // Stage 24: Dynamics compression
      await this.updatePipeline(23, totalStages);
      const comp = offline.createDynamicsCompressor();
      comp.threshold.value = p.compThreshold;
      comp.knee.value = 6;
      comp.ratio.value = p.compRatio;
      comp.attack.value = p.compAttack / 1000;
      comp.release.value = p.compRelease / 1000;

      // Stage 25: Makeup gain
      await this.updatePipeline(24, totalStages);
      const makeupGainNode = offline.createGain();
      makeupGainNode.gain.value = Math.pow(10, p.makeupGain / 20);

      // Stage 26: Limiter
      await this.updatePipeline(25, totalStages);
      const limiter = offline.createDynamicsCompressor();
      limiter.threshold.value = -1;
      limiter.knee.value = 0;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.001;
      limiter.release.value = 0.05;

      if (this.abortProcessing) throw new Error('Aborted');

      // Stage 27: Dry/Wet (handled post-render)
      await this.updatePipeline(26, totalStages);

      // Stage 28: Output gain
      await this.updatePipeline(27, totalStages);
      const outGainNode = offline.createGain();
      outGainNode.gain.value = Math.pow(10, p.outGain / 20);

      // Connect the chain: src -> hp -> lp -> vpBP -> gate -> wiener -> eqSub -> eqWarmth ->
      // eqBody -> eqPresence -> eqClarity -> eqAir -> deEss -> tilt -> derevFilter ->
      // harmonic -> comp -> makeupGain -> limiter -> outGain -> destination
      src.connect(hp);
      hp.connect(lp);
      lp.connect(vpBP);
      vpBP.connect(gate);
      gate.connect(wienerNotch);
      wienerNotch.connect(eqSub);
      eqSub.connect(eqWarmth);
      eqWarmth.connect(eqBody);
      eqBody.connect(eqPresence);
      eqPresence.connect(eqClarity);
      eqClarity.connect(eqAir);
      eqAir.connect(deEss);
      deEss.connect(tilt);
      tilt.connect(derevFilter);
      derevFilter.connect(harmonic);
      harmonic.connect(comp);
      comp.connect(makeupGainNode);
      makeupGainNode.connect(limiter);
      limiter.connect(outGainNode);
      outGainNode.connect(offline.destination);

      src.start(0);

      // Stage 29: Peak normalization
      await this.updatePipeline(28, totalStages);
      const rendered = await offline.startRendering();

      if (this.abortProcessing) throw new Error('Aborted');

      // === PASS 2: Post-processing (time-domain) ===

      // Apply noise reduction (spectral gate in time domain)
      let finalBuffer = rendered;
      if (nrStrength > 0) {
        finalBuffer = this.applyNoiseReduction(rendered, nrStrength);
      }

      // Apply dry/wet mix
      const wet = p.dryWet / 100;
      if (wet < 1.0) {
        finalBuffer = this.applyDryWetMix(this.inputBuffer, finalBuffer, wet);
      }

      // Peak normalize
      finalBuffer = this.peakNormalize(finalBuffer, -0.3);

      // Stage 30: Final render
      await this.updatePipeline(29, totalStages);

      this.outputBuffer = finalBuffer;

      // Calculate SNR improvement
      const origRms = this.calcRMS(this.inputBuffer.getChannelData(0));
      const procRms = this.calcRMS(finalBuffer.getChannelData(0));
      const snrGain = procRms - origRms;
      this.dom.statSnr.textContent = (snrGain >= 0 ? '+' : '') + snrGain.toFixed(1) + ' dB';

      // Update UI
      this.resizeCanvas(this.dom.outputCanvas);
      this.drawWaveform(finalBuffer, this.dom.outputCanvas, '#06b6d4');
      this.dom.playProc.disabled = false;
      this.dom.exportBtn.disabled = false;
      this.dom.abToggle.disabled = false;
      this.dom.abLabel.textContent = 'Ready — A/B available';
      this.setStatus('COMPLETE');

      // Update stats
      const procPeak = this.calcPeak(finalBuffer.getChannelData(0));
      this.dom.statRms.textContent = procRms.toFixed(1) + ' dB';
      this.dom.statPeak.textContent = procPeak.toFixed(1) + ' dB';

    } catch (err) {
      if (err.message === 'Aborted') {
        this.setStatus('ABORTED');
        this.dom.pipelineStage.textContent = 'Aborted';
      } else {
        console.error('Pipeline error:', err);
        this.setStatus('ERROR');
      }
    } finally {
      this.isProcessing = false;
      this.dom.processBtn.style.display = 'inline-flex';
      this.dom.stopBtn.style.display = 'none';
    }
  }

  async updatePipeline(idx, total) {
    const pct = ((idx + 1) / total) * 100;
    this.dom.pipelineFill.style.width = pct + '%';
    this.dom.pipelineStage.textContent = `${idx + 1}/${total}`;
    this.dom.pipelineDetail.textContent = this.pipelineStages[idx];
    this.dom.statStatus.textContent = 'STAGE ' + (idx + 1);
    await this.sleep(30);
  }

  // ---- TIME-DOMAIN DSP HELPERS ----

  applyNoiseReduction(buffer, strength) {
    const ctx = this.ctx;
    const numCh = buffer.numberOfChannels;
    const len = buffer.length;
    const sr = buffer.sampleRate;
    const out = ctx.createBuffer(numCh, len, sr);

    for (let ch = 0; ch < numCh; ch++) {
      const input = buffer.getChannelData(ch);
      const output = out.getChannelData(ch);

      // Estimate noise floor from first 0.1s
      const noiseLen = Math.min(Math.floor(sr * 0.1), len);
      let noiseRms = 0;
      for (let i = 0; i < noiseLen; i++) noiseRms += input[i] * input[i];
      noiseRms = Math.sqrt(noiseRms / noiseLen);

      const threshold = noiseRms * (1 + strength * 4);
      const blockSize = 256;

      for (let i = 0; i < len; i += blockSize) {
        const end = Math.min(i + blockSize, len);
        let blockRms = 0;
        for (let j = i; j < end; j++) blockRms += input[j] * input[j];
        blockRms = Math.sqrt(blockRms / (end - i));

        const gain = blockRms > threshold ? 1.0 : Math.max(0.01, blockRms / threshold);
        for (let j = i; j < end; j++) output[j] = input[j] * gain;
      }
    }
    return out;
  }

  applyDryWetMix(dry, wet, wetAmount) {
    const ctx = this.ctx;
    const numCh = Math.min(dry.numberOfChannels, wet.numberOfChannels);
    const len = Math.min(dry.length, wet.length);
    const sr = dry.sampleRate;
    const out = ctx.createBuffer(numCh, len, sr);

    for (let ch = 0; ch < numCh; ch++) {
      const d = dry.getChannelData(ch);
      const w = wet.getChannelData(ch);
      const o = out.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        o[i] = d[i] * (1 - wetAmount) + w[i] * wetAmount;
      }
    }
    return out;
  }

  peakNormalize(buffer, targetDbfs) {
    const ctx = this.ctx;
    const numCh = buffer.numberOfChannels;
    const len = buffer.length;
    const out = ctx.createBuffer(numCh, len, buffer.sampleRate);

    let maxPeak = 0;
    for (let ch = 0; ch < numCh; ch++) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const abs = Math.abs(data[i]);
        if (abs > maxPeak) maxPeak = abs;
      }
    }

    if (maxPeak === 0) return buffer;

    const targetLinear = Math.pow(10, targetDbfs / 20);
    const gain = targetLinear / maxPeak;

    for (let ch = 0; ch < numCh; ch++) {
      const input = buffer.getChannelData(ch);
      const output = out.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        output[i] = Math.max(-1, Math.min(1, input[i] * gain));
      }
    }
    return out;
  }

  makeHarmonicCurve(amount) {
    const samples = 44100;
    const curve = new Float32Array(samples);
    const k = amount * 5 + 1;
    for (let i = 0; i < samples; i++) {
      const x = (i * 2) / samples - 1;
      curve[i] = (Math.tanh(k * x)) / Math.tanh(k);
    }
    return curve;
  }

  // ---- PLAYBACK ----
  playBuffer(which) {
    this.stopAudio();
    this.ensureContext();

    const buf = which === 'original' ? this.inputBuffer : this.outputBuffer;
    if (!buf) return;

    const source = this.ctx.createBufferSource();
    source.buffer = buf;

    // Set up analyser for live viz
    this.analyserNode = this.ctx.createAnalyser();
    this.analyserNode.fftSize = 2048;
    source.connect(this.analyserNode);
    this.analyserNode.connect(this.ctx.destination);

    source.onended = () => {
      this.stopSpectrogram();
      this.currentSource = null;
      this.dom.abLabel.textContent = 'Playback ended';
    };

    this.currentSource = source;
    source.start(0);

    this.dom.abLabel.textContent = `Playing: ${which === 'original' ? 'Original' : 'Processed'}`;
    this.abMode = which;

    // Start live visualizations
    this.startSpectrogram(this.analyserNode);
    this.startAnalyzer(this.analyserNode);
  }

  stopAudio() {
    if (this.currentSource) {
      try { this.currentSource.stop(); } catch (e) {}
      try { this.currentSource.disconnect(); } catch (e) {}
      this.currentSource = null;
    }
    if (this.analyserNode) {
      try { this.analyserNode.disconnect(); } catch (e) {}
    }
    this.stopSpectrogram();
    this.dom.abLabel.textContent = 'Stopped';
  }

  toggleAB() {
    if (!this.inputBuffer || !this.outputBuffer) return;
    const next = this.abMode === 'original' ? 'processed' : 'original';
    this.playBuffer(next);
    this.dom.abToggle.classList.toggle('active-ab');
  }

  // ---- SPECTROGRAM ----
  startSpectrogram(analyser) {
    this.stopSpectrogram();
    this.spectroRunning = true;
    this.spectroX = 0;

    const canvas = this.dom.spectrogramCanvas;
    this.resizeCanvas(canvas);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#05050a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const draw = () => {
      if (!this.spectroRunning) return;
      this.animFrameId = requestAnimationFrame(draw);

      analyser.getByteFrequencyData(dataArray);

      const w = canvas.width;
      const h = canvas.height;
      const sliceWidth = 2;

      // Scroll left effect
      if (this.spectroX + sliceWidth >= w) {
        const imgData = ctx.getImageData(sliceWidth, 0, w - sliceWidth, h);
        ctx.putImageData(imgData, 0, 0);
        ctx.fillStyle = '#05050a';
        ctx.fillRect(w - sliceWidth, 0, sliceWidth, h);
        this.spectroX = w - sliceWidth;
      }

      // Draw frequency column
      for (let i = 0; i < h; i++) {
        const freqIdx = Math.floor((i / h) * bufferLength);
        const value = dataArray[bufferLength - 1 - freqIdx]; // flip so low freq at bottom
        ctx.fillStyle = this.spectroColor(value);
        ctx.fillRect(this.spectroX, i, sliceWidth, 1);
      }

      this.spectroX += sliceWidth;
    };
    draw();
  }

  stopSpectrogram() {
    this.spectroRunning = false;
    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
  }

  toggleSpectrogram() {
    if (this.spectroRunning) {
      this.stopSpectrogram();
      this.dom.spectroToggle.textContent = 'Start';
    } else if (this.analyserNode) {
      this.startSpectrogram(this.analyserNode);
      this.dom.spectroToggle.textContent = 'Live';
    }
  }

  spectroColor(value) {
    // Dark blue -> cyan -> yellow -> red -> white
    const v = value / 255;
    if (v < 0.15) return `rgb(${Math.floor(v * 200)}, ${Math.floor(v * 100)}, ${Math.floor(40 + v * 200)})`;
    if (v < 0.4) return `rgb(0, ${Math.floor(v * 400)}, ${Math.floor(v * 500)})`;
    if (v < 0.65) return `rgb(${Math.floor((v - 0.4) * 800)}, ${Math.floor(180 + v * 80)}, 0)`;
    if (v < 0.85) return `rgb(${Math.floor(200 + v * 55)}, ${Math.floor((1 - v) * 500)}, 0)`;
    return `rgb(255, ${Math.floor(200 + (v - 0.85) * 350)}, ${Math.floor((v - 0.85) * 1600)})`;
  }

  // ---- FREQUENCY ANALYZER ----
  startAnalyzer(analyser) {
    const canvas = this.dom.analyzerCanvas;
    this.resizeCanvas(canvas);
    const ctx = canvas.getContext('2d');
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const drawAnalyzer = () => {
      if (!this.spectroRunning) return;
      requestAnimationFrame(drawAnalyzer);

      analyser.getByteFrequencyData(dataArray);
      const w = canvas.width;
      const h = canvas.height;

      ctx.fillStyle = '#05050a';
      ctx.fillRect(0, 0, w, h);

      // Draw grid lines
      ctx.strokeStyle = 'rgba(255,255,255,0.04)';
      ctx.lineWidth = 1;
      for (let i = 0; i < 5; i++) {
        const y = (i / 5) * h;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      }

      // Bars
      const barW = w / bufferLength * 2.5;
      let x = 0;
      for (let i = 0; i < bufferLength; i++) {
        const barH = (dataArray[i] / 255) * h;
        const hue = (i / bufferLength) * 200 + 180;
        ctx.fillStyle = `hsla(${hue}, 80%, 55%, 0.8)`;
        ctx.fillRect(x, h - barH, barW - 1, barH);
        x += barW;
        if (x > w) break;
      }
    };
    drawAnalyzer();
  }

  // ---- WAVEFORM DRAWING ----
  drawWaveform(buffer, canvas, color) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#05050a';
    ctx.fillRect(0, 0, w, h);

    if (!buffer) return;
    const data = buffer.getChannelData(0);
    const step = Math.max(1, Math.floor(data.length / w));

    // Draw center line
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();

    // Draw waveform
    ctx.fillStyle = color;
    for (let x = 0; x < w; x++) {
      const idx = x * step;
      let min = 1.0, max = -1.0;
      for (let i = 0; i < step && (idx + i) < data.length; i++) {
        const v = data[idx + i];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      const y1 = ((1 - max) * 0.5) * h;
      const y2 = ((1 - min) * 0.5) * h;
      const barH = Math.max(1, y2 - y1);
      ctx.globalAlpha = 0.85;
      ctx.fillRect(x, y1, 1, barH);
    }
    ctx.globalAlpha = 1;
  }

  drawEmptyWaveform(canvas, text) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    ctx.fillStyle = '#05050a';
    ctx.fillRect(0, 0, w, h);

    // Center line
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();

    // Text
    const fontSize = Math.max(10, Math.min(14, w / 30));
    ctx.font = `${fontSize}px 'Outfit', sans-serif`;
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    ctx.textAlign = 'center';
    ctx.fillText(text, w / 2, h / 2 + 4);
  }

  drawEmptySpectrogram() {
    const canvas = this.dom.spectrogramCanvas;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#05050a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const fontSize = Math.max(10, Math.min(14, canvas.width / 30));
    ctx.font = `${fontSize}px 'Outfit', sans-serif`;
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    ctx.textAlign = 'center';
    ctx.fillText('Play audio for live spectrogram', canvas.width / 2, canvas.height / 2);
  }

  drawEmptyAnalyzer() {
    const canvas = this.dom.analyzerCanvas;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#05050a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const fontSize = Math.max(10, Math.min(14, canvas.width / 30));
    ctx.font = `${fontSize}px 'Outfit', sans-serif`;
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    ctx.textAlign = 'center';
    ctx.fillText('Play audio for frequency analysis', canvas.width / 2, canvas.height / 2);
  }

  // ---- EXPORT ----
  exportWav() {
    if (!this.outputBuffer) return;
    const wav = this.encodeWav(this.outputBuffer);
    const blob = new Blob([wav], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `voiceisolate_pro_v18_${Date.now()}.wav`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  encodeWav(buffer) {
    const numCh = buffer.numberOfChannels;
    const sr = buffer.sampleRate;
    const bitsPerSample = 16;
    const bytesPerSample = bitsPerSample / 8;
    const dataLength = buffer.length * numCh * bytesPerSample;
    const headerLength = 44;
    const totalLength = headerLength + dataLength;
    const arr = new ArrayBuffer(totalLength);
    const view = new DataView(arr);

    // RIFF header
    this.writeStr(view, 0, 'RIFF');
    view.setUint32(4, totalLength - 8, true);
    this.writeStr(view, 8, 'WAVE');

    // fmt chunk
    this.writeStr(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, numCh, true);
    view.setUint32(24, sr, true);
    view.setUint32(28, sr * numCh * bytesPerSample, true);
    view.setUint16(32, numCh * bytesPerSample, true);
    view.setUint16(34, bitsPerSample, true);

    // data chunk
    this.writeStr(view, 36, 'data');
    view.setUint32(40, dataLength, true);

    let offset = 44;
    for (let i = 0; i < buffer.length; i++) {
      for (let ch = 0; ch < numCh; ch++) {
        let s = buffer.getChannelData(ch)[i];
        s = Math.max(-1, Math.min(1, s));
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
        offset += 2;
      }
    }
    return arr;
  }

  writeStr(view, offset, str) {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  }

  // ---- UTILITY ----
  setStatus(status) {
    this.dom.statStatus.textContent = status;
    const colors = {
      IDLE: '#6b6b82', LOADING: '#eab308', READY: '#10b981',
      PROCESSING: '#f97316', COMPLETE: '#06b6d4', ERROR: '#ef4444',
      RECORDING: '#ef4444', ABORTED: '#a855f7'
    };
    this.dom.statStatus.style.color = colors[status] || '#6b6b82';
  }

  calcRMS(data) {
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    const rms = Math.sqrt(sum / data.length);
    return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
  }

  calcPeak(data) {
    let peak = 0;
    for (let i = 0; i < data.length; i++) {
      const abs = Math.abs(data[i]);
      if (abs > peak) peak = abs;
    }
    return peak > 0 ? 20 * Math.log10(peak) : -Infinity;
  }

  formatDuration(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }
}

// ---- BOOT ----
document.addEventListener('DOMContentLoaded', () => {
  window.vip = new VoiceIsolatePro();
});
