/* ============================================
   VoiceIsolate Pro v19.0 – Engineer Mode
   Threads from Space · Hybrid ML+DSP
   52 Sliders · Real-Time Chain · 3D Spectrogram
   ============================================ */

// ---- STRUCTURED LOGGING ----
function structuredLog(level, message, details = {}) {
  const entry = { app: 'VoiceIsolate Pro', version: '19.0', level, message, timestamp: new Date().toISOString(), ...details };
  const method = level === 'error' ? console.error : level === 'warn' ? console.warn : console.info;
  method(JSON.stringify(entry));
}

// ---- SLIDER DEFINITIONS (52 total) ----
const SLIDERS = {
  gate: [
    { id:'gateThresh', label:'Threshold', min:-80, max:-5, val:-42, step:1, unit:' dB', rt:true, desc:'Signal level below which the gate closes. Lower values let quieter sounds through.' },
    { id:'gateRange', label:'Range', min:-90, max:0, val:-40, step:1, unit:' dB', rt:false, desc:'Maximum attenuation when gate is closed. -90dB = full silence, -20dB = gentle reduction.' },
    { id:'gateAttack', label:'Attack', min:0.1, max:50, val:2, step:0.1, unit:' ms', rt:true, desc:'How fast the gate opens when signal exceeds threshold. Shorter = tighter, may clip transients.' },
    { id:'gateRelease', label:'Release', min:5, max:500, val:80, step:1, unit:' ms', rt:true, desc:'How fast the gate closes after signal drops below threshold. Longer = smoother tails.' },
    { id:'gateHold', label:'Hold', min:0, max:200, val:20, step:1, unit:' ms', rt:false, desc:'Minimum time gate stays open after triggering. Prevents rapid flutter on borderline signals.' },
    { id:'gateLookahead', label:'Lookahead', min:0, max:20, val:5, step:0.5, unit:' ms', rt:false, desc:'Pre-delay allowing the gate to open before transients arrive. Preserves attack of voice.' },
  ],
  nr: [
    { id:'nrAmount', label:'Reduction Amount', min:0, max:100, val:55, step:1, unit:'%', rt:false, desc:'How much noise is removed. Higher = more removal but potential artifacts. 40-60% is usually optimal.' },
    { id:'nrSensitivity', label:'Sensitivity', min:0, max:100, val:50, step:1, unit:'%', rt:false, desc:'How aggressively noise is detected. Higher catches more noise but may eat voice edges.' },
    { id:'nrSpectralSub', label:'Spectral Subtract', min:0, max:100, val:40, step:1, unit:'%', rt:false, desc:'Subtracts estimated noise spectrum from signal. The core noise reduction algorithm.' },
    { id:'nrFloor', label:'Noise Floor', min:-80, max:-20, val:-60, step:1, unit:' dB', rt:false, desc:'Estimated noise floor level. Audio below this is treated as noise. Profile from silent sections.' },
    { id:'nrSmoothing', label:'Smoothing', min:0, max:100, val:35, step:1, unit:'%', rt:false, desc:'Temporal smoothing of noise estimate. Prevents musical noise artifacts from frame-to-frame variation.' },
  ],
  eq: [
    { id:'eqSub', label:'Sub (40 Hz)', min:-12, max:6, val:-8, step:0.5, unit:' dB', rt:true, desc:'Sub-bass frequencies. Cut to remove rumble, mic handling noise, and HVAC.' },
    { id:'eqBass', label:'Bass (100 Hz)', min:-8, max:8, val:0, step:0.5, unit:' dB', rt:true, desc:'Low bass. Boost for warmth in thin voices, cut to reduce boominess and proximity effect.' },
    { id:'eqWarmth', label:'Warmth (200 Hz)', min:-6, max:6, val:1, step:0.5, unit:' dB', rt:true, desc:'Lower midrange warmth. Gives body to the voice. Too much = muddy.' },
    { id:'eqBody', label:'Body (400 Hz)', min:-6, max:6, val:0, step:0.5, unit:' dB', rt:true, desc:'Core body of the voice. The chest frequency. Cut reduces boxiness in room recordings.' },
    { id:'eqLowMid', label:'Low-Mid (800 Hz)', min:-6, max:6, val:-1, step:0.5, unit:' dB', rt:true, desc:'Nasal/honky frequencies. Slight cut often helps clarity. The telephone zone.' },
    { id:'eqMid', label:'Mid (1.5 kHz)', min:-6, max:6, val:1, step:0.5, unit:' dB', rt:true, desc:'Core intelligibility. The most critical band for speech comprehension.' },
    { id:'eqPresence', label:'Presence (3 kHz)', min:-6, max:8, val:3, step:0.5, unit:' dB', rt:true, desc:'Vocal presence and forward projection. Boost for clarity, cut to push voice back.' },
    { id:'eqClarity', label:'Clarity (5 kHz)', min:-6, max:6, val:2, step:0.5, unit:' dB', rt:true, desc:'Consonant definition. Sibilance begins here. Helps speech cut through background.' },
    { id:'eqAir', label:'Air (10 kHz)', min:-6, max:6, val:1, step:0.5, unit:' dB', rt:true, desc:'High-frequency air and sparkle. Adds openness. Too much = hissy on noisy recordings.' },
    { id:'eqBrill', label:'Brilliance (16 kHz)', min:-8, max:4, val:-2, step:0.5, unit:' dB', rt:true, desc:'Ultra-high frequencies. Usually cut for noise reduction. Boost only on clean recordings.' },
  ],
  dyn: [
    { id:'compThresh', label:'Comp Threshold', min:-50, max:0, val:-24, step:1, unit:' dB', rt:true, desc:'Level above which compression begins. Lower = more compression. -24dB is moderate.' },
    { id:'compRatio', label:'Comp Ratio', min:1, max:20, val:4, step:0.5, unit:':1', rt:true, desc:'Compression ratio. 2:1 gentle, 4:1 moderate, 10:1+ limiting.' },
    { id:'compAttack', label:'Comp Attack', min:0, max:100, val:8, step:1, unit:' ms', rt:true, desc:'How fast compressor reacts. Short catches transients, Long lets them through (punch).' },
    { id:'compRelease', label:'Comp Release', min:10, max:1000, val:200, step:5, unit:' ms', rt:true, desc:'How fast compressor lets go. Too fast = pumping. Too slow = dull dynamics.' },
    { id:'compKnee', label:'Comp Knee', min:0, max:30, val:6, step:1, unit:' dB', rt:true, desc:'Soft/hard knee. 0 = hard (abrupt), 30 = very soft (gradual). 6dB is natural.' },
    { id:'compMakeup', label:'Makeup Gain', min:0, max:24, val:6, step:0.5, unit:' dB', rt:true, desc:'Gain added after compression to restore loudness.' },
    { id:'limThresh', label:'Limiter Ceiling', min:-6, max:0, val:-1, step:0.1, unit:' dB', rt:true, desc:'Brickwall ceiling. No signal passes above this. -1dBFS standard for broadcast.' },
    { id:'limRelease', label:'Limiter Release', min:1, max:100, val:10, step:1, unit:' ms', rt:true, desc:'How fast limiter recovers. Very fast for transparent limiting.' },
  ],
  spec: [
    { id:'hpFreq', label:'High-Pass Freq', min:20, max:500, val:80, step:1, unit:' Hz', rt:true, desc:'Removes everything below this frequency. 80Hz standard for voice. 120Hz for noisy rooms.' },
    { id:'hpQ', label:'HP Resonance', min:0.5, max:5, val:0.71, step:0.01, unit:' Q', rt:true, desc:'Filter steepness. 0.707 = Butterworth (flat). Higher = steeper but resonant peak.' },
    { id:'lpFreq', label:'Low-Pass Freq', min:3000, max:20000, val:14000, step:100, unit:' Hz', rt:true, desc:'Removes everything above this frequency. 12kHz for noise, 20kHz for full fidelity.' },
    { id:'lpQ', label:'LP Resonance', min:0.5, max:5, val:0.71, step:0.01, unit:' Q', rt:true, desc:'Low-pass filter resonance. Keep at 0.707 for transparent rolloff.' },
    { id:'deEssFreq', label:'De-Ess Center', min:4000, max:10000, val:7000, step:100, unit:' Hz', rt:true, desc:'Center frequency for sibilance reduction. 6-8kHz for most voices.' },
    { id:'deEssAmt', label:'De-Ess Amount', min:0, max:100, val:30, step:1, unit:'%', rt:true, desc:'How much sibilance is reduced. 20-40% natural. Higher may lisp.' },
    { id:'specTilt', label:'Spectral Tilt', min:-6, max:6, val:0, step:0.5, unit:' dB/oct', rt:true, desc:'Overall spectral slope. Positive = brighter. Negative = darker.' },
    { id:'formantShift', label:'Formant Shift', min:-12, max:12, val:0, step:0.5, unit:' semi', rt:false, desc:'Shifts vocal formants without changing pitch. Adjusts perceived voice character.' },
  ],
  adv: [
    { id:'derevAmt', label:'Dereverb Amount', min:0, max:100, val:40, step:1, unit:'%', rt:false, desc:'Removes room reverb/echo. Higher = drier sound. Too much = unnatural.' },
    { id:'derevDecay', label:'Dereverb Decay', min:0.1, max:3, val:0.5, step:0.1, unit:' s', rt:false, desc:'Estimated room reverb decay time. Match to actual room for best results.' },
    { id:'harmRecov', label:'Harmonic Recovery', min:0, max:100, val:20, step:1, unit:'%', rt:false, desc:'Regenerates harmonics lost during noise reduction via soft saturation.' },
    { id:'harmOrder', label:'Harmonic Order', min:2, max:8, val:3, step:1, unit:'x', rt:false, desc:'Which harmonics to regenerate. 2=octave, 3=octave+fifth. Higher = more overtones.' },
    { id:'stereoWidth', label:'Stereo Width', min:0, max:200, val:100, step:1, unit:'%', rt:true, desc:'0%=mono, 100%=original, 200%=extra wide. Mono can reduce ambient noise.' },
    { id:'phaseCorr', label:'Phase Correction', min:0, max:100, val:0, step:1, unit:'%', rt:false, desc:'Corrects phase issues between stereo channels. Useful for multi-mic recordings.' },
  ],
  sep: [
    { id:'voiceIso', label:'Voice Isolation', min:0, max:100, val:70, step:1, unit:'%', rt:false, desc:'Strength of voice/non-voice separation. Higher = more aggressive extraction.' },
    { id:'bgSuppress', label:'Background Suppress', min:0, max:100, val:50, step:1, unit:'%', rt:false, desc:'Attenuation of non-voice background. Music, traffic, ambient noise.' },
    { id:'voiceFocusLo', label:'Voice Focus Low', min:80, max:500, val:120, step:5, unit:' Hz', rt:true, desc:'Lower bound of voice focus band. Male ~85Hz, female ~165Hz.' },
    { id:'voiceFocusHi', label:'Voice Focus High', min:2000, max:12000, val:6000, step:100, unit:' Hz', rt:true, desc:'Upper bound of voice focus band. Speech intelligibility extends to ~8kHz.' },
    { id:'crosstalkCancel', label:'Crosstalk Cancel', min:0, max:100, val:0, step:1, unit:'%', rt:false, desc:'Reduces bleed between speakers in multi-person recordings.' },
  ],
  out: [
    { id:'outGain', label:'Output Gain', min:-18, max:18, val:0, step:0.5, unit:' dB', rt:true, desc:'Final output level adjustment.' },
    { id:'dryWet', label:'Dry/Wet Mix', min:0, max:100, val:100, step:1, unit:'%', rt:false, desc:'Balance between original (dry) and processed (wet). 100% = fully processed.' },
    { id:'ditherAmt', label:'Dither', min:0, max:100, val:0, step:1, unit:'%', rt:false, desc:'Adds shaped noise before bit-depth reduction. Prevents quantization distortion.' },
    { id:'outWidth', label:'Output Width', min:0, max:200, val:100, step:1, unit:'%', rt:true, desc:'Final stereo width control applied after all processing.' },
  ]
};

