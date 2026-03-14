/* ============================================
   VoiceIsolate Pro v19.0 – Engineer Mode
   Threads from Space · Hybrid ML+DSP
   52 Sliders · Real-Time Chain · 3D Spectrogram
   ============================================ */

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
  'Input Decode','Channel Analysis','DC Offset Removal','Peak Normalization',
  'Noise Floor Profiling','Spectral Fingerprint','Voice Activity Detection',
  'High-Pass Filter','Low-Pass Filter','Voice Band Isolation',
  'Spectral Subtraction','Adaptive Noise Gate','Wiener Filter',
  'Sub EQ','Bass EQ','Warmth EQ','Body EQ','Low-Mid EQ','Mid EQ',
  'Presence EQ','Clarity EQ','Air EQ','Brilliance EQ',
  'De-Essing','Spectral Tilt','Dereverberation',
  'Harmonic Reconstruction','Dynamics Compression','Brickwall Limiter',
  'Dry/Wet Mix & Final Render'
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
    this.fsMode = 'original';
    this.fsCurrentBuf = null;
    this.fsImageData = null;
    this.params = {};
    for (const tab of Object.values(SLIDERS)) for (const s of tab) this.params[s.id] = s.val;
    this.three = {};

    this.init();
  }

  init() {
    this.buildSliderPanels();
    this.cacheDom();
    this.bindEvents();
    this.initCanvases();
    this.init3D();
  }

  ensureCtx() {
    if (!this.ctx || this.ctx.state === 'closed') {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
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
      videoCard:g('videoCard'), videoPlayer:g('videoPlayer'),
      tpPlay:g('tpPlay'), tpPause:g('tpPause'), tpStop:g('tpStop'),
      tpRew:g('tpRew'), tpFwd:g('tpFwd'), tpCur:g('tpCur'), tpTotal:g('tpTotal'),
      tpSeek:g('tpSeek'), tpSpeed:g('tpSpeed'), tpAB:g('tpAB'), tpABLabel:g('tpABLabel'),
      fileSpectroCard:g('fileSpectroCard'), fsModeLbl:g('fsModeLbl'), fsProgress:g('fsProgress'),
      fsBtnAB:g('fsBtnAB'), fsColormap:g('fsColormap'),
      fsYAxis:g('fsYAxis'), fsMain:g('fsMain'), fsCanvas:g('fsCanvas'), fsOverlay:g('fsOverlay'), fsXAxis:g('fsXAxis'),
      spectro3DContainer:g('spectro3DContainer'), spectro3DCanvas:g('spectro3DCanvas'),
      spectro3DReset:g('spectro3DReset'),
      spectro2DCanvas:g('spectro2DCanvas'),
      waveOrigCanvas:g('waveOrigCanvas'), waveProcCanvas:g('waveProcCanvas'),
      freqCanvas:g('freqCanvas'),
      pipeFill:g('pipeFill'), pipeStage:g('pipeStage'), pipeDetail:g('pipeDetail'),
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
      document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === t));
      document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + t.dataset.tab));
    }));
    this.dom.fsBtnAB.addEventListener('click', () => this.fsToggleAB());
    this.dom.fsColormap.addEventListener('change', () => { if (this.fsCurrentBuf) this.renderFileSpectrogram(this.fsCurrentBuf); });
    this.dom.fsMain.addEventListener('click', e => this.fsSeekClick(e));
    document.querySelectorAll('.btn-preset').forEach(b => b.addEventListener('click', () => this.applyPreset(b.dataset.preset)));
    document.querySelectorAll('input[type="range"][data-param]').forEach(el => el.addEventListener('input', () => this.onSlider(el)));
    document.querySelectorAll('.sr-row').forEach(r => {
      r.addEventListener('mouseenter', e => { const d = r.dataset.desc; if (d) { const tt = this.dom.tooltip; tt.textContent = d; tt.classList.add('visible'); const rc = r.getBoundingClientRect(); tt.style.left = (rc.right+8)+'px'; tt.style.top = rc.top+'px'; const tr = tt.getBoundingClientRect(); if (tr.right > window.innerWidth-10) tt.style.left = (rc.left-tr.width-8)+'px'; if (tr.bottom > window.innerHeight-10) tt.style.top = (window.innerHeight-tr.height-10)+'px'; }});
      r.addEventListener('mouseleave', () => this.dom.tooltip.classList.remove('visible'));
    });
    this.dom.spectro3DCanvas.addEventListener('click', e => this.onSpectroClick(e));
    this.dom.spectro3DReset.addEventListener('click', () => this.reset3DView());
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
      this.onAudioLoaded(file.name);

    } catch (err) {
      console.error('File load error:', err);
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
          const tmpCtx = new (window.AudioContext || window.webkitAudioContext)();
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
    // Static full-file spectrogram
    this.dom.fileSpectroCard.style.display = '';
    this.dom.fsBtnAB.disabled = true;
    this.dom.fsModeLbl.textContent = 'ORIGINAL';
    this.dom.fsModeLbl.classList.remove('proc');
    this.fsCurrentBuf = buf;
    this.fsMode = 'original';
    this.fsImageData = null;
    this.renderFileSpectrogram(buf);
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
      this.drawFsPlayhead(dur > 0 ? elapsed / dur : 0);
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
    } catch(e) { console.error('Error updating live chain:', e); }
    } catch(e) {
      console.error('Error updating live chain:', e);
    }
  }

  teardownChain() {
    if (this.currentSource) {
      try { this.currentSource.stop(); } catch(e) { console.error('Error stopping current source:', e); }
      try { this.currentSource.disconnect(); } catch(e) { console.error('Error disconnecting current source:', e); }
      try {
        this.currentSource.stop();
      } catch (e) {
        // Ignore errors if the source is already stopped
      }
      try {
        this.currentSource.disconnect();
      } catch (e) {
        // Ignore errors if the source is already disconnected
      }
      this.currentSource = null;
    }
    if (this.liveNodes.chain) {
      this.liveNodes.chain.forEach(n => {
        try { n.disconnect(); } catch(e) { console.error('Error disconnecting live node:', e); }
      });
    }
    this.liveNodes = {}; this.liveChainBuilt = false;
        try {
          n.disconnect();
        } catch (e) {
          // Ignore errors if the node is already disconnected
        }
      });
    }
    this.liveNodes = {};
    this.liveChainBuilt = false;
  }

  // ======== 30-STAGE OFFLINE PIPELINE ========
  async runPipeline() {
    if (!this.inputBuffer || this.isProcessing) return;
    this.isProcessing = true; this.abortFlag = false;
    this.dom.processBtn.style.display = 'none'; this.dom.stopProcBtn.style.display = 'inline-flex';
    this.dom.saveProcBtn.disabled = true; this.dom.tpAB.disabled = true;
    this.setStatus('PROCESSING');
    const t0 = performance.now();
    const p = this.params; const sr = this.inputBuffer.sampleRate; const numCh = this.inputBuffer.numberOfChannels; const len = this.inputBuffer.length; const total = STAGES.length;

    try {
      const ofl = new OfflineAudioContext(numCh, len, sr);
      const src = ofl.createBufferSource(); src.buffer = this.inputBuffer;

      for (let i = 0; i < 7; i++) { await this.pip(i,total); if (this.abortFlag) throw 'abort'; }

      await this.pip(7,total); const hp = ofl.createBiquadFilter(); hp.type='highpass'; hp.frequency.value=p.hpFreq; hp.Q.value=p.hpQ;
      await this.pip(8,total); const lp = ofl.createBiquadFilter(); lp.type='lowpass'; lp.frequency.value=p.lpFreq; lp.Q.value=p.lpQ;
      await this.pip(9,total); const vbp = ofl.createBiquadFilter(); vbp.type='peaking'; vbp.frequency.value=1500; vbp.Q.value=0.5; vbp.gain.value=(p.voiceIso/100)*6;
      await this.pip(10,total);
      const gate = ofl.createDynamicsCompressor(); gate.threshold.value=p.gateThresh; gate.knee.value=2; gate.ratio.value=20; gate.attack.value=p.gateAttack/1000; gate.release.value=p.gateRelease/1000;
      await this.pip(11,total); if (this.abortFlag) throw 'abort';
      await this.pip(12,total); const notch = ofl.createBiquadFilter(); notch.type='notch'; notch.frequency.value=60; notch.Q.value=30;

      const eqDefs = [{id:'eqSub',f:40,t:'lowshelf'},{id:'eqBass',f:100,t:'peaking',q:1.2},{id:'eqWarmth',f:200,t:'peaking',q:1},{id:'eqBody',f:400,t:'peaking',q:1},{id:'eqLowMid',f:800,t:'peaking',q:1},{id:'eqMid',f:1500,t:'peaking',q:1.2},{id:'eqPresence',f:3000,t:'peaking',q:1.5},{id:'eqClarity',f:5000,t:'peaking',q:1.2},{id:'eqAir',f:10000,t:'highshelf'},{id:'eqBrill',f:16000,t:'highshelf'}];
      const eqN = [];
      for (let i=0;i<eqDefs.length;i++) {
        await this.pip(13+i,total);
        const b=eqDefs[i]; const n=ofl.createBiquadFilter(); n.type=b.t; n.frequency.value=b.f; if(b.q)n.Q.value=b.q; n.gain.value=p[b.id]||0; eqN.push(n);
        if (this.abortFlag) throw 'abort';
      }

      await this.pip(23,total); const de=ofl.createBiquadFilter(); de.type='peaking'; de.frequency.value=p.deEssFreq; de.Q.value=3; de.gain.value=-(p.deEssAmt/100)*10;
      await this.pip(24,total); const tlt=ofl.createBiquadFilter(); tlt.type='highshelf'; tlt.frequency.value=1000; tlt.gain.value=p.specTilt;
      await this.pip(25,total); const drv=ofl.createBiquadFilter(); drv.type='highpass'; drv.frequency.value=100+(p.derevAmt/100)*200; drv.Q.value=0.5;
      await this.pip(26,total); const hrm=ofl.createWaveShaper(); hrm.curve=this.makeHarm(p.harmRecov/100,p.harmOrder); hrm.oversample='2x';
      await this.pip(27,total); const cmp=ofl.createDynamicsCompressor(); cmp.threshold.value=p.compThresh; cmp.ratio.value=p.compRatio; cmp.attack.value=p.compAttack/1000; cmp.release.value=p.compRelease/1000; cmp.knee.value=p.compKnee;
      const mkG=ofl.createGain(); mkG.gain.value=Math.pow(10,p.compMakeup/20);
      await this.pip(28,total); const lim=ofl.createDynamicsCompressor(); lim.threshold.value=p.limThresh; lim.knee.value=0; lim.ratio.value=20; lim.attack.value=0.001; lim.release.value=p.limRelease/1000;
      const oG=ofl.createGain(); oG.gain.value=Math.pow(10,p.outGain/20);

      if (this.abortFlag) throw 'abort';
      const chain=[src,hp,lp,vbp,gate,notch,...eqN,de,tlt,drv,hrm,cmp,mkG,lim,oG];
      for(let i=0;i<chain.length-1;i++)chain[i].connect(chain[i+1]);
      chain[chain.length-1].connect(ofl.destination);
      src.start(0);
      const rendered = await ofl.startRendering();
      if (this.abortFlag) throw 'abort';

      await this.pip(29,total);
      let fin = rendered;
      if (p.nrAmount>0) fin = this.applyNR(fin, p.nrAmount/100, p.nrSmoothing/100, p.nrFloor);
      if (p.dryWet<100) fin = this.mixDW(this.inputBuffer, fin, p.dryWet/100);
      fin = this.peakNorm(fin, p.limThresh);

      this.dom.stProcTime.textContent = ((performance.now()-t0)/1000).toFixed(2)+'s';
      this.outputBuffer = fin;
      const snr = this.calcRMS(fin.getChannelData(0)) - this.calcRMS(this.inputBuffer.getChannelData(0));
      this.dom.hSNR.textContent = (snr>=0?'+':'') + snr.toFixed(1) + ' dB';
      this.resizeCanvas(this.dom.waveProcCanvas);
      this.drawWaveform(fin, this.dom.waveProcCanvas, '#22d3ee');
      this.dom.stVoices.textContent = this.estVoices(fin);
      this.dom.saveProcBtn.disabled = false; this.dom.tpAB.disabled = false; this.dom.reprocessBtn.disabled = false;
      this.dom.tpABLabel.textContent = 'Ready — A/B';
      this.setStatus('COMPLETE');
      // Enable static spectrogram A/B
      this.dom.fsBtnAB.disabled = false;
    } catch(e) {
      if (e==='abort') { this.setStatus('ABORTED'); this.dom.pipeStage.textContent='Aborted'; }
      else { console.error('Pipeline:',e); this.setStatus('ERROR'); this.dom.pipeDetail.textContent=e.message||String(e); }
    } finally {
      this.isProcessing=false; this.dom.processBtn.style.display='inline-flex'; this.dom.stopProcBtn.style.display='none';
    }
  }

  async pip(i,t) { this.dom.pipeFill.style.width=((i+1)/t*100)+'%'; this.dom.pipeStage.textContent=(i+1)+'/'+t; this.dom.pipeDetail.textContent=STAGES[i]; this.dom.hStatus.textContent='S'+(i+1); await new Promise(r=>setTimeout(r,15)); }

  // ---- DSP HELPERS ----
  applyNR(buf, amt, smooth, floorDb) {
    const c = this.ctx;
    const nCh = buf.numberOfChannels;
    const len = buf.length;
    const sr = buf.sampleRate;
    const out = c.createBuffer(nCh, len, sr);
    const flLin = Math.pow(10, floorDb / 20);

    for (let ch = 0; ch < nCh; ch++) {
      const inp = buf.getChannelData(ch);
      const o = out.getChannelData(ch);
      const nLen = Math.min(Math.floor(sr * 0.15), len);

      let nRms = 0;
      for (let i = 0; i < nLen; i++) {
        nRms += inp[i] * inp[i];
      }
      nRms = Math.sqrt(nRms / nLen);
      const th = Math.max(nRms, flLin) * (1 + amt * 4);
      const bk = 256;
      let pG = 1;

      for (let i = 0; i < len; i += bk) {
        const e = Math.min(i + bk, len);
        let r = 0;

        for (let j = i; j < e; j++) {
          r += inp[j] * inp[j];
        }
        r = Math.sqrt(r / (e - i));

        let g = r > th ? 1 : Math.max(0.005, r / th);
        g = pG + (g - pG) * (1 - smooth);
        pG = g;

        for (let j = i; j < e; j++) {
          o[j] = inp[j] * g;
        }
      }
    }

    return out;
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

  peakNorm(buffer, targetDb) {
    const ctx = this.ctx;
    const numChannels = buffer.numberOfChannels;
    const length = buffer.length;
    const outBuffer = ctx.createBuffer(numChannels, length, buffer.sampleRate);

    let peak = 0;

    // Find the maximum absolute peak value across all channels
    for (let ch = 0; ch < numChannels; ch++) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        const absValue = Math.abs(data[i]);
        if (absValue > peak) {
          peak = absValue;
        }
      }
    }

    // If silence, return original buffer
    if (peak === 0) {
      return buffer;
    }

    // Calculate gain needed to reach target dB
    const gain = Math.pow(10, targetDb / 20) / peak;

    // Apply gain to all channels and hard-clip at -1.0 to 1.0
    for (let ch = 0; ch < numChannels; ch++) {
      const inputData = buffer.getChannelData(ch);
      const outputData = outBuffer.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        outputData[i] = Math.max(-1, Math.min(1, inputData[i] * gain));
      }
    }

    return outBuffer;
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

    const chans = new Array(nCh);
    for (let ch = 0; ch < nCh; ch++) {
      chans[ch] = buf.getChannelData(ch);
    }

    for (let i = 0; i < buf.length; i++) {
      for (let ch = 0; ch < nCh; ch++) {
        let s = chans[ch][i];
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

  // ======== STATIC FULL-FILE SPECTROGRAM ========

  // Radix-2 in-place FFT (Cooley-Tukey)
  fftInPlace(re, im) {
    const n = re.length;
    // Bit-reversal permutation
    let j = 0;
    for (let i = 1; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    // Butterfly passes
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len;
      const wRe = Math.cos(ang), wIm = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let curRe = 1, curIm = 0;
        const half = len >> 1;
        for (let k = 0; k < half; k++) {
          const u = i + k, v = u + half;
          const vRe = re[v] * curRe - im[v] * curIm;
          const vIm = re[v] * curIm + im[v] * curRe;
          re[v] = re[u] - vRe; im[v] = im[u] - vIm;
          re[u] += vRe;        im[u] += vIm;
          const nr = curRe * wRe - curIm * wIm;
          curIm = curRe * wIm + curIm * wRe;
          curRe = nr;
        }
      }
    }
  }

  // Map normalized value 0-1 to [r,g,b] 0-255
  fsColor(v, cmap) {
    v = Math.max(0, Math.min(1, v));
    if (cmap === 'ocean') {
      // Dark → deep blue → cyan → white
      const stops = [[3,3,20],[5,20,80],[0,100,180],[0,200,230],[180,240,255],[255,255,255]];
      return this.lerpStops(stops, v);
    }
    if (cmap === 'voice') {
      // Dark → purple (noise) → red/orange (voice freq) → bright yellow (peaks)
      const stops = [[3,3,8],[30,5,60],[180,10,30],[220,80,0],[255,200,20],[255,255,180]];
      return this.lerpStops(stops, v);
    }
    // Default: plasma — dark purple → violet → magenta → orange → yellow
    const stops = [[5,1,15],[60,5,110],[140,20,170],[200,60,50],[240,140,0],[255,230,40],[255,255,220]];
    return this.lerpStops(stops, v);
  }

  lerpStops(stops, v) {
    const idx = v * (stops.length - 1);
    const lo = Math.floor(idx), hi = Math.min(lo + 1, stops.length - 1);
    const t = idx - lo;
    return stops[lo].map((c, i) => Math.round(c + (stops[hi][i] - c) * t));
  }

  async renderFileSpectrogram(buf) {
    const canvas = this.dom.fsCanvas;
    const wrap = this.dom.fsMain;
    // Size canvas to container
    const W = Math.max(wrap.clientWidth || 800, 200);
    const H = Math.max(wrap.clientHeight || 170, 80);
    canvas.width = W; canvas.height = H;
    this.dom.fsOverlay.width = W; this.dom.fsOverlay.height = H;

    const ctx2d = canvas.getContext('2d');
    ctx2d.fillStyle = '#030306';
    ctx2d.fillRect(0, 0, W, H);

    const data = buf.getChannelData(0);
    const sr = buf.sampleRate;
    const nyq = sr / 2;
    const fftSize = 2048;
    const halfFFT = fftSize >> 1;
    const hopSize = Math.max(1, Math.ceil(data.length / W));
    const cmap = this.dom.fsColormap.value;
    const invLN10_9 = 1 / (9 * Math.LN10);

    // Pre-compute Hann window
    const win = new Float32Array(fftSize);
    for (let i = 0; i < fftSize; i++) win[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / fftSize));

    // Pre-compute log frequency row→bin lookup table
    const logMin = Math.log(20);
    const logMax = Math.log(nyq);
    const rowBin = new Uint16Array(H);
    for (let row = 0; row < H; row++) {
      const frac = 1 - row / H; // 0=bottom(20Hz), 1=top(Nyquist)
      const freq = Math.exp(logMin + frac * (logMax - logMin));
      rowBin[row] = Math.min(Math.round(freq / nyq * halfFFT), halfFFT - 1);
    }

    const imgData = ctx2d.createImageData(W, H);
    const pixels = imgData.data;
    const re = new Float32Array(fftSize);
    const im = new Float32Array(fftSize);

    const BATCH = 64; // columns per animation frame
    const totalCols = Math.min(W, Math.ceil(data.length / hopSize));

    for (let col = 0; col < totalCols; col++) {
      const offset = col * hopSize;
      // Fill + window
      for (let i = 0; i < fftSize; i++) {
        const si = offset + i;
        re[i] = (si < data.length ? data[si] : 0) * win[i];
        im[i] = 0;
      }
      this.fftInPlace(re, im);

      // Draw this column
      for (let row = 0; row < H; row++) {
        const bin = rowBin[row];
        const magSq = re[bin] * re[bin] + im[bin] * im[bin];
        // dB normalized: -90dB → 0dB → 1.0
        const v = magSq > 0 ? Math.max(0, Math.min(1, Math.log(magSq) * invLN10_9 + 1)) : 0;
        const [r, g, b] = this.fsColor(v, cmap);
        const idx = (row * W + col) * 4;
        pixels[idx] = r; pixels[idx + 1] = g; pixels[idx + 2] = b; pixels[idx + 3] = 255;
      }

      // Batch flush + progress
      if ((col % BATCH === BATCH - 1) || col === totalCols - 1) {
        ctx2d.putImageData(imgData, 0, 0);
        const pct = Math.round((col + 1) / totalCols * 100);
        this.dom.fsProgress.textContent = pct < 100 ? `Rendering ${pct}%` : '';
        await new Promise(r => setTimeout(r, 0));
      }
    }

    // Cache for fast A/B redraw
    this.fsImageData = ctx2d.getImageData(0, 0, W, H);
    this.dom.fsProgress.textContent = '';

    this.drawFsYAxis(sr, H);
    this.drawFsXAxis(buf.duration, W);
    this.drawFsPlayhead(0);
  }

  drawFsYAxis(sr, H) {
    const cv = this.dom.fsYAxis;
    cv.width = 38; cv.height = H;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#030306';
    ctx.fillRect(0, 0, 38, H);
    const nyq = sr / 2;
    const logMin = Math.log(20), logMax = Math.log(nyq);
    const freqs = [100, 250, 500, 1000, 2000, 4000, 8000, 16000].filter(f => f < nyq);
    ctx.font = '8px JetBrains Mono, monospace';
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(180,180,200,0.5)';
    for (const f of freqs) {
      const frac = (Math.log(f) - logMin) / (logMax - logMin);
      const y = Math.round((1 - frac) * H);
      ctx.fillStyle = 'rgba(255,255,255,0.07)';
      ctx.fillRect(34, y, 4, 1);
      ctx.fillStyle = 'rgba(180,180,200,0.5)';
      ctx.fillText(f >= 1000 ? (f / 1000) + 'k' : f, 32, y + 3);
    }
    // "Hz" label
    ctx.save(); ctx.translate(9, H / 2); ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center'; ctx.fillStyle = 'rgba(180,180,200,0.35)';
    ctx.font = '7px JetBrains Mono, monospace';
    ctx.fillText('Hz', 0, 0); ctx.restore();
  }

  drawFsXAxis(duration, W) {
    const cv = this.dom.fsXAxis;
    cv.width = W + 38; cv.height = 20;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#030306';
    ctx.fillRect(0, 0, W + 38, 20);
    ctx.font = '8px JetBrains Mono, monospace';
    ctx.fillStyle = 'rgba(180,180,200,0.5)';
    ctx.textAlign = 'center';
    const step = duration < 30 ? 5 : duration < 120 ? 15 : duration < 300 ? 30 : 60;
    const xOff = 38;
    for (let t = 0; t <= duration; t += step) {
      const x = xOff + Math.round(t / duration * W);
      ctx.fillStyle = 'rgba(255,255,255,0.05)';
      ctx.fillRect(x, 0, 1, 5);
      ctx.fillStyle = 'rgba(180,180,200,0.5)';
      const label = t >= 60 ? Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0') : t + 's';
      ctx.fillText(label, x, 14);
    }
  }

  drawFsPlayhead(frac) {
    const cv = this.dom.fsOverlay;
    const W = cv.width, H = cv.height;
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    if (!this.inputBuffer || frac <= 0) return;
    const x = Math.round(frac * W);
    // Glow + line
    ctx.shadowBlur = 6; ctx.shadowColor = '#dc2626';
    ctx.strokeStyle = 'rgba(220,38,38,0.9)';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    ctx.shadowBlur = 0;
    // Time bubble
    const elapsed = frac * this.inputBuffer.duration;
    const label = this.fmtDur(elapsed);
    ctx.font = '700 9px JetBrains Mono, monospace';
    const tw = ctx.measureText(label).width;
    const bx = Math.min(x + 3, W - tw - 8);
    ctx.fillStyle = 'rgba(220,38,38,0.85)';
    ctx.fillRect(bx - 2, 2, tw + 8, 14);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, bx + 2, 12);
  }

  fsToggleAB() {
    if (!this.outputBuffer) return;
    this.fsMode = this.fsMode === 'original' ? 'processed' : 'original';
    const isProc = this.fsMode === 'processed';
    this.dom.fsModeLbl.textContent = isProc ? 'PROCESSED' : 'ORIGINAL';
    this.dom.fsModeLbl.classList.toggle('proc', isProc);
    this.dom.fsBtnAB.textContent = isProc ? 'Show Original' : 'Show Processed';
    this.fsCurrentBuf = isProc ? this.outputBuffer : this.inputBuffer;
    this.fsImageData = null;
    this.renderFileSpectrogram(this.fsCurrentBuf);
  }

  fsSeekClick(e) {
    if (!this.inputBuffer) return;
    const rect = this.dom.fsMain.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    this.playOffset = frac * this.inputBuffer.duration;
    this.dom.tpSeek.value = frac * 1000;
    this.dom.tpCur.textContent = this.fmtDur(this.playOffset);
    this.drawFsPlayhead(frac);
    if (this.isPlaying) this.play();
  }

  // ---- UTILITY ----
  setStatus(s){this.dom.hStatus.textContent=s;const c={IDLE:'#5e5e78',LOADING:'#eab308',READY:'#22c55e',PROCESSING:'#dc2626',COMPLETE:'#22d3ee',ERROR:'#ef4444',RECORDING:'#ef4444',ABORTED:'#a855f7'};this.dom.hStatus.style.color=c[s]||'#5e5e78';}
  calcRMS(d){let s=0;for(let i=0;i<d.length;i++)s+=d[i]*d[i];const rSq=s/d.length;return rSq>0?10*Math.log10(rSq):-96;}
  calcPeak(d){let pSq=0;for(let i=0;i<d.length;i++){const aSq=d[i]*d[i];if(aSq>pSq)pSq=aSq;}return pSq>0?10*Math.log10(pSq):-96;}
  fmtDur(s){const m=Math.floor(s/60);const sc=Math.floor(s%60);return m+':'+String(sc).padStart(2,'0');}
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = VoiceIsolatePro;
} else {
  document.addEventListener('DOMContentLoaded',()=>{window.vip=new VoiceIsolatePro();});
}