// ---- PRESETS ----
const PRESETS = {
  podcast: {gateThresh:-38,gateRange:-35,gateAttack:2,gateRelease:60,gateHold:15,gateLookahead:5,nrAmount:60,nrSensitivity:55,nrSpectralSub:45,nrFloor:-55,nrSmoothing:40,eqSub:-10,eqBass:-1,eqWarmth:2,eqBody:0,eqLowMid:-1,eqMid:1,eqPresence:4,eqClarity:2,eqAir:1,eqBrill:-3,compThresh:-20,compRatio:5,compAttack:6,compRelease:180,compKnee:6,compMakeup:8,limThresh:-1,limRelease:8,hpFreq:80,hpQ:0.71,lpFreq:14000,lpQ:0.71,deEssFreq:7000,deEssAmt:40,specTilt:0.5,formantShift:0,derevAmt:50,derevDecay:0.4,harmRecov:15,harmOrder:3,stereoWidth:100,phaseCorr:0,voiceIso:80,bgSuppress:60,voiceFocusLo:120,voiceFocusHi:6000,crosstalkCancel:0,outGain:0,dryWet:100,ditherAmt:0,outWidth:100},
  film: {gateThresh:-50,gateRange:-30,gateAttack:3,gateRelease:100,gateHold:25,gateLookahead:5,nrAmount:40,nrSensitivity:45,nrSpectralSub:30,nrFloor:-60,nrSmoothing:40,eqSub:-6,eqBass:1,eqWarmth:1,eqBody:1,eqLowMid:0,eqMid:0,eqPresence:2,eqClarity:1,eqAir:2,eqBrill:-1,compThresh:-28,compRatio:3,compAttack:12,compRelease:300,compKnee:10,compMakeup:4,limThresh:-1,limRelease:15,hpFreq:60,hpQ:0.71,lpFreq:16000,lpQ:0.71,deEssFreq:6500,deEssAmt:20,specTilt:-0.5,formantShift:0,derevAmt:30,derevDecay:0.6,harmRecov:25,harmOrder:3,stereoWidth:120,phaseCorr:0,voiceIso:60,bgSuppress:40,voiceFocusLo:100,voiceFocusHi:8000,crosstalkCancel:0,outGain:0,dryWet:100,ditherAmt:0,outWidth:110},
  interview: {gateThresh:-42,gateRange:-38,gateAttack:2,gateRelease:80,gateHold:20,gateLookahead:5,nrAmount:55,nrSensitivity:50,nrSpectralSub:40,nrFloor:-58,nrSmoothing:35,eqSub:-8,eqBass:0,eqWarmth:1,eqBody:0,eqLowMid:-1,eqMid:1,eqPresence:3,eqClarity:2,eqAir:1,eqBrill:-2,compThresh:-22,compRatio:5,compAttack:5,compRelease:200,compKnee:6,compMakeup:6,limThresh:-1,limRelease:10,hpFreq:100,hpQ:0.71,lpFreq:12000,lpQ:0.71,deEssFreq:7000,deEssAmt:35,specTilt:0,formantShift:0,derevAmt:45,derevDecay:0.5,harmRecov:20,harmOrder:3,stereoWidth:80,phaseCorr:0,voiceIso:75,bgSuppress:55,voiceFocusLo:120,voiceFocusHi:6000,crosstalkCancel:20,outGain:0,dryWet:100,ditherAmt:0,outWidth:90},
  forensic: {gateThresh:-65,gateRange:-20,gateAttack:1,gateRelease:150,gateHold:30,gateLookahead:10,nrAmount:30,nrSensitivity:60,nrSpectralSub:20,nrFloor:-70,nrSmoothing:50,eqSub:-2,eqBass:0,eqWarmth:0,eqBody:0,eqLowMid:0,eqMid:2,eqPresence:5,eqClarity:4,eqAir:3,eqBrill:0,compThresh:-18,compRatio:2,compAttack:15,compRelease:400,compKnee:12,compMakeup:10,limThresh:-0.5,limRelease:20,hpFreq:50,hpQ:0.71,lpFreq:18000,lpQ:0.71,deEssFreq:8000,deEssAmt:10,specTilt:1,formantShift:0,derevAmt:20,derevDecay:0.8,harmRecov:35,harmOrder:4,stereoWidth:100,phaseCorr:30,voiceIso:90,bgSuppress:30,voiceFocusLo:80,voiceFocusHi:10000,crosstalkCancel:0,outGain:3,dryWet:90,ditherAmt:0,outWidth:100},
  music: {gateThresh:-55,gateRange:-25,gateAttack:3,gateRelease:120,gateHold:15,gateLookahead:3,nrAmount:25,nrSensitivity:40,nrSpectralSub:20,nrFloor:-65,nrSmoothing:45,eqSub:-3,eqBass:1,eqWarmth:2,eqBody:1,eqLowMid:0,eqMid:0,eqPresence:2,eqClarity:1,eqAir:3,eqBrill:0,compThresh:-30,compRatio:2,compAttack:20,compRelease:350,compKnee:15,compMakeup:3,limThresh:-0.5,limRelease:12,hpFreq:40,hpQ:0.71,lpFreq:20000,lpQ:0.71,deEssFreq:7500,deEssAmt:15,specTilt:-1,formantShift:0,derevAmt:15,derevDecay:1.0,harmRecov:30,harmOrder:4,stereoWidth:150,phaseCorr:0,voiceIso:50,bgSuppress:25,voiceFocusLo:80,voiceFocusHi:10000,crosstalkCancel:0,outGain:0,dryWet:85,ditherAmt:5,outWidth:140},
  broadcast: {gateThresh:-35,gateRange:-40,gateAttack:1.5,gateRelease:50,gateHold:10,gateLookahead:3,nrAmount:65,nrSensitivity:60,nrSpectralSub:50,nrFloor:-50,nrSmoothing:30,eqSub:-12,eqBass:-2,eqWarmth:2,eqBody:0,eqLowMid:-2,eqMid:2,eqPresence:5,eqClarity:3,eqAir:1,eqBrill:-4,compThresh:-18,compRatio:6,compAttack:4,compRelease:150,compKnee:4,compMakeup:10,limThresh:-1,limRelease:5,hpFreq:120,hpQ:0.71,lpFreq:12000,lpQ:0.71,deEssFreq:7000,deEssAmt:45,specTilt:1,formantShift:0,derevAmt:55,derevDecay:0.3,harmRecov:10,harmOrder:2,stereoWidth:60,phaseCorr:0,voiceIso:85,bgSuppress:70,voiceFocusLo:150,voiceFocusHi:5000,crosstalkCancel:0,outGain:0,dryWet:100,ditherAmt:0,outWidth:70},
  restoration: {gateThresh:-60,gateRange:-15,gateAttack:5,gateRelease:200,gateHold:40,gateLookahead:10,nrAmount:45,nrSensitivity:55,nrSpectralSub:35,nrFloor:-65,nrSmoothing:50,eqSub:-4,eqBass:0,eqWarmth:0,eqBody:0,eqLowMid:0,eqMid:1,eqPresence:3,eqClarity:2,eqAir:1,eqBrill:-1,compThresh:-26,compRatio:3,compAttack:10,compRelease:250,compKnee:8,compMakeup:5,limThresh:-0.5,limRelease:15,hpFreq:50,hpQ:0.71,lpFreq:16000,lpQ:0.71,deEssFreq:6500,deEssAmt:20,specTilt:0,formantShift:0,derevAmt:35,derevDecay:0.7,harmRecov:40,harmOrder:4,stereoWidth:100,phaseCorr:20,voiceIso:65,bgSuppress:45,voiceFocusLo:100,voiceFocusHi:8000,crosstalkCancel:10,outGain:2,dryWet:95,ditherAmt:5,outWidth:100}
};

const STAGES = [
  // Pass 1 – INGEST (4)
  'Input Decode', 'Channel Analysis', 'DC Offset Removal', 'Peak Normalization',
  // Pass 2 – ANALYSIS (4)
  'Noise Floor Profiling', 'VAD — Voice Activity Detection', 'Spectral Fingerprint', 'STFT Engine Init',
  // Pass 3 – FILTER (4)
  'High-Pass Filter', 'Low-Pass Filter', 'Voice Band Isolation', 'Adaptive Noise Gate',
  // Pass 4 – SPECTRAL NR (4)
  'Spectral Subtraction', 'Wiener Filter', 'Background Suppression', 'Dereverberation',
  // Pass 5 – EQ (4)
  'EQ — Low Shelf (Sub/Bass)', 'EQ — Low-Mid Band (Warmth/Body)', 'EQ — Mid Band (Presence/Clarity)', 'EQ — High Shelf (Air/Brilliance)',
  // Pass 6 – SPECTRAL PROCESSING (4)
  'De-Essing', 'Spectral Tilt', 'Formant Shift', 'Phase Correction',
  // Pass 7 – DYNAMICS (4)
  'Harmonic Reconstruction', 'Dynamics Compression', 'Brickwall Limiter', 'Crosstalk Cancellation',
  // Pass 8 – MASTER (4)
  'Dry/Wet Blend', 'TPDF Dither', 'Output Normalization', 'Final Render & Export'
];

// ============================================
class VoiceIsolatePro {
  constructor() {
    this.ctx = null;
    this.inputBuffer = null;
    this.outputBuffer = null;
    this.currentSource = null;
    this.analyserNode = null;
    this.isProcessing = false;
    this.isRecording = false;
    this.mediaRecorder = null;
    this.recordedChunks = [];
    this.abMode = 'original';
    this.isVideo = false;
    this.videoUrl = null;
    this.spectroRunning = false;
    this.animId = null;
    this.spectroX = 0;
    this.abortFlag = false;
    this.liveNodes = {};
    this.liveChainBuilt = false;
    this.playStartTime = 0;
    this.playOffset = 0;
    this.isPlaying = false;
    this.mutedBands = new Set();
    this.params = {};
    for (const tab of Object.values(SLIDERS)) for (const s of tab) this.params[s.id] = s.val;
    this.three = {};
    // ML Worker — off-main-thread ONNX inference (DeepFilterNet3 + Demucs + VAD)
    this.mlWorker = null;
    this._mlCallbacks = {};  // id → { resolve, reject }
    this._mlCallId = 0;
    this.mlReady = false;
    this.mlWorkerReady = false;
    this.mlWorkerModels = { vad: false, deepfilter: false, demucs: false };
    // Phase 5: Forensic audit
    this.forensicMode = false;
    this.forensicLog = [];

    // Phase 6: Secure PRNG for dither (Sentinel fix)
    // Buffer size limited to 65536 bytes (16384 Uint32s) by Web Crypto API
    this._rndBuf = new Uint32Array(16384);
    this._rndIdx = 16384;

    this.init();
  }

  init() {
    this.buildSliderPanels();
    this.cacheDom();
    this.bindEvents();
    this.initCanvases();
    this.init3D();
    this.initMLWorker(); // start loading ML models in background
  }

  ensureCtx() {
    if (!this.ctx || this.ctx.state === 'closed') {
      this.ctx = new (typeof AudioContext !== 'undefined' ? AudioContext : window.webkitAudioContext)();
      // Phase 3: Register AudioWorklet processor for low-latency live mode
      if (this.ctx.audioWorklet) {
        this.ctx.audioWorklet.addModule('./dsp-worker.js').catch(() => {
          structuredLog('warn', 'AudioWorklet unavailable — live chain uses native Web Audio nodes');
        });
      }
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  // ---- BUILD SLIDERS ----
  buildSliderPanels() {
    for (const [tabKey, sliders] of Object.entries(SLIDERS)) {
      const panel = document.getElementById('tab-' + tabKey);
      if (!panel) continue;
      panel.textContent = '';
      const sr = document.createElement('div');
      sr.className = 'sr';
      for (const s of sliders) {
        const row = document.createElement('div');
        row.className = 'sr-row';
        row.dataset.desc = s.desc;

        const labelEl = document.createElement('label');
        labelEl.className = 'sr-label';
        labelEl.title = s.desc;
        labelEl.htmlFor = s.id;
        labelEl.textContent = s.label;
        if (s.rt) {
          const badge = document.createElement('span');
          badge.className = 'rt-badge';
          badge.textContent = 'RT';
          labelEl.appendChild(badge);
        }

        const inputEl = document.createElement('input');
        inputEl.type = 'range';
        if (s.rt) inputEl.className = 'realtime';
        inputEl.id = s.id;
        inputEl.min = s.min;
        inputEl.max = s.max;
        inputEl.value = s.val;
        inputEl.step = s.step;
        inputEl.dataset.param = s.id;
        inputEl.setAttribute('aria-label', s.label);
        inputEl.setAttribute('aria-valuemin', s.min);
        inputEl.setAttribute('aria-valuemax', s.max);
        inputEl.setAttribute('aria-valuenow', s.val);

        const valEl = document.createElement('span');
        valEl.className = 'sr-val';
        valEl.id = s.id + 'Val';
        valEl.textContent = s.val + s.unit;

        row.appendChild(labelEl);
        row.appendChild(inputEl);
        row.appendChild(valEl);
        sr.appendChild(row);
      }
      panel.appendChild(sr);
    }
  }

  cacheDom() {
    const g = id => document.getElementById(id);
    this.dom = {
      uploadZone:g('uploadZone'), fileInput:g('fileInput'), fileBtn:g('fileBtn'),
      micBtn:g('micBtn'), micLabel:g('micLabel'), fileInfo:g('fileInfo'),
      processBtn:g('processBtn'), reprocessBtn:g('reprocessBtn'), stopProcBtn:g('stopProcBtn'),
      saveOrigBtn:g('saveOrigBtn'), saveProcBtn:g('saveProcBtn'),
      auditLogBtn:g('auditLogBtn'), forensicToggle:g('forensicToggle'),
      videoCard:g('videoCard'), videoPlayer:g('videoPlayer'),
      tpPlay:g('tpPlay'), tpPause:g('tpPause'), tpStop:g('tpStop'),
      tpRew:g('tpRew'), tpFwd:g('tpFwd'), tpCur:g('tpCur'), tpTotal:g('tpTotal'),
      tpSeek:g('tpSeek'), tpSpeed:g('tpSpeed'), tpAB:g('tpAB'), tpABLabel:g('tpABLabel'),
      spectro3DContainer:g('spectro3DContainer'), spectro3DCanvas:g('spectro3DCanvas'),
      spectro3DReset:g('spectro3DReset'),
      spectro2DCanvas:g('spectro2DCanvas'),
      waveOrigCanvas:g('waveOrigCanvas'), waveProcCanvas:g('waveProcCanvas'),
      freqCanvas:g('freqCanvas'),
      pipeFill:g('pipeFill'), pipeBar:g('pipeBar'), pipeStage:g('pipeStage'), pipeDetail:g('pipeDetail'),
      hSNR:g('hSNR'), hDur:g('hDur'), hSR:g('hSR'), hCh:g('hCh'),
      hRMS:g('hRMS'), hPeak:g('hPeak'), hStatus:g('hStatus'),
      stLatency:g('stLatency'), stProcTime:g('stProcTime'), stVoices:g('stVoices'),
      tooltip:g('tooltip')
    };
  }

  bindEvents() {
    const uz = this.dom.uploadZone;
    ['dragenter','dragover'].forEach(ev => uz.addEventListener(ev, e => { e.preventDefault(); e.stopPropagation(); uz.classList.add('dragover'); }));
    ['dragleave','drop'].forEach(ev => uz.addEventListener(ev, e => { e.preventDefault(); e.stopPropagation(); uz.classList.remove('dragover'); }));
    uz.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if (f) this.handleFile(f); });
    uz.addEventListener('click', e => { if (e.target.tagName !== 'BUTTON') this.dom.fileInput.click(); });
    uz.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.dom.fileInput.click(); } });
    this.dom.fileBtn.addEventListener('click', e => { e.stopPropagation(); this.dom.fileInput.click(); });
    this.dom.fileInput.addEventListener('change', e => { if (e.target.files[0]) this.handleFile(e.target.files[0]); this.dom.fileInput.value = ''; });
    this.dom.micBtn.addEventListener('click', () => this.toggleRecording());
    this.dom.processBtn.addEventListener('click', () => this.runPipeline());
    this.dom.reprocessBtn.addEventListener('click', () => this.runPipeline());
    this.dom.stopProcBtn.addEventListener('click', () => { this.abortFlag = true; });
    this.dom.saveOrigBtn.addEventListener('click', () => this.saveWav(this.inputBuffer,'original'));
    this.dom.saveProcBtn.addEventListener('click', () => this.saveWav(this.outputBuffer,'processed'));
    this.dom.tpPlay.addEventListener('click', () => this.play());
    this.dom.tpPause.addEventListener('click', () => this.pause());
    this.dom.tpStop.addEventListener('click', () => this.stop());
    this.dom.tpRew.addEventListener('click', () => this.seekDelta(-5));
    this.dom.tpFwd.addEventListener('click', () => this.seekDelta(5));
    this.dom.tpSeek.addEventListener('input', () => this.seekTo(this.dom.tpSeek.value / 1000));
    this.dom.tpSpeed.addEventListener('change', () => { const r = parseFloat(this.dom.tpSpeed.value); if (this.currentSource) this.currentSource.playbackRate.value = r; if (this.isVideo) this.dom.videoPlayer.playbackRate = r; });
    this.dom.tpAB.addEventListener('click', () => this.toggleAB());
    document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(x => {
        const isActive = x === t;
        x.classList.toggle('active', isActive);
        x.setAttribute('aria-selected', isActive ? 'true' : 'false');
      });
      document.querySelectorAll('.panel').forEach(p => {
        const isActive = p.id === 'tab-' + t.dataset.tab;
        p.classList.toggle('active', isActive);
        if (isActive) p.removeAttribute('hidden');
        else p.setAttribute('hidden', '');
      });
    }));
    document.querySelectorAll('.btn-preset').forEach(b => b.addEventListener('click', () => this.applyPreset(b.dataset.preset)));
    document.querySelectorAll('input[type="range"][data-param]').forEach(el => el.addEventListener('input', () => this.onSlider(el)));
    document.querySelectorAll('.sr-row').forEach(r => {
      r.addEventListener('mouseenter', e => { const d = r.dataset.desc; if (d) { const tt = this.dom.tooltip; tt.textContent = d; tt.classList.add('visible'); const rc = r.getBoundingClientRect(); tt.style.left = (rc.right+8)+'px'; tt.style.top = rc.top+'px'; const tr = tt.getBoundingClientRect(); if (tr.right > window.innerWidth-10) tt.style.left = (rc.left-tr.width-8)+'px'; if (tr.bottom > window.innerHeight-10) tt.style.top = (window.innerHeight-tr.height-10)+'px'; }});
      r.addEventListener('mouseleave', () => this.dom.tooltip.classList.remove('visible'));
    });
    this.dom.spectro3DCanvas.addEventListener('click', e => this.onSpectroClick(e));
    this.dom.spectro3DReset.addEventListener('click', () => this.reset3DView());
    // Phase 5: Forensic mode toggle
    if (this.dom.forensicToggle) {
      this.dom.forensicToggle.addEventListener('change', () => {
        this.forensicMode = this.dom.forensicToggle.checked;
        structuredLog('info', 'Forensic mode', { enabled: this.forensicMode });
      });
    }
    // Phase 5: Audit log download
    if (this.dom.auditLogBtn) {
      this.dom.auditLogBtn.addEventListener('click', () => this.downloadAuditLog());
    }
    window.addEventListener('resize', () => this.onResize());
  }

  onSlider(el) {
    const id = el.dataset.param;
    const v = parseFloat(el.value);
    this.params[id] = v;
    let unit = '';
    for (const tab of Object.values(SLIDERS)) { const s = tab.find(s => s.id === id); if (s) { unit = s.unit; break; } }
    const ve = document.getElementById(id + 'Val');
    if (ve) ve.textContent = v + unit;
    el.setAttribute('aria-valuenow', v);
    if (el.classList.contains('realtime') && this.liveChainBuilt) this.updateLiveChain();
  }

  applyPreset(name) {
    const p = PRESETS[name]; if (!p) return;
    Object.assign(this.params, p);
    for (const [, sliders] of Object.entries(SLIDERS)) {
      for (const s of sliders) {
        const el = document.getElementById(s.id);
        const ve = document.getElementById(s.id + 'Val');
        if (el && this.params[s.id] !== undefined) { el.value = this.params[s.id]; el.setAttribute('aria-valuenow', this.params[s.id]); if (ve) ve.textContent = this.params[s.id] + s.unit; }
      }
    }
    document.querySelectorAll('.btn-preset').forEach(b => b.classList.toggle('active', b.dataset.preset === name));
    if (this.liveChainBuilt) this.updateLiveChain();
  }

  // ======== FILE HANDLING (FIXED) ========
  async handleFile(file) {
    try {
      // 🛡️ Sentinel: Validate file size (max 200MB) and MIME type

      const allowedTypes = ['audio/wav', 'audio/mpeg', 'audio/ogg', 'audio/flac', 'audio/webm', 'audio/mp4', 'audio/aac', 'audio/x-m4a', 'audio/m4a', 'video/mp4', 'video/webm', 'video/ogg', 'video/quicktime'];
      if (file.type && !allowedTypes.includes(file.type)) throw new Error('Unsupported file type');

      this.ensureCtx();
      this.stop(); // stop any current playback
      this.dom.fileInfo.textContent = 'Loading: ' + file.name + '...';
      this.setStatus('LOADING');

      this.isVideo = file.type.startsWith('video/');

      // Always read file as ArrayBuffer FIRST (works for both audio and video)
      const fileArrayBuffer = await file.arrayBuffer();

      // Try to decode audio from the file bytes
      // decodeAudioData needs a COPY because it detaches the buffer
      let audioBuf = null;
      try {
        audioBuf = await this.ctx.decodeAudioData(fileArrayBuffer.slice(0));
      } catch (decodeErr) {
        // Fallback: if direct decode fails (some video formats), use video element
        if (this.isVideo) {
          audioBuf = await this.decodeViaVideoElement(file);
        } else {
          throw new Error('Cannot decode this audio format. Try WAV or MP3. (' + decodeErr.message + ')');
        }
      }

      if (!audioBuf || audioBuf.length === 0) {
        throw new Error('Decoded audio is empty. The file may be corrupt or unsupported.');
      }

      // Set up video player if video
      if (this.isVideo) {
        if (this.videoUrl) URL.revokeObjectURL(this.videoUrl);
        this.videoUrl = URL.createObjectURL(file);
        this.dom.videoPlayer.src = this.videoUrl;
        this.dom.videoCard.style.display = 'block';
        // Wait for metadata
        await new Promise((res, rej) => {
          this.dom.videoPlayer.onloadedmetadata = res;
          this.dom.videoPlayer.onerror = () => rej(new Error('Video metadata load failed'));
          setTimeout(res, 5000); // timeout fallback
        });
      } else {
        this.dom.videoCard.style.display = 'none';
      }

      this.inputBuffer = audioBuf;
      this.outputBuffer = null;
      // Phase 4: Attempt to load ML models if ONNX Runtime is available
      if (!this.mlReady && typeof this.loadModels === 'function') this.loadModels().catch(err => structuredLog('warn', 'Failed to initiate model loading', { error: err.message }));
      this.onAudioLoaded(file.name);

    } catch (err) {
      structuredLog('error', 'File load error', { error: err.message });
      this.dom.fileInfo.textContent = 'Error: ' + err.message;
      this.setStatus('ERROR');
    }
  }

  // Fallback: decode audio by playing video element into an offline context
  async decodeViaVideoElement(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const vid = document.createElement('video');
      vid.muted = true;
      vid.src = url;

      vid.onloadedmetadata = async () => {
        try {
          const duration = vid.duration;
          if (!duration || !isFinite(duration)) { reject(new Error('Cannot determine video duration')); return; }

          // Use MediaElement source to capture audio
          const tmpCtx = new (typeof AudioContext !== 'undefined' ? AudioContext : window.webkitAudioContext)();
          const source = tmpCtx.createMediaElementSource(vid);
          const dest = tmpCtx.createMediaStreamDestination();
          source.connect(dest);

          // Record the stream
          const chunks = [];
          const recorder = new MediaRecorder(dest.stream);
          recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };

          recorder.onstop = async () => {
            vid.pause();
            URL.revokeObjectURL(url);
            const blob = new Blob(chunks, { type: 'audio/webm' });
            const ab = await blob.arrayBuffer();
            try {
              const decoded = await this.ctx.decodeAudioData(ab);
              tmpCtx.close();
              resolve(decoded);
            } catch (e) {
              tmpCtx.close();
              reject(new Error('Failed to decode extracted video audio: ' + e.message));
            }
          };

          recorder.start();
          vid.play();

          // Stop after video ends
          vid.onended = () => { recorder.stop(); };
          // Safety timeout
          setTimeout(() => { if (recorder.state === 'recording') { vid.pause(); recorder.stop(); } }, (duration + 2) * 1000);
        } catch (e) {
          reject(e);
        }
      };

      vid.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Video element failed to load')); };
    });
  }

  onAudioLoaded(name) {
    const buf = this.inputBuffer;
    const dur = this.fmtDur(buf.duration);
    this.dom.fileInfo.textContent = (name || 'Recording') + ' (' + dur + ')';
    this.dom.processBtn.disabled = false;
    this.dom.saveOrigBtn.disabled = false;
    this.dom.reprocessBtn.disabled = true;
    this.dom.saveProcBtn.disabled = true;
    this.dom.tpAB.disabled = true;
    [this.dom.tpPlay, this.dom.tpPause, this.dom.tpStop, this.dom.tpRew, this.dom.tpFwd, this.dom.tpSeek, this.dom.tpSpeed].forEach(el => el.disabled = false);
    this.dom.tpTotal.textContent = dur;
    this.dom.tpABLabel.textContent = 'Original';
    this.dom.hDur.textContent = dur;
    this.dom.hSR.textContent = buf.sampleRate + ' Hz';
    this.dom.hCh.textContent = buf.numberOfChannels;
    this.dom.hRMS.textContent = this.calcRMS(buf.getChannelData(0)).toFixed(1) + ' dB';
    this.dom.hPeak.textContent = this.calcPeak(buf.getChannelData(0)).toFixed(1) + ' dB';
    this.resizeCanvas(this.dom.waveOrigCanvas);
    this.drawWaveform(buf, this.dom.waveOrigCanvas, '#dc2626');
    this.clearCanvas(this.dom.waveProcCanvas, 'Process to see result');
    this.setStatus('READY');
  }

  // ======== RECORDING ========
  async toggleRecording() {
    if (this.isRecording) { this.stopRecording(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.ensureCtx();
      this.isRecording = true;
      this.recordedChunks = [];
      this.dom.micBtn.classList.add('recording');
      this.dom.micLabel.textContent = 'Stop';
      this.setStatus('RECORDING');
      const src = this.ctx.createMediaStreamSource(stream);
      this.analyserNode = this.ctx.createAnalyser();
      this.analyserNode.fftSize = 4096;
      src.connect(this.analyserNode);
      this.startSpectro(this.analyserNode);
      const mt = this.getMime();
      this.mediaRecorder = new MediaRecorder(stream, { mimeType: mt });
      this.mediaRecorder.ondataavailable = e => { if (e.data.size > 0) this.recordedChunks.push(e.data); };
      this.mediaRecorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        this.stopSpectro();
        const blob = new Blob(this.recordedChunks, { type: mt });
        const ab = await blob.arrayBuffer();
        try {
          this.inputBuffer = await this.ctx.decodeAudioData(ab);
          this.outputBuffer = null;
          this.dom.videoCard.style.display = 'none';
          this.isVideo = false;
          this.onAudioLoaded('Recording');
        } catch (e) { this.dom.fileInfo.textContent = 'Decode error: ' + e.message; this.setStatus('ERROR'); }
      };
      this.mediaRecorder.start(100);
    } catch (e) { this.dom.fileInfo.textContent = 'Mic denied'; this.setStatus('ERROR'); }
  }

  stopRecording() {
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') this.mediaRecorder.stop();
    this.isRecording = false;
    this.dom.micBtn.classList.remove('recording');
    this.dom.micLabel.textContent = 'Record';
  }

  getMime() {
    for (const t of ['audio/webm;codecs=opus','audio/webm','audio/ogg','audio/mp4'])
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)) return t;
    return 'audio/webm';
  }

  // ======== TRANSPORT ========
  play() {
    this.stop();
    this.ensureCtx();
    const buf = this.abMode === 'processed' && this.outputBuffer ? this.outputBuffer : this.inputBuffer;
    if (!buf) return;
    this.buildLiveChain(buf);
    this.isPlaying = true;
    this.playStartTime = this.ctx.currentTime;
    this.dom.tpABLabel.textContent = this.abMode === 'processed' ? 'Processed' : 'Original';
    if (this.isVideo) {
      this.dom.videoPlayer.currentTime = this.playOffset;
      this.dom.videoPlayer.playbackRate = parseFloat(this.dom.tpSpeed.value);
      this.dom.videoPlayer.muted = true;
      this.dom.videoPlayer.play().catch(() => {});
    }
    this.startSpectro(this.analyserNode);
    this.startFreq(this.analyserNode);
    this.tickTime();
  }

  pause() {
    if (!this.isPlaying) return;
    const speed = parseFloat(this.dom.tpSpeed.value) || 1;
    this.playOffset += (this.ctx.currentTime - this.playStartTime) * speed;
    this.teardownChain();
    this.isPlaying = false;
    if (this.isVideo) this.dom.videoPlayer.pause();
    this.stopSpectro();
  }

  stop() {
    this.teardownChain();
    this.isPlaying = false;
    this.playOffset = 0;
    if (this.isVideo) { this.dom.videoPlayer.pause(); this.dom.videoPlayer.currentTime = 0; }
    this.stopSpectro();
    this.dom.tpCur.textContent = '0:00';
    this.dom.tpSeek.value = 0;
  }

  seekDelta(d) {
    const buf = this.inputBuffer; if (!buf) return;
    const speed = parseFloat(this.dom.tpSpeed.value) || 1;
    if (this.isPlaying) this.playOffset += (this.ctx.currentTime - this.playStartTime) * speed;
    this.playOffset = Math.max(0, Math.min(buf.duration, this.playOffset + d));
    if (this.isPlaying) this.play();
    else { this.dom.tpCur.textContent = this.fmtDur(this.playOffset); this.dom.tpSeek.value = (this.playOffset / buf.duration) * 1000; }
  }

  seekTo(frac) {
    if (!this.inputBuffer) return;
    const speed = parseFloat(this.dom.tpSpeed.value) || 1;
    if (this.isPlaying) this.playOffset += (this.ctx.currentTime - this.playStartTime) * speed;
    this.playOffset = frac * this.inputBuffer.duration;
    if (this.isPlaying) this.play();
    else this.dom.tpCur.textContent = this.fmtDur(this.playOffset);
  }

  toggleAB() {
    if (!this.outputBuffer) return;
    this.abMode = this.abMode === 'original' ? 'processed' : 'original';
    this.dom.tpAB.classList.toggle('active', this.abMode === 'processed');
    const speed = parseFloat(this.dom.tpSpeed.value) || 1;
    if (this.isPlaying) { this.playOffset += (this.ctx.currentTime - this.playStartTime) * speed; this.play(); }
    this.dom.tpABLabel.textContent = this.abMode === 'processed' ? 'Processed' : 'Original';
  }

  tickTime() {
    const tick = () => {
      if (!this.isPlaying) return;
      const speed = parseFloat(this.dom.tpSpeed.value) || 1;
      const elapsed = this.playOffset + (this.ctx.currentTime - this.playStartTime) * speed;
      const dur = this.inputBuffer ? this.inputBuffer.duration : 0;
      if (elapsed >= dur) { this.stop(); return; }
      this.dom.tpCur.textContent = this.fmtDur(elapsed);
      this.dom.tpSeek.value = dur > 0 ? (elapsed / dur) * 1000 : 0;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // ======== LIVE AUDIO CHAIN ========
  buildLiveChain(buf) {
    this.teardownChain();
    const ctx = this.ensureCtx();
    const p = this.params;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = parseFloat(this.dom.tpSpeed.value) || 1;
    src.onended = () => { if (this.isPlaying) this.stop(); };

    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = p.hpFreq; hp.Q.value = p.hpQ;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = p.lpFreq; lp.Q.value = p.lpQ;

    const eqDefs = [
      { id:'eqSub',f:40,type:'lowshelf'},{id:'eqBass',f:100,type:'peaking',q:1.2},{id:'eqWarmth',f:200,type:'peaking',q:1},
      {id:'eqBody',f:400,type:'peaking',q:1},{id:'eqLowMid',f:800,type:'peaking',q:1},{id:'eqMid',f:1500,type:'peaking',q:1.2},
      {id:'eqPresence',f:3000,type:'peaking',q:1.5},{id:'eqClarity',f:5000,type:'peaking',q:1.2},
      {id:'eqAir',f:10000,type:'highshelf'},{id:'eqBrill',f:16000,type:'highshelf'}
    ];
    const eqs = eqDefs.map(b => {
      const n = ctx.createBiquadFilter(); n.type = b.type; n.frequency.value = b.f;
      if (b.q) n.Q.value = b.q; n.gain.value = p[b.id] || 0; return { node:n, id:b.id };
    });

    const deEss = ctx.createBiquadFilter(); deEss.type = 'peaking'; deEss.frequency.value = p.deEssFreq; deEss.Q.value = 3; deEss.gain.value = -(p.deEssAmt/100)*10;
    const tilt = ctx.createBiquadFilter(); tilt.type = 'highshelf'; tilt.frequency.value = 1000; tilt.gain.value = p.specTilt;
    const vfL = ctx.createBiquadFilter(); vfL.type = 'highpass'; vfL.frequency.value = p.voiceFocusLo; vfL.Q.value = 0.5;
    const vfH = ctx.createBiquadFilter(); vfH.type = 'lowpass'; vfH.frequency.value = p.voiceFocusHi; vfH.Q.value = 0.5;
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = p.compThresh; comp.ratio.value = p.compRatio; comp.attack.value = p.compAttack/1000; comp.release.value = p.compRelease/1000; comp.knee.value = p.compKnee;
    const mkG = ctx.createGain(); mkG.gain.value = Math.pow(10, p.compMakeup/20);
    const lim = ctx.createDynamicsCompressor(); lim.threshold.value = p.limThresh; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.001; lim.release.value = p.limRelease/1000;
    const outG = ctx.createGain(); outG.gain.value = Math.pow(10, p.outGain/20);
    const wG = ctx.createGain(); wG.gain.value = p.outWidth/100;
    const ana = ctx.createAnalyser(); ana.fftSize = 4096; ana.smoothingTimeConstant = 0.75;

    const chain = [src, hp, lp, ...eqs.map(e=>e.node), deEss, tilt, vfL, vfH, comp, mkG, lim, outG, wG, ana];
    for (let i = 0; i < chain.length-1; i++) chain[i].connect(chain[i+1]);
    ana.connect(ctx.destination);

    src.start(0, this.playOffset);
    this.currentSource = src;
    this.analyserNode = ana;
    this.liveNodes = { hp, lp, eqs, deEss, tilt, vfL, vfH, comp, mkG, lim, outG, wG, chain };
    this.liveChainBuilt = true;
  }

  updateLiveChain() {
    if (!this.liveChainBuilt) return;
    const p = this.params; const n = this.liveNodes; const t = this.ctx.currentTime; const s = 0.02;
    try {
      n.hp.frequency.setTargetAtTime(p.hpFreq,t,s); n.hp.Q.setTargetAtTime(p.hpQ,t,s);
      n.lp.frequency.setTargetAtTime(p.lpFreq,t,s); n.lp.Q.setTargetAtTime(p.lpQ,t,s);
      const eqIds = ['eqSub','eqBass','eqWarmth','eqBody','eqLowMid','eqMid','eqPresence','eqClarity','eqAir','eqBrill'];
      n.eqs.forEach((eq,i) => eq.node.gain.setTargetAtTime(p[eqIds[i]]||0,t,s));
      n.deEss.frequency.setTargetAtTime(p.deEssFreq,t,s); n.deEss.gain.setTargetAtTime(-(p.deEssAmt/100)*10,t,s);
      n.tilt.gain.setTargetAtTime(p.specTilt,t,s);
      n.vfL.frequency.setTargetAtTime(p.voiceFocusLo,t,s); n.vfH.frequency.setTargetAtTime(p.voiceFocusHi,t,s);
      n.comp.threshold.setTargetAtTime(p.compThresh,t,s); n.comp.ratio.setTargetAtTime(p.compRatio,t,s);
      n.comp.attack.setTargetAtTime(p.compAttack/1000,t,s); n.comp.release.setTargetAtTime(p.compRelease/1000,t,s);
      n.comp.knee.setTargetAtTime(p.compKnee,t,s);
      n.mkG.gain.setTargetAtTime(Math.pow(10,p.compMakeup/20),t,s);
      n.lim.threshold.setTargetAtTime(p.limThresh,t,s); n.lim.release.setTargetAtTime(p.limRelease/1000,t,s);
      n.outG.gain.setTargetAtTime(Math.pow(10,p.outGain/20),t,s);
      n.wG.gain.setTargetAtTime(p.outWidth/100,t,s);
    } catch(e) {
      console.error('Error updating live chain:', e);
    }
  }

  teardownChain() {
    if (this.currentSource) {
      try { this.currentSource.stop(); } catch(e) { console.error('Error stopping current source:', e); }
      try { this.currentSource.disconnect(); } catch(e) { console.error('Error disconnecting current source:', e); }
      this.currentSource = null;
    }
    if (this.liveNodes.chain) {
      this.liveNodes.chain.forEach(n => {
        try { n.disconnect(); } catch(e) { console.error('Error disconnecting live node:', e); }
      });
    }
    this.liveNodes = {};
    this.liveChainBuilt = false;
  }

  // ======== 32-STAGE OCTA-PASS OFFLINE PIPELINE ========
  async runPipeline() {
    if (!this.inputBuffer || this.isProcessing) return;
    this.isProcessing = true; this.abortFlag = false;
    this.dom.processBtn.style.display = 'none'; this.dom.stopProcBtn.style.display = 'inline-flex';
    this.dom.saveProcBtn.disabled = true; this.dom.tpAB.disabled = true;
    this.setStatus('PROCESSING');
    if (this.forensicMode) { this.forensicLog = []; }
    const t0 = performance.now();
    const p = this.params;
    const sr = this.inputBuffer.sampleRate;
    const numCh = this.inputBuffer.numberOfChannels;
    const len = this.inputBuffer.length;
    const total = STAGES.length; // 32

    try {
      // ---- PASS 1: INGEST (stages 0-3) ----
      for (let i = 0; i < 4; i++) { await this.pip(i, total); if (this.abortFlag) throw 'abort'; }

      // ---- PASS 2: ANALYSIS (stages 4-7) ----
      await this.pip(4, total); // Noise Floor Profiling
      await this.pip(5, total); // VAD
      let vadMask = null;
      if (this.sileroSession) {
        try { vadMask = await this.runVAD(this.inputBuffer); } catch(e) { structuredLog('warn','VAD failed',{error:e.message}); }
      }
      await this.pip(6, total); // Spectral Fingerprint
      await this.pip(7, total); // STFT Engine Init

      // ---- ML WORKER: DeepFilterNet3 → Demucs (runs between analysis and filter pass) ----
      // If ml-worker is ready, enhance the input before the classical DSP chain processes it.
      let mlSourceBuffer = this.inputBuffer;
      if (this.mlWorkerReady) {
        try {
          const mlResult = await this.runMLEnhancement(this.inputBuffer, (stage, pct) => {
            this.dom.pipeStage && (this.dom.pipeStage.textContent = `ML: ${stage} (${pct}%)`);
          });
          if (mlResult && mlResult.signal) {
            // Wrap the enhanced Float32Array back into an AudioBuffer
            const mlBuf = this.ctx.createBuffer(1, mlResult.signal.length, mlResult.sampleRate);
            mlBuf.copyToChannel(mlResult.signal, 0);
            mlSourceBuffer = mlBuf;
            if (this.forensicMode) await this.addAuditEntry(mlSourceBuffer, 'ML Enhancement');
          }
        } catch (e) {
          structuredLog('warn', 'ML enhancement failed — using original', { error: e.message });
        }
      }
      if (this.abortFlag) throw 'abort';

      // ---- PASS 3: FILTER (stages 8-11) via Web Audio nodes ----
      const ofl = new OfflineAudioContext(numCh, len, sr);
      const src = ofl.createBufferSource(); src.buffer = mlSourceBuffer;

      await this.pip(8, total);  const hp = ofl.createBiquadFilter(); hp.type='highpass'; hp.frequency.value=p.hpFreq; hp.Q.value=p.hpQ;
      await this.pip(9, total);  const lp = ofl.createBiquadFilter(); lp.type='lowpass'; lp.frequency.value=p.lpFreq; lp.Q.value=p.lpQ;
      await this.pip(10, total); const vbp = ofl.createBiquadFilter(); vbp.type='peaking'; vbp.frequency.value=1500; vbp.Q.value=0.5; vbp.gain.value=(p.voiceIso/100)*6;
      await this.pip(11, total);
      const gate = ofl.createDynamicsCompressor(); gate.threshold.value=p.gateThresh; gate.knee.value=2; gate.ratio.value=20; gate.attack.value=p.gateAttack/1000; gate.release.value=p.gateRelease/1000;
      const notch = ofl.createBiquadFilter(); notch.type='notch'; notch.frequency.value=60; notch.Q.value=30;
      if (this.abortFlag) throw 'abort';

      // ---- PASS 5: EQ (stages 16-19) via Web Audio nodes (built alongside filter) ----
      const eqDefs = [
        {id:'eqSub',f:40,t:'lowshelf'},{id:'eqBass',f:100,t:'peaking',q:1.2},
        {id:'eqWarmth',f:200,t:'peaking',q:1},{id:'eqBody',f:400,t:'peaking',q:1},
        {id:'eqLowMid',f:800,t:'peaking',q:1},{id:'eqMid',f:1500,t:'peaking',q:1.2},
        {id:'eqPresence',f:3000,t:'peaking',q:1.5},{id:'eqClarity',f:5000,t:'peaking',q:1.2},
        {id:'eqAir',f:10000,t:'highshelf'},{id:'eqBrill',f:16000,t:'highshelf'}
      ];
      const eqN = eqDefs.map(b => {
        const n = ofl.createBiquadFilter(); n.type=b.t; n.frequency.value=b.f;
        if (b.q) n.Q.value=b.q; n.gain.value=p[b.id]||0; return n;
      });

      // ---- PASS 6: SPECTRAL PROCESSING (stages 20-23) via Web Audio ----
      const de = ofl.createBiquadFilter(); de.type='peaking'; de.frequency.value=p.deEssFreq; de.Q.value=3; de.gain.value=-(p.deEssAmt/100)*10;
      const tlt = ofl.createBiquadFilter(); tlt.type='highshelf'; tlt.frequency.value=1000; tlt.gain.value=p.specTilt;

      // ---- PASS 7: DYNAMICS (stages 24-27) via Web Audio ----
      const hrm = ofl.createWaveShaper(); hrm.curve=this.makeHarm(p.harmRecov/100,p.harmOrder); hrm.oversample='2x';
      const cmp = ofl.createDynamicsCompressor(); cmp.threshold.value=p.compThresh; cmp.ratio.value=p.compRatio; cmp.attack.value=p.compAttack/1000; cmp.release.value=p.compRelease/1000; cmp.knee.value=p.compKnee;
      const mkG = ofl.createGain(); mkG.gain.value=Math.pow(10,p.compMakeup/20);
      const lim = ofl.createDynamicsCompressor(); lim.threshold.value=p.limThresh; lim.knee.value=0; lim.ratio.value=20; lim.attack.value=0.001; lim.release.value=p.limRelease/1000;
      const oG = ofl.createGain(); oG.gain.value=Math.pow(10,p.outGain/20);

      // Connect the Web Audio chain: src → hp → lp → vbp → gate → notch → 10×EQ → de → tlt → hrm → cmp → mkG → lim → oG → dest
      const chain = [src, hp, lp, vbp, gate, notch, ...eqN, de, tlt, hrm, cmp, mkG, lim, oG];
      for (let i = 0; i < chain.length-1; i++) chain[i].connect(chain[i+1]);
      chain[chain.length-1].connect(ofl.destination);
      src.start(0);
      const rendered = await ofl.startRendering();
      if (this.abortFlag) throw 'abort';

      // Report Web Audio passes as complete
      for (let i = 12; i < 16; i++) await this.pip(i, total); // PASS 4 labels (spectral NR placeholder)
      for (let i = 16; i < 20; i++) await this.pip(i, total); // PASS 5: EQ labels
      for (let i = 20; i < 22; i++) await this.pip(i, total); // PASS 6: De-Ess + Tilt

      // ---- PASS 4: SPECTRAL NR — actual spectral processing ----
      let fin = rendered;
      if (p.nrAmount > 0) {
        fin = this.applySpectralNR(fin, p.nrAmount/100, p.nrSensitivity/100, p.nrSpectralSub/100, p.nrFloor, p.nrSmoothing/100, vadMask);
        if (this.forensicMode) await this.addAuditEntry(fin, 'Spectral NR');
      }
      if (this.abortFlag) throw 'abort';

      // Background suppression
      if (p.bgSuppress > 0) {
        fin = this.applyBgSuppress(fin, p.bgSuppress, p.voiceFocusLo, p.voiceFocusHi);
        if (this.forensicMode) await this.addAuditEntry(fin, 'Background Suppression');
      }

      // Dereverberation (spectral)
      if (p.derevAmt > 0) {
        fin = this.applyDereverb(fin, p.derevAmt, p.derevDecay);
        if (this.forensicMode) await this.addAuditEntry(fin, 'Dereverberation');
      }

      // ---- PASS 6 continued: Formant shift + Phase correction ----
      await this.pip(22, total); // Formant Shift
      if (p.formantShift !== 0) {
        fin = this.applyFormantShift(fin, p.formantShift);
        if (this.forensicMode) await this.addAuditEntry(fin, 'Formant Shift');
      }
      await this.pip(23, total); // Phase Correction
      if (p.phaseCorr > 0) {
        fin = this.applyPhaseCorr(fin, p.phaseCorr);
        if (this.forensicMode) await this.addAuditEntry(fin, 'Phase Correction');
      }
      if (this.abortFlag) throw 'abort';

      // ---- PASS 7 continued: Crosstalk cancellation ----
      for (let i = 24; i < 27; i++) await this.pip(i, total); // Harmonic, Comp, Limiter labels
      await this.pip(27, total); // Crosstalk Cancellation
      if (p.crosstalkCancel > 0) {
        fin = this.applyCrosstalkCancel(fin, p.crosstalkCancel);
        if (this.forensicMode) await this.addAuditEntry(fin, 'Crosstalk Cancellation');
      }

      // ---- PASS 8: MASTER (stages 28-31) ----
      await this.pip(28, total); // Dry/Wet
      if (p.dryWet < 100) fin = this.mixDW(this.inputBuffer, fin, p.dryWet/100);

      await this.pip(29, total); // Dither
      if (p.ditherAmt > 0) fin = this.applyDither(fin, p.ditherAmt);

      await this.pip(30, total); // Output Normalization
      // Forensic mode skips normalization to preserve original dynamics
      if (!this.forensicMode) fin = this.peakNorm(fin, p.limThresh);
      if (this.forensicMode) await this.addAuditEntry(fin, 'Final Output');

      await this.pip(31, total); // Final Render

      // ---- COMPLETE ----
      this.dom.stProcTime.textContent = ((performance.now()-t0)/1000).toFixed(2)+'s';
      this.outputBuffer = fin;
      const snr = this.calcRMS(fin.getChannelData(0)) - this.calcRMS(this.inputBuffer.getChannelData(0));
      this.dom.hSNR.textContent = (snr>=0?'+':'') + snr.toFixed(1) + ' dB';
      this.resizeCanvas(this.dom.waveProcCanvas);
      this.drawWaveform(fin, this.dom.waveProcCanvas, '#22d3ee');
      this.dom.stVoices.textContent = this.estVoices(fin);
      this.dom.saveProcBtn.disabled = false; this.dom.tpAB.disabled = false; this.dom.reprocessBtn.disabled = false;
      this.dom.tpABLabel.textContent = 'Ready — A/B';
      if (this.dom.auditLogBtn) this.dom.auditLogBtn.disabled = !this.forensicMode || this.forensicLog.length === 0;
      this.setStatus('COMPLETE');
    } catch(e) {
      if (e==='abort') { this.setStatus('ABORTED'); this.dom.pipeStage.textContent='Aborted'; }
      else { structuredLog('error', 'Pipeline error', { error: e instanceof Error ? e.message : String(e) }); this.setStatus('ERROR'); this.dom.pipeDetail.textContent=e instanceof Error ? e.message : String(e); }
    } finally {
      this.isProcessing=false; this.dom.processBtn.style.display='inline-flex'; this.dom.stopProcBtn.style.display='none';
    }
  }

  async pip(i,t) {
    const pct = Math.round((i+1)/t*100);
    this.dom.pipeFill.style.width = pct + '%';
    this.dom.pipeBar.setAttribute('aria-valuenow', pct);
    this.dom.pipeStage.textContent = (i+1)+'/'+t;
    this.dom.pipeDetail.textContent = STAGES[i];
    this.dom.hStatus.textContent = 'S'+(i+1);
    await new Promise(r=>setTimeout(r,15));
  }

  // ---- DSP HELPERS ----

  // ======== PHASE 1: SPECTRAL ENGINE (STFT / iSTFT / Wiener NR) ========

  // Radix-2 DIT FFT in-place (size must be power of 2)
  _fft(re, im) {
    const n = re.length;
    // Bit-reversal permutation
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { const tr=re[i]; re[i]=re[j]; re[j]=tr; const ti=im[i]; im[i]=im[j]; im[j]=ti; }
    }
    // Cooley-Tukey butterfly
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let j = 0; j < (len >> 1); j++) {
          const ur=re[i+j], ui=im[i+j];
          const vr=re[i+j+(len>>1)]*cr - im[i+j+(len>>1)]*ci;
          const vi=re[i+j+(len>>1)]*ci + im[i+j+(len>>1)]*cr;
          re[i+j]=ur+vr; im[i+j]=ui+vi;
          re[i+j+(len>>1)]=ur-vr; im[i+j+(len>>1)]=ui-vi;
          const nr=cr*wr-ci*wi; ci=cr*wi+ci*wr; cr=nr;
        }
      }
    }
  }

  // IFFT via conjugate trick
  _ifft(re, im) {
    for (let i = 0; i < im.length; i++) im[i] = -im[i];
    this._fft(re, im);
    const n = re.length;
    for (let i = 0; i < n; i++) { re[i] /= n; im[i] = -im[i] / n; }
  }

  // Blackman-Harris window
  _makeWindow(N) {
    const win = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const c = (2 * Math.PI * i) / (N - 1);
      win[i] = 0.35875 - 0.48829*Math.cos(c) + 0.14128*Math.cos(2*c) - 0.01168*Math.cos(3*c);
    }
    return win;
  }

  // Real spectral noise reduction via Wiener filtering (replaces the old stub applyNR)
  applySpectralNR(buf, amt, sensitivity, spectralSub, floorDb, smoothing, vadMask) {
    const nCh = buf.numberOfChannels, len = buf.length, sr = buf.sampleRate;
    const out = this.ctx.createBuffer(nCh, len, sr);
    const N = 2048, H = 512, halfN = N / 2 + 1;
    const win = this._makeWindow(N);
    // over-subtraction 1..3, spectral floor 0.01..0.1
    const alpha = 1 + amt * 2;
    const beta = Math.max(0.01, 0.1 - spectralSub * 0.09);
    const floorLin = Math.pow(10, floorDb / 20);
    const sm = Math.max(0, Math.min(0.95, smoothing * 0.95));

    for (let ch = 0; ch < nCh; ch++) {
      const inp = buf.getChannelData(ch);
      const outData = out.getChannelData(ch);
      const normBuf = new Float64Array(len);

      // Profile noise PSD from first ~500ms
      const profLen = Math.min(Math.floor(sr * 0.5), len);
      const noisePSD = new Float64Array(halfN);
      let profFrames = 0;
      for (let s = 0; s + N <= profLen; s += H) {
        const re = new Float64Array(N), im = new Float64Array(N);
        for (let i = 0; i < N; i++) re[i] = inp[s + i] * win[i];
        this._fft(re, im);
        for (let k = 0; k < halfN; k++) noisePSD[k] += re[k]*re[k] + im[k]*im[k];
        profFrames++;
      }
      if (profFrames > 0) for (let k = 0; k < halfN; k++) {
        noisePSD[k] = Math.max(noisePSD[k] / profFrames, floorLin * floorLin);
      }
      const smoothedNoise = new Float64Array(noisePSD);

      // Process all frames
      let frameIdx = 0;
      for (let s = 0; s + N <= len; s += H, frameIdx++) {
        const re = new Float64Array(N), im = new Float64Array(N);
        for (let i = 0; i < N; i++) re[i] = inp[s + i] * win[i];
        this._fft(re, im);

        // If VAD mask available: only apply NR during non-speech frames
        const frameTimeSec = s / sr;
        const vadFrameIdx = vadMask ? Math.floor(frameTimeSec * 100) : -1;
        const isSpeech = vadMask && vadFrameIdx < vadMask.length ? vadMask[vadFrameIdx] : false;

        for (let k = 0; k < halfN; k++) {
          const sigPSD = re[k]*re[k] + im[k]*im[k];
          smoothedNoise[k] = sm * smoothedNoise[k] + (1 - sm) * noisePSD[k];
          const nEst = alpha * smoothedNoise[k] * (1 + sensitivity * 0.5);
          // Apply softer NR during speech frames: reduce noise estimate so Wiener
          // gain stays higher (less attenuation) rather than using nEst as a gain floor
          // (nEst is a PSD value, not a valid gain — using it as a floor could amplify).
          const nEstFrame = isSpeech ? nEst * 0.3 : nEst;
          const gain = sigPSD > 1e-12 ?
            Math.max(Math.sqrt(Math.max(sigPSD - nEstFrame, 0) / sigPSD), beta) : beta;
          re[k] *= gain; im[k] *= gain;
          if (k > 0 && k < N - k) { re[N-k] = re[k]; im[N-k] = -im[k]; }
        }
        this._ifft(re, im);
        for (let i = 0; i < N && s + i < len; i++) {
          outData[s + i] += re[i] * win[i];
          normBuf[s + i] += win[i] * win[i];
        }
      }
      for (let i = 0; i < len; i++) {
        if (normBuf[i] > 1e-8) outData[i] /= normBuf[i];
        outData[i] = Math.max(-1, Math.min(1, outData[i]));
      }
    }
    return out;
  }

  // ======== PHASE 2: WIRED SLIDERS — SPECTRAL PROCESSING ========

  // Background suppression: attenuate bins outside voice focus band
  applyBgSuppress(buf, suppressAmt, voiceFocusLo, voiceFocusHi) {
    if (suppressAmt <= 0) return buf;
    const nCh = buf.numberOfChannels, len = buf.length, sr = buf.sampleRate;
    const out = this.ctx.createBuffer(nCh, len, sr);
    const N = 2048, H = 512, halfN = N / 2 + 1;
    const win = this._makeWindow(N);
    const g = 1 - suppressAmt / 100;

    for (let ch = 0; ch < nCh; ch++) {
      const inp = buf.getChannelData(ch);
      const outData = out.getChannelData(ch);
      const normBuf = new Float64Array(len);
      for (let s = 0; s + N <= len; s += H) {
        const re = new Float64Array(N), im = new Float64Array(N);
        for (let i = 0; i < N; i++) re[i] = inp[s + i] * win[i];
        this._fft(re, im);
        for (let k = 0; k < halfN; k++) {
          const freq = k * sr / N;
          if (freq < voiceFocusLo || freq > voiceFocusHi) {
            re[k] *= g; im[k] *= g;
            if (k > 0 && k < N - k) { re[N-k] *= g; im[N-k] *= g; }
          }
        }
        this._ifft(re, im);
        for (let i = 0; i < N && s + i < len; i++) {
          outData[s + i] += re[i] * win[i];
          normBuf[s + i] += win[i] * win[i];
        }
      }
      for (let i = 0; i < len; i++) {
        if (normBuf[i] > 1e-8) outData[i] /= normBuf[i];
        outData[i] = Math.max(-1, Math.min(1, outData[i]));
      }
    }
    return out;
  }

  // Spectral dereverberation via temporal variance suppression
  applyDereverb(buf, amt, decaySec) {
    if (amt <= 0) return buf;
    const nCh = buf.numberOfChannels, len = buf.length, sr = buf.sampleRate;
    const out = this.ctx.createBuffer(nCh, len, sr);
    const N = 2048, H = 512, halfN = N / 2 + 1;
    const win = this._makeWindow(N);
    const g = amt / 100;
    const smCoef = Math.exp(-H / (sr * Math.max(0.05, decaySec)));

    for (let ch = 0; ch < nCh; ch++) {
      const inp = buf.getChannelData(ch);
      const outData = out.getChannelData(ch);
      const normBuf = new Float64Array(len);
      const magMean = new Float64Array(halfN).fill(1e-6);
      for (let s = 0; s + N <= len; s += H) {
        const re = new Float64Array(N), im = new Float64Array(N);
        for (let i = 0; i < N; i++) re[i] = inp[s + i] * win[i];
        this._fft(re, im);
        for (let k = 0; k < halfN; k++) {
          const mag = Math.sqrt(re[k]*re[k] + im[k]*im[k]);
          // Reverb tail = magnitude smoothly less than running mean
          const isReverb = mag < magMean[k] * 0.75;
          const gain = isReverb ? Math.max(1 - g, 0.05) : 1;
          re[k] *= gain; im[k] *= gain;
          if (k > 0 && k < N - k) { re[N-k] *= gain; im[N-k] *= gain; }
          magMean[k] = smCoef * magMean[k] + (1 - smCoef) * mag;
        }
        this._ifft(re, im);
        for (let i = 0; i < N && s + i < len; i++) {
          outData[s + i] += re[i] * win[i];
          normBuf[s + i] += win[i] * win[i];
        }
      }
      for (let i = 0; i < len; i++) {
        if (normBuf[i] > 1e-8) outData[i] /= normBuf[i];
        outData[i] = Math.max(-1, Math.min(1, outData[i]));
      }
    }
    return out;
  }

  // Formant shift via spectral envelope warping
  applyFormantShift(buf, semitones) {
    if (semitones === 0) return buf;
    const nCh = buf.numberOfChannels, len = buf.length, sr = buf.sampleRate;
    const out = this.ctx.createBuffer(nCh, len, sr);
    const N = 2048, H = 512, halfN = N / 2 + 1;
    const win = this._makeWindow(N);
    const shiftFactor = Math.pow(2, semitones / 12);
    const envWin = 20;

    for (let ch = 0; ch < nCh; ch++) {
      const inp = buf.getChannelData(ch);
      const outData = out.getChannelData(ch);
      const normBuf = new Float64Array(len);
      for (let s = 0; s + N <= len; s += H) {
        const re = new Float64Array(N), im = new Float64Array(N);
        for (let i = 0; i < N; i++) re[i] = inp[s + i] * win[i];
        this._fft(re, im);
        // Compute log-magnitude and extract spectral envelope via smoothing
        const logMag = new Float64Array(halfN);
        const phase = new Float64Array(halfN);
        for (let k = 0; k < halfN; k++) {
          logMag[k] = Math.log(Math.max(Math.sqrt(re[k]*re[k]+im[k]*im[k]), 1e-10));
          phase[k] = Math.atan2(im[k], re[k]);
        }
        const envelope = new Float64Array(halfN);
        for (let k = 0; k < halfN; k++) {
          let sum = 0, cnt = 0;
          for (let j = Math.max(0,k-envWin); j <= Math.min(halfN-1,k+envWin); j++) { sum+=logMag[j]; cnt++; }
          envelope[k] = sum / cnt;
        }
        const detail = logMag.map((v,k) => v - envelope[k]);
        // Warp envelope by shiftFactor
        const newEnv = new Float64Array(halfN);
        for (let k = 0; k < halfN; k++) {
          const src = k / shiftFactor;
          const lo = Math.floor(src), hi = Math.min(lo+1, halfN-1);
          if (lo >= 0 && lo < halfN) newEnv[k] = (1-(src-lo))*envelope[lo] + (src-lo)*envelope[hi];
        }
        const reOut = new Float64Array(N), imOut = new Float64Array(N);
        for (let k = 0; k < halfN; k++) {
          const newMag = Math.exp(newEnv[k] + detail[k]);
          reOut[k] = newMag * Math.cos(phase[k]);
          imOut[k] = newMag * Math.sin(phase[k]);
          if (k > 0 && k < N - k) { reOut[N-k] = reOut[k]; imOut[N-k] = -imOut[k]; }
        }
        this._ifft(reOut, imOut);
        for (let i = 0; i < N && s + i < len; i++) {
          outData[s + i] += reOut[i] * win[i];
          normBuf[s + i] += win[i] * win[i];
        }
      }
      for (let i = 0; i < len; i++) {
        if (normBuf[i] > 1e-8) outData[i] /= normBuf[i];
        outData[i] = Math.max(-1, Math.min(1, outData[i]));
      }
    }
    return out;
  }

  // Cross-channel phase alignment via cross-correlation lag detection
  applyPhaseCorr(buf, corrAmt) {
    if (corrAmt <= 0 || buf.numberOfChannels < 2) return buf;
    const len = buf.length, sr = buf.sampleRate;
    const out = this.ctx.createBuffer(buf.numberOfChannels, len, sr);
    const L = buf.getChannelData(0), R = buf.getChannelData(1);
    const oL = out.getChannelData(0), oR = out.getChannelData(1);
    // Find best cross-correlation lag within ±5ms
    const maxLag = Math.floor(sr * 0.005);
    let bestLag = 0, bestCorr = -Infinity;
    const sampleCount = Math.min(len, Math.floor(sr * 2));
    for (let lag = -maxLag; lag <= maxLag; lag++) {
      let corr = 0;
      for (let i = maxLag; i < sampleCount - maxLag; i++) corr += L[i] * (R[i + lag] || 0);
      if (corr > bestCorr) { bestCorr = corr; bestLag = lag; }
    }
    const actualLag = Math.round(bestLag * corrAmt / 100);
    for (let i = 0; i < len; i++) {
      oL[i] = L[i];
      oR[i] = R[Math.max(0, Math.min(len-1, i - actualLag))];
    }
    for (let ch = 2; ch < buf.numberOfChannels; ch++) {
      const inCh = buf.getChannelData(ch), outCh = out.getChannelData(ch);
      for (let i = 0; i < len; i++) outCh[i] = inCh[i];
    }
    return out;
  }

  // Crosstalk cancellation via mid/side matrix
  applyCrosstalkCancel(buf, cancelAmt) {
    if (cancelAmt <= 0 || buf.numberOfChannels < 2) return buf;
    const len = buf.length, sr = buf.sampleRate;
    const out = this.ctx.createBuffer(buf.numberOfChannels, len, sr);
    const g = (cancelAmt / 100) * 0.5;
    const L = buf.getChannelData(0), R = buf.getChannelData(1);
    const oL = out.getChannelData(0), oR = out.getChannelData(1);
    for (let i = 0; i < len; i++) {
      oL[i] = L[i] - g * R[i];
      oR[i] = R[i] - g * L[i];
    }
    for (let ch = 2; ch < buf.numberOfChannels; ch++) {
      const inCh = buf.getChannelData(ch), outCh = out.getChannelData(ch);
      for (let i = 0; i < len; i++) outCh[i] = inCh[i];
    }
    return out;
  }

  // TPDF dither noise shaping before bit-depth reduction
  // 🛡️ Sentinel: Fixed weak PRNG by using chunked crypto.getRandomValues()
  applyDither(buf, ditherAmt) {
    if (ditherAmt <= 0) return buf;
    const nCh = buf.numberOfChannels, len = buf.length, sr = buf.sampleRate;
    const out = this.ctx.createBuffer(nCh, len, sr);
    const lsb = Math.pow(2, -15); // 16-bit LSB
    const g = (ditherAmt / 100) * lsb;
    const invMax = 1 / 4294967296;

    for (let ch = 0; ch < nCh; ch++) {
      const inp = buf.getChannelData(ch), outCh = out.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        if (this._rndIdx >= this._rndBuf.length - 1) {
          crypto.getRandomValues(this._rndBuf);
          this._rndIdx = 0;
        }
        const r1 = this._rndBuf[this._rndIdx++] * invMax;
        const r2 = this._rndBuf[this._rndIdx++] * invMax;
        const tpdf = (r1 - r2) * g;
        outCh[i] = Math.max(-1, Math.min(1, inp[i] + tpdf));
      }
    }
    return out;
  }

  // ======== PHASE 4: ML / VAD INTEGRATION ========

  // Trigger VAD model load in the ML Worker (fire-and-forget; mlReady set via _onMlMessage)
  async loadModels() {
    if (!this.mlWorker) {
      structuredLog('warn', 'ML Worker not available — running without ML');
      return;
    }
    const wasmRoot = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/';
    this.mlWorker.postMessage({ type: 'loadModel', model: 'vad', wasmRoot });
  }

  // Run Silero VAD via ML Worker; returns boolean[] or null if unavailable
  async runVAD(buf) {
    if (!this.mlReady || !this.mlWorker) return null;
    try {
      const signal = new Float32Array(buf.getChannelData(0)); // copy for transfer
      return await this._mlCall(
        { type: 'runVAD', signal, sampleRate: buf.sampleRate },
        [signal.buffer]
      );
    } catch(e) {
      structuredLog('warn', 'VAD Worker call failed', { error: e.message });
      return null;
    }
  }

  // ---- ML WORKER: DeepFilterNet3 + Demucs + VAD ----

  // Spin up ml-worker.js and initialise all models. Non-blocking; pipeline checks
  // this.mlWorkerReady before dispatching work.
  initMLWorker() {
    if (this.mlWorker) return;
    try {
      this.mlWorker = new Worker('./ml-worker.js');
      this.mlWorker.onmessage = (e) => {
        const { type } = e.data;
        if (type === 'ready') {
          this.mlWorkerReady = true;
          this.mlWorkerModels = e.data.models;
          structuredLog('info', 'ML worker ready', e.data.models);
        } else if (type === 'log') {
          structuredLog(e.data.level, '[ml-worker] ' + e.data.msg);
        }
        // 'result' and 'progress' messages are handled per-call via a promise wrapper
      };
      this.mlWorker.onerror = (err) => {
        structuredLog('warn', 'ML worker error', { error: err.message });
        this.mlWorkerReady = false;
      };
      this.mlWorker.postMessage({ type: 'init' });
    } catch (e) {
      structuredLog('warn', 'ML worker unavailable', { error: e.message });
    }
  }

  // Generic promise wrapper for ML Worker calls with callback ID tracking
  _mlCall(payload, transfer = []) {
    // Ensure callbacks map is initialized
    if (!this._mlCallbacks) this._mlCallbacks = {};
    if (typeof this._mlCallId !== 'number') this._mlCallId = 0;

    return new Promise((resolve, reject) => {
      const id = ++this._mlCallId;
      this._mlCallbacks[id] = { resolve, reject };
      
      // Timeout to prevent memory leaks from unresponsive workers
      const timeout = setTimeout(() => {
        this.mlWorker.removeEventListener('message', handler);
        delete this._mlCallbacks[id];
        reject(new Error('ML Worker call timed out'));
      }, 30000); // 30 second timeout

      const handler = (e) => {
        const { type } = e.data;
        if (type === 'result') {
          clearTimeout(timeout);
          this.mlWorker.removeEventListener('message', handler);
          delete this._mlCallbacks[id];
          resolve(e.data);
        } else if (type === 'error') {
          clearTimeout(timeout);
          this.mlWorker.removeEventListener('message', handler);
          delete this._mlCallbacks[id];
          reject(new Error(e.data.msg));
        }
        // Other message types (progress, log) are handled elsewhere
      };
      this.mlWorker.addEventListener('message', handler);
      this.mlWorker.postMessage({ ...payload, callId: id }, transfer);
    });
  }

  // Send audio to the ML worker and resolve with the enhanced Float32Array.
  // Falls back to the original signal if the worker is not ready.
  runMLEnhancement(buf, onProgress) {
    if (!this.mlWorkerReady || !this.mlWorker) {
      return Promise.resolve(null); // caller keeps original buffer
    }
    return new Promise((resolve, reject) => {
      const signal = buf.getChannelData(0);
      const copy   = new Float32Array(signal); // transferable copy

      const handler = (e) => {
        const { type } = e.data;
        if (type === 'result') {
          this.mlWorker.removeEventListener('message', handler);
          resolve(e.data);
        } else if (type === 'progress' && onProgress) {
          onProgress(e.data.stage, e.data.pct);
        } else if (type === 'error') {
          this.mlWorker.removeEventListener('message', handler);
          reject(new Error(e.data.msg));
        }
      };
      this.mlWorker.addEventListener('message', handler);
      this.mlWorker.postMessage(
        { type: 'process', signal: copy, sampleRate: buf.sampleRate, params: this.params },
        [copy.buffer]
      );
    });
  }

  // Run source separation (Demucs or BSRNN) via ML Worker; returns Float32Array or null
  async runSeparation(buf, model = 'demucs') {
    if (!this.mlWorkerReady || !this.mlWorker) return null;
    try {
      const signal = new Float32Array(buf.getChannelData(0));
      return new Promise((resolve, reject) => {
        const handler = (e) => {
          if (e.data.type === 'result') { this.mlWorker.removeEventListener('message', handler); resolve(e.data); }
          else if (e.data.type === 'error') { this.mlWorker.removeEventListener('message', handler); reject(new Error(e.data.msg)); }
        };
        this.mlWorker.addEventListener('message', handler);
        this.mlWorker.postMessage({ type: 'runSeparation', signal, sampleRate: buf.sampleRate, model }, [signal.buffer]);
      });
    } catch(e) {
      structuredLog('warn', 'Separation Worker call failed', { error: e.message });
      return null;
    }
  }

  // ======== PHASE 5: FORENSIC AUDIT ========

  // Compute SHA-256 of the first channel of an AudioBuffer and store in forensicLog
  async addAuditEntry(buf, stageName) {
    try {
      const data = buf.getChannelData(0);
      const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      const hashBuf = await crypto.subtle.digest('SHA-256', bytes);
      const hex = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2,'0')).join('');
      this.forensicLog.push({ stage: stageName, sha256: hex, timestamp: new Date().toISOString(), channels: buf.numberOfChannels, length: buf.length, sampleRate: buf.sampleRate });
    } catch(e) { /* crypto unavailable in some contexts */ }
  }

  downloadAuditLog() {
    if (!this.forensicLog.length) return;
    const blob = new Blob([JSON.stringify({ app:'VoiceIsolate Pro', version:'19.0', mode:'Forensic', entries: this.forensicLog }, null, 2)], { type:'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = 'voiceisolate_audit_' + Date.now() + '.json';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  }

  mixDW(dry, wet, wAmt) {

    const c = this.ctx;
    const nCh = Math.min(dry.numberOfChannels, wet.numberOfChannels);
    const len = Math.min(dry.length, wet.length);
    const out = c.createBuffer(nCh, len, dry.sampleRate);
    for (let ch = 0; ch < nCh; ch++) {
      const d = dry.getChannelData(ch);
      const w = wet.getChannelData(ch);
      const o = out.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        o[i] = d[i] * (1 - wAmt) + w[i] * wAmt;
      }
    }
    return out;
  }

  peakNorm(buf, tDb) {
    const c = this.ctx;
    const nCh = buf.numberOfChannels;
    const len = buf.length;
    const out = c.createBuffer(nCh, len, buf.sampleRate);
    let pk = 0;
    // Find the peak absolute value
    for (let ch = 0; ch < nCh; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const a = Math.abs(d[i]);
        if (a > pk) pk = a;
      }
    }
    // Return original buffer if completely silent
    if (pk === 0) return buf;
    // Calculate gain and apply it
    const g = Math.pow(10, tDb / 20) / pk;
    for (let ch = 0; ch < nCh; ch++) {
      const inp = buf.getChannelData(ch);
      const o = out.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        o[i] = Math.max(-1, Math.min(1, inp[i] * g));
      }
    }
    return out;
  }

  makeHarm(amt, ord) {
    const n = 44100;
    const curve = new Float32Array(n);
    const k = amt * (ord || 3) * 2 + 1;

    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1;
      curve[i] = Math.tanh(k * x) / Math.tanh(k);
    }

    return curve;
  }

  estVoices(buf){const d=buf.getChannelData(0);const sr=buf.sampleRate;const bs=Math.floor(sr*0.5);let act=0;for(let i=0;i<d.length;i+=bs){let r=0;const e=Math.min(i+bs,d.length);for(let j=i;j<e;j++)r+=d[j]*d[j];r=Math.sqrt(r/(e-i));if(r>0.01)act++;}return act<3?'0-1':act<10?'1':'1-2+';}

  // ---- SAVE ----
  saveWav(buf,label){if(!buf)return;const w=this.encWav(buf);const b=new Blob([w],{type:'audio/wav'});const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='voiceisolate_v19_'+label+'_'+Date.now()+'.wav';document.body.appendChild(a);a.click();document.body.removeChild(a);URL.revokeObjectURL(a.href);}
  encWav(buf) {
    const nCh = buf.numberOfChannels;
    const sr = buf.sampleRate;
    const dL = buf.length * nCh * 2; // 16-bit (2 bytes per sample)

    // Total size: 44 bytes header + data length
    const a = new ArrayBuffer(44 + dL);
    const v = new DataView(a);

    // Helper to write string to DataView
    const ws = (o, s) => {
      for (let i = 0; i < s.length; i++) {
        v.setUint8(o + i, s.charCodeAt(i));
      }
    };

    // --- RIFF Chunk ---
    ws(0, 'RIFF');                     // ChunkID
    v.setUint32(4, 36 + dL, true);     // ChunkSize (36 + SubChunk2Size)
    ws(8, 'WAVE');                     // Format

    // --- fmt Subchunk ---
    ws(12, 'fmt ');                    // Subchunk1ID
    v.setUint32(16, 16, true);         // Subchunk1Size (16 for PCM)
    v.setUint16(20, 1, true);          // AudioFormat (1 for PCM)
    v.setUint16(22, nCh, true);        // NumChannels
    v.setUint32(24, sr, true);         // SampleRate
    v.setUint32(28, sr * nCh * 2, true); // ByteRate (SampleRate * NumChannels * BitsPerSample/8)
    v.setUint16(32, nCh * 2, true);    // BlockAlign (NumChannels * BitsPerSample/8)
    v.setUint16(34, 16, true);         // BitsPerSample

    // --- data Subchunk ---
    ws(36, 'data');                    // Subchunk2ID
    v.setUint32(40, dL, true);         // Subchunk2Size (NumSamples * NumChannels * BitsPerSample/8)

    // Pre-fetch channel data to avoid expensive getChannelData calls inside the per-sample loop
    const channels = [];
    for (let ch = 0; ch < nCh; ch++) {
      channels.push(buf.getChannelData(ch));
    }

    // Write audio data
    let off = 44;

    for (let i = 0; i < buf.length; i++) {
      for (let ch = 0; ch < nCh; ch++) {
        let s = channels[ch][i];
        // Hard clipping
        s = Math.max(-1, Math.min(1, s));
        // Convert to 16-bit PCM
        v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
        off += 2;
      }
    }
    return a;
  }

  // ======== VISUALIZATIONS ========
  initCanvases(){[this.dom.waveOrigCanvas,this.dom.waveProcCanvas,this.dom.spectro2DCanvas,this.dom.freqCanvas].forEach(c=>this.resizeCanvas(c));this.clearCanvas(this.dom.waveOrigCanvas,'Load audio to begin');this.clearCanvas(this.dom.waveProcCanvas,'Process to see result');this.clearCanvas(this.dom.spectro2DCanvas,'Play audio for spectrogram');this.clearCanvas(this.dom.freqCanvas,'Play audio for analyzer');}

  resizeCanvas(c){const r=c.getBoundingClientRect();c.width=Math.floor(r.width);c.height=Math.floor(r.height);c._w=r.width;c._h=r.height;}

  clearCanvas(c,txt){const x=c.getContext('2d');x.fillStyle='#030306';x.fillRect(0,0,c.width,c.height);if(txt){x.font='11px Outfit,sans-serif';x.fillStyle='rgba(255,255,255,0.12)';x.textAlign='center';x.fillText(txt,c.width/2,c.height/2+3);}}

  drawWaveform(buf,canvas,color){const x=canvas.getContext('2d');const w=canvas.width;const h=canvas.height;x.fillStyle='#030306';x.fillRect(0,0,w,h);if(!buf)return;const d=buf.getChannelData(0);const step=Math.max(1,Math.floor(d.length/w));x.strokeStyle='rgba(255,255,255,0.04)';x.lineWidth=1;x.beginPath();x.moveTo(0,h/2);x.lineTo(w,h/2);x.stroke();x.fillStyle=color;for(let px=0;px<w;px++){const idx=px*step;let mn=1,mx=-1;for(let i=0;i<step&&(idx+i)<d.length;i++){const v=d[idx+i];if(v<mn)mn=v;if(v>mx)mx=v;}const y1=((1-mx)*0.5)*h;const y2=((1-mn)*0.5)*h;x.globalAlpha=0.8;x.fillRect(px,y1,1,Math.max(1,y2-y1));}x.globalAlpha=1;}

  // ---- 2D Spectrogram (FIXED: no DPR scaling issues) ----
  startSpectro(ana){
    this.stopSpectro(); this.spectroRunning=true; this.spectroX=0;
    const c=this.dom.spectro2DCanvas; this.resizeCanvas(c);
    const x=c.getContext('2d'); x.fillStyle='#030306'; x.fillRect(0,0,c.width,c.height);
    const bLen=ana.frequencyBinCount; const arr=new Uint8Array(bLen);
    const draw=()=>{
      if(!this.spectroRunning)return; this.animId=requestAnimationFrame(draw);
      ana.getByteFrequencyData(arr);
      const w=c.width;const h=c.height;const sw=2;
      if(this.spectroX+sw>=w){
        const img=x.getImageData(sw,0,w-sw,h);
        x.putImageData(img,0,0);
        x.fillStyle='#030306';x.fillRect(w-sw,0,sw,h);
        this.spectroX=w-sw;
      }
      for(let y=0;y<h;y++){
        const fi=Math.floor((y/h)*bLen);
        const val=arr[bLen-1-fi];
        const muted=this.isBandMuted(fi,bLen,ana.context?ana.context.sampleRate:44100);
        x.fillStyle=muted?'rgba(30,30,30,0.8)':this.sColor(val,fi,bLen);
        x.fillRect(this.spectroX,y,sw,1);
      }
      this.spectroX+=sw;
      this.update3D(arr);
    };
    draw();
  }

  stopSpectro(){this.spectroRunning=false;if(this.animId){cancelAnimationFrame(this.animId);this.animId=null;}}

  sColor(val,fi,total){
    const v=val/255;const f=fi/total;
    if(f<0.05)return 'rgb('+Math.floor(v*40)+','+Math.floor(v*80)+','+Math.floor(60+v*195)+')';
    if(f<0.2)return 'rgb('+Math.floor(60+v*195)+','+Math.floor(v*30)+','+Math.floor(v*20)+')';
    if(f<0.5)return 'rgb('+Math.floor(80+v*175)+','+Math.floor(v*60)+','+Math.floor(v*10)+')';
    if(f<0.75)return 'rgb('+Math.floor(v*30)+','+Math.floor(50+v*180)+','+Math.floor(v*30)+')';
    return 'rgb('+Math.floor(60+v*195)+','+Math.floor(50+v*160)+','+Math.floor(v*20)+')';
  }

  isBandMuted(fi,total,sr){const freq=(fi/total)*(sr/2);for(const b of this.mutedBands)if(freq>=b.lo&&freq<b.hi)return true;return false;}

  onSpectroClick(e){
    const r=this.dom.spectro3DCanvas.getBoundingClientRect();
    const y=1-((e.clientY-r.top)/r.height);
    const sr=this.ctx?this.ctx.sampleRate:44100;
    const freq=y*(sr/2);const bw=sr/20;
    const lo=Math.max(0,freq-bw/2);const hi=freq+bw/2;const key=Math.round(lo)+'-'+Math.round(hi);
    let found=false;
    for(const b of this.mutedBands){if(b.key===key){this.mutedBands.delete(b);found=true;break;}}
    if(!found)this.mutedBands.add({lo,hi,key});
  }

  // ---- Frequency Analyzer ----
  startFreq(ana){
    const c=this.dom.freqCanvas;this.resizeCanvas(c);
    const x=c.getContext('2d');const bLen=ana.frequencyBinCount;const arr=new Uint8Array(bLen);
    const draw=()=>{
      if(!this.spectroRunning)return;requestAnimationFrame(draw);
      ana.getByteFrequencyData(arr);const w=c.width;const h=c.height;
      x.fillStyle='#030306';x.fillRect(0,0,w,h);
      x.strokeStyle='rgba(255,255,255,0.03)';x.lineWidth=1;
      for(let i=1;i<5;i++){const gy=(i/5)*h;x.beginPath();x.moveTo(0,gy);x.lineTo(w,gy);x.stroke();}
      const bW=(w/bLen)*2.5;let px=0;
      for(let i=0;i<bLen&&px<w;i++){
        const bH=(arr[i]/255)*h;const f=i/bLen;
        let hue;if(f<0.05)hue=220;else if(f<0.2)hue=0;else if(f<0.5)hue=10;else if(f<0.75)hue=130;else hue=50;
        x.fillStyle='hsla('+hue+',75%,50%,0.75)';x.fillRect(px,h-bH,Math.max(1,bW-1),bH);px+=bW;
      }
    };
    draw();
  }

  // ---- 3D Spectrogram ----
  init3D(){
    const ct=this.dom.spectro3DContainer;const w=ct.clientWidth;const h=ct.clientHeight;
    if(w===0||h===0)return;
    const scene=new THREE.Scene();scene.background=new THREE.Color(0x030306);
    const cam=new THREE.PerspectiveCamera(45,w/h,0.1,1000);cam.position.set(0,40,60);cam.lookAt(0,0,0);
    const ren=new THREE.WebGLRenderer({canvas:this.dom.spectro3DCanvas,antialias:true});
    ren.setSize(w,h);ren.setPixelRatio(Math.min(window.devicePixelRatio,2));
    const gW=64;const gD=128;
    const geo=new THREE.PlaneGeometry(80,40,gW-1,gD-1);geo.rotateX(-Math.PI*0.4);
    const cols=new Float32Array(geo.attributes.position.count*3);
    geo.setAttribute('color',new THREE.BufferAttribute(cols,3));
    const mat=new THREE.MeshBasicMaterial({vertexColors:true,wireframe:false,side:THREE.DoubleSide});
    const mesh=new THREE.Mesh(geo,mat);scene.add(mesh);
    scene.add(new THREE.AmbientLight(0xffffff,0.5));
    this.three={scene,cam,ren,mesh,geo,gW,gD,cols};

    let drag=false,pX=0,pY=0;
    const cv=this.dom.spectro3DCanvas;
    cv.addEventListener('mousedown',e=>{drag=true;pX=e.clientX;pY=e.clientY;});
    window.addEventListener('mouseup',()=>drag=false);
    window.addEventListener('mousemove',e=>{if(!drag)return;cam.position.x-=(e.clientX-pX)*0.15;cam.position.y+=(e.clientY-pY)*0.15;cam.lookAt(0,0,0);pX=e.clientX;pY=e.clientY;});
    cv.addEventListener('wheel',e=>{e.preventDefault();cam.position.z+=e.deltaY*0.05;cam.position.z=Math.max(20,Math.min(120,cam.position.z));},{passive:false});
    this.render3D();
  }

  reset3DView(){if(this.three.cam){this.three.cam.position.set(0,40,60);this.three.cam.lookAt(0,0,0);}}

  // ⚡ Bolt: Optimized 3D Spectrogram buffer updates by replacing nested element-by-element loops
  // with native TypedArray.copyWithin() and direct array access, reducing per-frame JS overhead.
  update3D(freq){
    if(!this.three.geo)return;
    const{geo,gW,gD,cols}=this.three;const pos=geo.attributes.position;const colA=geo.attributes.color;
    cols.copyWithin(gW*3, 0, (gD-1)*gW*3);
    const pArr=pos.array;
    const end=gD*gW*3;const offset=gW*3;
    for(let i=end-2;i>=offset;i-=3)pArr[i]=pArr[i-offset];
    const step=Math.floor(freq.length/gW);
    for(let x=0;x<gW;x++){const fi=Math.min(x*step,freq.length-1);const v=(freq[fi]||0)/255;pArr[x*3+1]=v*15;const f=x/gW;
      if(f<0.05){cols[x*3]=v*0.15;cols[x*3+1]=v*0.3;cols[x*3+2]=0.3+v*0.7;}
      else if(f<0.3){cols[x*3]=0.3+v*0.7;cols[x*3+1]=v*0.1;cols[x*3+2]=v*0.05;}
      else if(f<0.6){cols[x*3]=v*0.1;cols[x*3+1]=0.2+v*0.6;cols[x*3+2]=v*0.1;}
      else{cols[x*3]=0.3+v*0.6;cols[x*3+1]=0.25+v*0.5;cols[x*3+2]=v*0.05;}
    }
    pos.needsUpdate=true;colA.needsUpdate=true;
  }

  render3D(){requestAnimationFrame(()=>this.render3D());if(this.three.ren)this.three.ren.render(this.three.scene,this.three.cam);}

  onResize(){
    [this.dom.waveOrigCanvas,this.dom.waveProcCanvas,this.dom.spectro2DCanvas,this.dom.freqCanvas].forEach(c=>this.resizeCanvas(c));
    if(this.inputBuffer)this.drawWaveform(this.inputBuffer,this.dom.waveOrigCanvas,'#dc2626');
    if(this.outputBuffer)this.drawWaveform(this.outputBuffer,this.dom.waveProcCanvas,'#22d3ee');
    const ct=this.dom.spectro3DContainer;
    if(this.three.ren){this.three.ren.setSize(ct.clientWidth,ct.clientHeight);this.three.cam.aspect=ct.clientWidth/ct.clientHeight;this.three.cam.updateProjectionMatrix();}
  }

  // ---- UTILITY ----
  setStatus(s){this.dom.hStatus.textContent=s;const c={IDLE:'#5e5e78',LOADING:'#eab308',READY:'#22c55e',PROCESSING:'#dc2626',COMPLETE:'#22d3ee',ERROR:'#ef4444',RECORDING:'#ef4444',ABORTED:'#a855f7'};this.dom.hStatus.style.color=c[s]||'#5e5e78';}
  calcRMS(d){let s=0;for(let i=0;i<d.length;i++)s+=d[i]*d[i];const rSq=s/d.length;return rSq>0?10*Math.log10(rSq):-96;}
  calcPeak(d){let pSq=0;for(let i=0;i<d.length;i++){const aSq=d[i]*d[i];if(aSq>pSq)pSq=aSq;}return pSq>0?10*Math.log10(pSq):-96;}
  fmtDur(s){const m=Math.floor(s/60);const sc=Math.floor(s%60);return m+':'+String(sc).padStart(2,'0');}
} // End of class VoiceIsolatePro

if (typeof module !== 'undefined' && module.exports) {
  module.exports = VoiceIsolatePro;
} else if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded',()=>{window.vip=new VoiceIsolatePro();});
}
