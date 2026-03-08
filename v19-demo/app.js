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
    { id:'gateAttack', label:'Attack', min:0.1, max:50, val:2, step:0.1, unit:' ms', rt:true, desc:'How fast the gate opens when signal exceeds threshold.' },
    { id:'gateRelease', label:'Release', min:5, max:500, val:80, step:1, unit:' ms', rt:true, desc:'How fast the gate closes after signal drops below threshold.' },
    { id:'gateHold', label:'Hold', min:0, max:200, val:20, step:1, unit:' ms', rt:false, desc:'Minimum time gate stays open after triggering. Prevents rapid flutter.' },
    { id:'gateLookahead', label:'Lookahead', min:0, max:20, val:5, step:0.5, unit:' ms', rt:false, desc:'Pre-delay allowing the gate to open before transients arrive.' },
  ],
  nr: [
    { id:'nrAmount', label:'Reduction Amount', min:0, max:100, val:55, step:1, unit:'%', rt:false, desc:'How much noise is removed. 40-60% is usually optimal.' },
    { id:'nrSensitivity', label:'Sensitivity', min:0, max:100, val:50, step:1, unit:'%', rt:false, desc:'How aggressively noise is detected. Higher may eat voice edges.' },
    { id:'nrSpectralSub', label:'Spectral Subtract', min:0, max:100, val:40, step:1, unit:'%', rt:false, desc:'Subtracts estimated noise spectrum from signal.' },
    { id:'nrFloor', label:'Noise Floor', min:-80, max:-20, val:-60, step:1, unit:' dB', rt:false, desc:'Estimated noise floor level. Audio below this is treated as noise.' },
    { id:'nrSmoothing', label:'Smoothing', min:0, max:100, val:35, step:1, unit:'%', rt:false, desc:'Temporal smoothing of noise estimate. Prevents musical noise artifacts.' },
  ],
  eq: [
    { id:'eqSub', label:'Sub (40 Hz)', min:-12, max:6, val:-8, step:0.5, unit:' dB', rt:true, desc:'Sub-bass. Cut to remove rumble, HVAC noise, mic handling.' },
    { id:'eqBass', label:'Bass (100 Hz)', min:-8, max:8, val:0, step:0.5, unit:' dB', rt:true, desc:'Low bass. Boost for warmth, cut to reduce boominess.' },
    { id:'eqWarmth', label:'Warmth (200 Hz)', min:-6, max:6, val:1, step:0.5, unit:' dB', rt:true, desc:'Lower midrange warmth. Gives body to the voice.' },
    { id:'eqBody', label:'Body (400 Hz)', min:-6, max:6, val:0, step:0.5, unit:' dB', rt:true, desc:'Core body of the voice. Cut reduces boxiness in room recordings.' },
    { id:'eqLowMid', label:'Low-Mid (800 Hz)', min:-6, max:6, val:-1, step:0.5, unit:' dB', rt:true, desc:'Nasal/honky frequencies. Slight cut often helps clarity.' },
    { id:'eqMid', label:'Mid (1.5 kHz)', min:-6, max:6, val:1, step:0.5, unit:' dB', rt:true, desc:'Core intelligibility. Most critical band for speech comprehension.' },
    { id:'eqPresence', label:'Presence (3 kHz)', min:-6, max:8, val:3, step:0.5, unit:' dB', rt:true, desc:'Vocal presence and forward projection.' },
    { id:'eqClarity', label:'Clarity (5 kHz)', min:-6, max:6, val:2, step:0.5, unit:' dB', rt:true, desc:'Consonant definition. Helps speech cut through background.' },
    { id:'eqAir', label:'Air (10 kHz)', min:-6, max:6, val:1, step:0.5, unit:' dB', rt:true, desc:'High-frequency sparkle and openness.' },
    { id:'eqBrill', label:'Brilliance (16 kHz)', min:-8, max:4, val:-2, step:0.5, unit:' dB', rt:true, desc:'Ultra-high. Usually cut for noise reduction.' },
  ],
  dyn: [
    { id:'compThresh', label:'Comp Threshold', min:-50, max:0, val:-24, step:1, unit:' dB', rt:true, desc:'Level above which compression begins. -24dB is moderate.' },
    { id:'compRatio', label:'Comp Ratio', min:1, max:20, val:4, step:0.5, unit:':1', rt:true, desc:'Compression ratio. 2:1=gentle, 4:1=moderate, 10:1+=limiting.' },
    { id:'compAttack', label:'Comp Attack', min:0, max:100, val:8, step:1, unit:' ms', rt:true, desc:'How fast compressor reacts. Short=catches transients.' },
    { id:'compRelease', label:'Comp Release', min:10, max:1000, val:200, step:5, unit:' ms', rt:true, desc:'How fast compressor lets go. Too fast=pumping artifacts.' },
    { id:'compKnee', label:'Comp Knee', min:0, max:30, val:6, step:1, unit:' dB', rt:true, desc:'0=hard knee (abrupt), 30=very soft (gradual). 6dB is natural.' },
    { id:'compMakeup', label:'Makeup Gain', min:0, max:24, val:6, step:0.5, unit:' dB', rt:true, desc:'Gain added after compression to restore loudness.' },
    { id:'limThresh', label:'Limiter Ceiling', min:-6, max:0, val:-1, step:0.1, unit:' dB', rt:true, desc:'Brickwall ceiling. No signal passes above this.' },
    { id:'limRelease', label:'Limiter Release', min:1, max:100, val:10, step:1, unit:' ms', rt:true, desc:'How fast limiter recovers.' },
  ],
  spec: [
    { id:'hpFreq', label:'High-Pass Freq', min:20, max:500, val:80, step:1, unit:' Hz', rt:true, desc:'Removes everything below. 80Hz standard for voice.' },
    { id:'hpQ', label:'HP Resonance', min:0.5, max:5, val:0.707, step:0.01, unit:' Q', rt:true, desc:'Filter steepness. 0.707=Butterworth (flat).' },
    { id:'lpFreq', label:'Low-Pass Freq', min:3000, max:20000, val:14000, step:100, unit:' Hz', rt:true, desc:'Removes everything above. 12kHz for noise, 20kHz full.' },
    { id:'lpQ', label:'LP Resonance', min:0.5, max:5, val:0.707, step:0.01, unit:' Q', rt:true, desc:'Low-pass filter resonance. 0.707 for transparent rolloff.' },
    { id:'deEssFreq', label:'De-Ess Center', min:4000, max:10000, val:7000, step:100, unit:' Hz', rt:true, desc:'Sibilance reduction center. 6-8kHz for most voices.' },
    { id:'deEssAmt', label:'De-Ess Amount', min:0, max:100, val:30, step:1, unit:'%', rt:true, desc:'How much sibilance is reduced. 20-40% for natural.' },
    { id:'specTilt', label:'Spectral Tilt', min:-6, max:6, val:0, step:0.5, unit:' dB/oct', rt:true, desc:'Overall slope. Positive=brighter, Negative=darker.' },
    { id:'formantShift', label:'Formant Shift', min:-12, max:12, val:0, step:0.5, unit:' semi', rt:false, desc:'Shifts vocal formants without changing pitch.' },
  ],
  adv: [
    { id:'derevAmt', label:'Dereverb Amount', min:0, max:100, val:40, step:1, unit:'%', rt:false, desc:'Removes room reverb/echo. Higher=drier sound.' },
    { id:'derevDecay', label:'Dereverb Decay', min:0.1, max:3, val:0.5, step:0.1, unit:' s', rt:false, desc:'Estimated room reverb decay time.' },
    { id:'harmRecov', label:'Harmonic Recovery', min:0, max:100, val:20, step:1, unit:'%', rt:false, desc:'Regenerates harmonics lost in noise reduction via soft saturation.' },
    { id:'harmOrder', label:'Harmonic Order', min:2, max:8, val:3, step:1, unit:'x', rt:false, desc:'Which harmonics to regenerate. 2=octave, 3=fifth.' },
    { id:'stereoWidth', label:'Stereo Width', min:0, max:200, val:100, step:1, unit:'%', rt:true, desc:'0%=mono, 100%=original, 200%=extra wide.' },
    { id:'phaseCorr', label:'Phase Correction', min:0, max:100, val:0, step:1, unit:'%', rt:false, desc:'Corrects phase issues between stereo channels.' },
  ],
  sep: [
    { id:'voiceIso', label:'Voice Isolation', min:0, max:100, val:70, step:1, unit:'%', rt:false, desc:'Strength of voice/non-voice separation.' },
    { id:'bgSuppress', label:'Background Suppress', min:0, max:100, val:50, step:1, unit:'%', rt:false, desc:'Attenuation of non-voice background sounds.' },
    { id:'voiceFocusLo', label:'Voice Focus Low', min:80, max:500, val:120, step:5, unit:' Hz', rt:true, desc:'Lower bound of voice focus. Male ~85Hz, Female ~165Hz.' },
    { id:'voiceFocusHi', label:'Voice Focus High', min:2000, max:12000, val:6000, step:100, unit:' Hz', rt:true, desc:'Upper bound of voice focus. Speech extends to ~8kHz.' },
    { id:'crosstalkCancel', label:'Crosstalk Cancel', min:0, max:100, val:0, step:1, unit:'%', rt:false, desc:'Reduces bleed between speakers in multi-person recordings.' },
  ],
  out: [
    { id:'outGain', label:'Output Gain', min:-18, max:18, val:0, step:0.5, unit:' dB', rt:true, desc:'Final output level adjustment.' },
    { id:'dryWet', label:'Dry/Wet Mix', min:0, max:100, val:100, step:1, unit:'%', rt:false, desc:'0%=original only, 100%=fully processed.' },
    { id:'ditherAmt', label:'Dither', min:0, max:100, val:0, step:1, unit:'%', rt:false, desc:'Shaped noise before bit-depth reduction.' },
    { id:'outWidth', label:'Output Width', min:0, max:200, val:100, step:1, unit:'%', rt:true, desc:'Final stereo width. Applied after all processing.' },
  ]
};

// ---- PRESETS ----
const PRESETS = {
  podcast:{gateThresh:-38,gateRange:-35,gateAttack:2,gateRelease:60,gateHold:15,gateLookahead:5,nrAmount:60,nrSensitivity:55,nrSpectralSub:45,nrFloor:-55,nrSmoothing:40,eqSub:-10,eqBass:-1,eqWarmth:2,eqBody:0,eqLowMid:-1,eqMid:1,eqPresence:4,eqClarity:2,eqAir:1,eqBrill:-3,compThresh:-20,compRatio:5,compAttack:6,compRelease:180,compKnee:6,compMakeup:8,limThresh:-1,limRelease:8,hpFreq:80,hpQ:0.707,lpFreq:14000,lpQ:0.707,deEssFreq:7000,deEssAmt:40,specTilt:0.5,formantShift:0,derevAmt:50,derevDecay:0.4,harmRecov:15,harmOrder:3,stereoWidth:100,phaseCorr:0,voiceIso:80,bgSuppress:60,voiceFocusLo:120,voiceFocusHi:6000,crosstalkCancel:0,outGain:0,dryWet:100,ditherAmt:0,outWidth:100},
  film:{gateThresh:-50,gateRange:-30,gateAttack:3,gateRelease:100,gateHold:25,gateLookahead:5,nrAmount:40,nrSensitivity:45,nrSpectralSub:30,nrFloor:-60,nrSmoothing:40,eqSub:-6,eqBass:1,eqWarmth:1,eqBody:1,eqLowMid:0,eqMid:0,eqPresence:2,eqClarity:1,eqAir:2,eqBrill:-1,compThresh:-28,compRatio:3,compAttack:12,compRelease:300,compKnee:10,compMakeup:4,limThresh:-1,limRelease:15,hpFreq:60,hpQ:0.707,lpFreq:16000,lpQ:0.707,deEssFreq:6500,deEssAmt:20,specTilt:-0.5,formantShift:0,derevAmt:30,derevDecay:0.6,harmRecov:25,harmOrder:3,stereoWidth:120,phaseCorr:0,voiceIso:60,bgSuppress:40,voiceFocusLo:100,voiceFocusHi:8000,crosstalkCancel:0,outGain:0,dryWet:100,ditherAmt:0,outWidth:110},
  interview:{gateThresh:-42,gateRange:-38,gateAttack:2,gateRelease:80,gateHold:20,gateLookahead:5,nrAmount:55,nrSensitivity:50,nrSpectralSub:40,nrFloor:-58,nrSmoothing:35,eqSub:-8,eqBass:0,eqWarmth:1,eqBody:0,eqLowMid:-1,eqMid:1,eqPresence:3,eqClarity:2,eqAir:1,eqBrill:-2,compThresh:-22,compRatio:5,compAttack:5,compRelease:200,compKnee:6,compMakeup:6,limThresh:-1,limRelease:10,hpFreq:100,hpQ:0.707,lpFreq:12000,lpQ:0.707,deEssFreq:7000,deEssAmt:35,specTilt:0,formantShift:0,derevAmt:45,derevDecay:0.5,harmRecov:20,harmOrder:3,stereoWidth:80,phaseCorr:0,voiceIso:75,bgSuppress:55,voiceFocusLo:120,voiceFocusHi:6000,crosstalkCancel:20,outGain:0,dryWet:100,ditherAmt:0,outWidth:90},
  forensic:{gateThresh:-65,gateRange:-20,gateAttack:1,gateRelease:150,gateHold:30,gateLookahead:10,nrAmount:30,nrSensitivity:60,nrSpectralSub:20,nrFloor:-70,nrSmoothing:50,eqSub:-2,eqBass:0,eqWarmth:0,eqBody:0,eqLowMid:0,eqMid:2,eqPresence:5,eqClarity:4,eqAir:3,eqBrill:0,compThresh:-18,compRatio:2,compAttack:15,compRelease:400,compKnee:12,compMakeup:10,limThresh:-0.5,limRelease:20,hpFreq:50,hpQ:0.707,lpFreq:18000,lpQ:0.707,deEssFreq:8000,deEssAmt:10,specTilt:1,formantShift:0,derevAmt:20,derevDecay:0.8,harmRecov:35,harmOrder:4,stereoWidth:100,phaseCorr:30,voiceIso:90,bgSuppress:30,voiceFocusLo:80,voiceFocusHi:10000,crosstalkCancel:0,outGain:3,dryWet:90,ditherAmt:0,outWidth:100},
  music:{gateThresh:-55,gateRange:-25,gateAttack:3,gateRelease:120,gateHold:15,gateLookahead:3,nrAmount:25,nrSensitivity:40,nrSpectralSub:20,nrFloor:-65,nrSmoothing:45,eqSub:-3,eqBass:1,eqWarmth:2,eqBody:1,eqLowMid:0,eqMid:0,eqPresence:2,eqClarity:1,eqAir:3,eqBrill:0,compThresh:-30,compRatio:2,compAttack:20,compRelease:350,compKnee:15,compMakeup:3,limThresh:-0.5,limRelease:12,hpFreq:40,hpQ:0.707,lpFreq:20000,lpQ:0.707,deEssFreq:7500,deEssAmt:15,specTilt:-1,formantShift:0,derevAmt:15,derevDecay:1.0,harmRecov:30,harmOrder:4,stereoWidth:150,phaseCorr:0,voiceIso:50,bgSuppress:25,voiceFocusLo:80,voiceFocusHi:10000,crosstalkCancel:0,outGain:0,dryWet:85,ditherAmt:5,outWidth:140},
  broadcast:{gateThresh:-35,gateRange:-40,gateAttack:1.5,gateRelease:50,gateHold:10,gateLookahead:3,nrAmount:65,nrSensitivity:60,nrSpectralSub:50,nrFloor:-50,nrSmoothing:30,eqSub:-12,eqBass:-2,eqWarmth:2,eqBody:0,eqLowMid:-2,eqMid:2,eqPresence:5,eqClarity:3,eqAir:1,eqBrill:-4,compThresh:-18,compRatio:6,compAttack:4,compRelease:150,compKnee:4,compMakeup:10,limThresh:-1,limRelease:5,hpFreq:120,hpQ:0.707,lpFreq:12000,lpQ:0.707,deEssFreq:7000,deEssAmt:45,specTilt:1,formantShift:0,derevAmt:55,derevDecay:0.3,harmRecov:10,harmOrder:2,stereoWidth:60,phaseCorr:0,voiceIso:85,bgSuppress:70,voiceFocusLo:150,voiceFocusHi:5000,crosstalkCancel:0,outGain:0,dryWet:100,ditherAmt:0,outWidth:70},
  restoration:{gateThresh:-60,gateRange:-15,gateAttack:5,gateRelease:200,gateHold:40,gateLookahead:10,nrAmount:45,nrSensitivity:55,nrSpectralSub:35,nrFloor:-65,nrSmoothing:50,eqSub:-4,eqBass:0,eqWarmth:0,eqBody:0,eqLowMid:0,eqMid:1,eqPresence:3,eqClarity:2,eqAir:1,eqBrill:-1,compThresh:-26,compRatio:3,compAttack:10,compRelease:250,compKnee:8,compMakeup:5,limThresh:-0.5,limRelease:15,hpFreq:50,hpQ:0.707,lpFreq:16000,lpQ:0.707,deEssFreq:6500,deEssAmt:20,specTilt:0,formantShift:0,derevAmt:35,derevDecay:0.7,harmRecov:40,harmOrder:4,stereoWidth:100,phaseCorr:20,voiceIso:65,bgSuppress:45,voiceFocusLo:100,voiceFocusHi:8000,crosstalkCancel:10,outGain:2,dryWet:95,ditherAmt:5,outWidth:100}
};

const STAGES = [
  'Input Decode','Channel Analysis','DC Offset Removal','Peak Normalization',
  'Noise Floor Profiling','Spectral Fingerprint','Voice Activity Detection',
  'High-Pass Filter','Low-Pass Filter','Voice Band Isolation',
  'Spectral Subtraction','Adaptive Noise Gate','Wiener Filter',
  'Sub EQ','Bass EQ','Warmth EQ','Body EQ','Low-Mid EQ','Mid EQ',
  'Presence EQ','Clarity EQ','Air EQ','Brilliance EQ',
  'De-Essing','Spectral Tilt','Dereverberation',
  'Harmonic Recovery','Dynamics Compression','Brickwall Limiter',
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
    this.videoURL = null;
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
    for (const tab of Object.values(SLIDERS))
      for (const s of tab) this.params[s.id] = s.val;
    this.three = {};
    this.init();
  }

  init() {
    this.buildSliders();
    this.cacheDom();
    this.bindAll();
    this.initCanvases();
    this.init3D();
  }

  // ---- FIX #3: Lazy AudioContext on user gesture ----
  ensureCtx() {
    if (!this.ctx || this.ctx.state === 'closed') {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  // ---- BUILD SLIDERS ----
  buildSliders() {
    for (const [key, sliders] of Object.entries(SLIDERS)) {
      const panel = document.getElementById('tab-' + key);
      if (!panel) continue;
      let h = '<div class="sr">';
      for (const s of sliders) {
        const rtCls = s.rt ? ' realtime' : '';
        const rtBadge = s.rt ? '<span class="rt-badge">RT</span>' : '';
        h += `<div class="sr-row" data-desc="${s.desc.replace(/"/g,'&quot;')}">
          <label class="sr-label" title="${s.desc.replace(/"/g,'&quot;')}">${s.label}${rtBadge}</label>
          <input type="range" class="${rtCls}" id="${s.id}" min="${s.min}" max="${s.max}" value="${s.val}" step="${s.step}" data-param="${s.id}" />
          <span class="sr-val" id="${s.id}Val">${s.val}${s.unit}</span>
        </div>`;
      }
      h += '</div>';
      panel.innerHTML = h;
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
      spectro3DContainer:g('spectro3DContainer'), spectro3DCanvas:g('spectro3DCanvas'),
      spectro3DReset:g('spectro3DReset'), spectro2DCanvas:g('spectro2DCanvas'),
      waveOrigCanvas:g('waveOrigCanvas'), waveProcCanvas:g('waveProcCanvas'),
      freqCanvas:g('freqCanvas'),
      pipeFill:g('pipeFill'), pipeStage:g('pipeStage'), pipeDetail:g('pipeDetail'),
      hSNR:g('hSNR'), hDur:g('hDur'), hSR:g('hSR'), hCh:g('hCh'),
      hRMS:g('hRMS'), hPeak:g('hPeak'), hStatus:g('hStatus'),
      stLatency:g('stLatency'), stProcTime:g('stProcTime'), stVoices:g('stVoices'),
      tooltip:g('tooltip')
    };
  }

  bindAll() {
    const uz = this.dom.uploadZone;
    // Drag/drop
    ['dragenter','dragover'].forEach(e => uz.addEventListener(e, ev => { ev.preventDefault(); ev.stopPropagation(); uz.classList.add('dragover'); }));
    ['dragleave','drop'].forEach(e => uz.addEventListener(e, ev => { ev.preventDefault(); ev.stopPropagation(); uz.classList.remove('dragover'); }));
    uz.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if (f) this.handleFile(f); });
    uz.addEventListener('click', e => { if (e.target.tagName !== 'BUTTON') this.dom.fileInput.click(); });
    this.dom.fileBtn.addEventListener('click', e => { e.stopPropagation(); this.dom.fileInput.click(); });
    this.dom.fileInput.addEventListener('change', e => { if (e.target.files[0]) this.handleFile(e.target.files[0]); });
    this.dom.micBtn.addEventListener('click', () => this.toggleRec());
    this.dom.processBtn.addEventListener('click', () => this.runPipeline());
    this.dom.reprocessBtn.addEventListener('click', () => this.runPipeline());
    this.dom.stopProcBtn.addEventListener('click', () => { this.abortFlag = true; });
    this.dom.saveOrigBtn.addEventListener('click', () => this.saveWav(this.inputBuffer, 'original'));
    this.dom.saveProcBtn.addEventListener('click', () => this.saveWav(this.outputBuffer, 'processed'));
    this.dom.tpPlay.addEventListener('click', () => this.play());
    this.dom.tpPause.addEventListener('click', () => this.pause());
    this.dom.tpStop.addEventListener('click', () => this.stop());
    this.dom.tpRew.addEventListener('click', () => this.seekDelta(-5));
    this.dom.tpFwd.addEventListener('click', () => this.seekDelta(5));
    this.dom.tpSeek.addEventListener('input', () => this.seekTo(this.dom.tpSeek.value / 1000));
    this.dom.tpSpeed.addEventListener('change', () => { if(this.currentSource) this.currentSource.playbackRate.value = parseFloat(this.dom.tpSpeed.value); if(this.isVideo) this.dom.videoPlayer.playbackRate = parseFloat(this.dom.tpSpeed.value); });
    this.dom.tpAB.addEventListener('click', () => this.toggleAB());
    document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === t));
      document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + t.dataset.tab));
    }));
    document.querySelectorAll('.btn-preset').forEach(b => b.addEventListener('click', () => this.applyPreset(b.dataset.preset)));
    document.querySelectorAll('input[type="range"][data-param]').forEach(el => el.addEventListener('input', () => this.onSlider(el)));
    document.querySelectorAll('.sr-row').forEach(r => {
      r.addEventListener('mouseenter', e => { const d = r.dataset.desc; if(d){ this.dom.tooltip.textContent=d; this.dom.tooltip.classList.add('visible'); const b=r.getBoundingClientRect(); this.dom.tooltip.style.left=(b.right+6)+'px'; this.dom.tooltip.style.top=b.top+'px'; const tb=this.dom.tooltip.getBoundingClientRect(); if(tb.right>window.innerWidth-8) this.dom.tooltip.style.left=(b.left-tb.width-6)+'px'; if(tb.bottom>window.innerHeight-8) this.dom.tooltip.style.top=(window.innerHeight-tb.height-8)+'px'; }});
      r.addEventListener('mouseleave', () => this.dom.tooltip.classList.remove('visible'));
    });
    this.dom.spectro3DReset.addEventListener('click', () => this.reset3D());
    this.dom.spectro3DCanvas.addEventListener('click', e => this.onSpectroClick(e));
    window.addEventListener('resize', () => this.onResize());
  }

  onSlider(el) {
    const id = el.dataset.param, v = parseFloat(el.value);
    this.params[id] = v;
    let unit = '';
    for (const t of Object.values(SLIDERS)) { const s = t.find(x => x.id === id); if (s) { unit = s.unit; break; } }
    const ve = document.getElementById(id + 'Val');
    if (ve) ve.textContent = v + unit;
    if (el.classList.contains('realtime') && this.liveChainBuilt) this.updateLive();
  }

  applyPreset(name) {
    const p = PRESETS[name]; if (!p) return;
    Object.assign(this.params, p);
    for (const [,sliders] of Object.entries(SLIDERS)) {
      for (const s of sliders) {
        const el = document.getElementById(s.id), ve = document.getElementById(s.id + 'Val');
        if (el && this.params[s.id] !== undefined) { el.value = this.params[s.id]; if (ve) ve.textContent = this.params[s.id] + s.unit; }
      }
    }
    document.querySelectorAll('.btn-preset').forEach(b => b.classList.toggle('active', b.dataset.preset === name));
    if (this.liveChainBuilt) this.updateLive();
  }

  // ===== FIX #1: FILE HANDLING — use file.arrayBuffer() for BOTH audio and video =====
  async handleFile(file) {
    try {
      this.ensureCtx();
      this.dom.fileInfo.textContent = `Loading: ${file.name}...`;
      this.setStatus('LOADING');
      this.stop(); // stop any current playback

      this.isVideo = file.type.startsWith('video/');

      // ALWAYS read raw bytes from the File object (not from a blob URL fetch)
      const rawBytes = await file.arrayBuffer();

      if (this.isVideo) {
        // Set video element for visual playback
        if (this.videoURL) URL.revokeObjectURL(this.videoURL);
        this.videoURL = URL.createObjectURL(file);
        this.dom.videoPlayer.src = this.videoURL;
        this.dom.videoCard.style.display = 'block';
        await new Promise((res, rej) => {
          this.dom.videoPlayer.onloadedmetadata = res;
          this.dom.videoPlayer.onerror = () => rej(new Error('Video element failed to load'));
        });
      } else {
        this.dom.videoCard.style.display = 'none';
      }

      // Decode audio from the raw file bytes (works for audio AND video containers)
      this.inputBuffer = await this.ctx.decodeAudioData(rawBytes.slice(0));
      this.outputBuffer = null;
      this.onLoaded(file.name);

    } catch (err) {
      console.error('File load error:', err);
      this.dom.fileInfo.textContent = 'Error decoding: ' + (err.message || 'Unsupported format');
      this.setStatus('ERROR');
    }
  }

  onLoaded(name) {
    const b = this.inputBuffer, dur = this.fmtDur(b.duration);
    this.dom.fileInfo.textContent = `${name || 'Recording'} (${dur})`;
    this.dom.processBtn.disabled = false;
    this.dom.saveOrigBtn.disabled = false;
    this.dom.reprocessBtn.disabled = true;
    this.dom.saveProcBtn.disabled = true;
    this.dom.tpAB.disabled = true;
    [this.dom.tpPlay, this.dom.tpPause, this.dom.tpStop, this.dom.tpRew, this.dom.tpFwd, this.dom.tpSeek, this.dom.tpSpeed].forEach(e => e.disabled = false);
    this.dom.tpTotal.textContent = dur;
    this.dom.tpABLabel.textContent = 'Original';
    this.dom.hDur.textContent = dur;
    this.dom.hSR.textContent = b.sampleRate + ' Hz';
    this.dom.hCh.textContent = b.numberOfChannels;
    this.dom.hRMS.textContent = this.calcRMS(b.getChannelData(0)).toFixed(1) + ' dB';
    this.dom.hPeak.textContent = this.calcPeak(b.getChannelData(0)).toFixed(1) + ' dB';
    this.sizeCanvas(this.dom.waveOrigCanvas);
    this.drawWave(b, this.dom.waveOrigCanvas, '#dc2626');
    this.clearCv(this.dom.waveProcCanvas, 'Process to see result');
    this.setStatus('READY');
  }

  // ---- RECORDING ----
  async toggleRec() {
    if (this.isRecording) { this.stopRec(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.ensureCtx();
      this.isRecording = true; this.recordedChunks = [];
      this.dom.micBtn.classList.add('recording');
      this.dom.micLabel.textContent = 'Stop';
      this.setStatus('RECORDING');
      const src = this.ctx.createMediaStreamSource(stream);
      this.analyserNode = this.ctx.createAnalyser(); this.analyserNode.fftSize = 4096;
      src.connect(this.analyserNode);
      this.startSpectro(this.analyserNode);
      const mime = this.getMime();
      this.mediaRecorder = new MediaRecorder(stream, { mimeType: mime });
      this.mediaRecorder.ondataavailable = e => { if (e.data.size > 0) this.recordedChunks.push(e.data); };
      this.mediaRecorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        this.stopSpectro();
        const blob = new Blob(this.recordedChunks, { type: mime });
        try {
          const ab = await blob.arrayBuffer();
          this.inputBuffer = await this.ctx.decodeAudioData(ab);
          this.outputBuffer = null; this.isVideo = false;
          this.dom.videoCard.style.display = 'none';
          this.onLoaded('Recording');
        } catch(e) { console.error(e); this.setStatus('ERROR'); }
      };
      this.mediaRecorder.start(100);
    } catch(e) { this.dom.fileInfo.textContent = 'Mic denied'; this.setStatus('ERROR'); }
  }
  stopRec() {
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

  // ---- TRANSPORT ----
  play() {
    this.stop();
    this.ensureCtx();
    const buf = (this.abMode === 'processed' && this.outputBuffer) ? this.outputBuffer : this.inputBuffer;
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
    this.playOffset += (this.ctx.currentTime - this.playStartTime) * parseFloat(this.dom.tpSpeed.value || 1);
    this.teardownChain(); this.isPlaying = false;
    if (this.isVideo) this.dom.videoPlayer.pause();
    this.stopSpectro();
  }
  stop() {
    this.teardownChain(); this.isPlaying = false; this.playOffset = 0;
    if (this.isVideo) { this.dom.videoPlayer.pause(); this.dom.videoPlayer.currentTime = 0; }
    this.stopSpectro();
    this.dom.tpCur.textContent = '0:00'; this.dom.tpSeek.value = 0;
  }
  seekDelta(d) {
    if (!this.inputBuffer) return;
    this.playOffset = Math.max(0, Math.min(this.inputBuffer.duration, this.playOffset + d));
    if (this.isPlaying) this.play();
    else { this.dom.tpCur.textContent = this.fmtDur(this.playOffset); this.dom.tpSeek.value = (this.playOffset / this.inputBuffer.duration) * 1000; }
  }
  seekTo(frac) {
    if (!this.inputBuffer) return;
    this.playOffset = frac * this.inputBuffer.duration;
    if (this.isPlaying) this.play();
    else this.dom.tpCur.textContent = this.fmtDur(this.playOffset);
  }
  toggleAB() {
    if (!this.outputBuffer) return;
    this.abMode = this.abMode === 'original' ? 'processed' : 'original';
    this.dom.tpAB.classList.toggle('active', this.abMode === 'processed');
    if (this.isPlaying) { this.playOffset += (this.ctx.currentTime - this.playStartTime) * parseFloat(this.dom.tpSpeed.value || 1); this.play(); }
    this.dom.tpABLabel.textContent = this.abMode === 'processed' ? 'Processed' : 'Original';
  }
  tickTime() {
    const tick = () => {
      if (!this.isPlaying) return;
      const el = this.playOffset + (this.ctx.currentTime - this.playStartTime) * parseFloat(this.dom.tpSpeed.value || 1);
      const dur = this.inputBuffer ? this.inputBuffer.duration : 0;
      if (el >= dur) { this.stop(); return; }
      this.dom.tpCur.textContent = this.fmtDur(el);
      this.dom.tpSeek.value = dur > 0 ? (el / dur) * 1000 : 0;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // ---- LIVE AUDIO CHAIN (real-time sliders) ----
  buildLiveChain(buf) {
    this.teardownChain();
    const c = this.ensureCtx(), p = this.params;
    const src = c.createBufferSource(); src.buffer = buf;
    src.playbackRate.value = parseFloat(this.dom.tpSpeed.value || 1);
    src.onended = () => { if (this.isPlaying) this.stop(); };

    const hp = c.createBiquadFilter(); hp.type='highpass'; hp.frequency.value=p.hpFreq; hp.Q.value=p.hpQ;
    const lp = c.createBiquadFilter(); lp.type='lowpass'; lp.frequency.value=p.lpFreq; lp.Q.value=p.lpQ;

    const eqDefs = [
      {id:'eqSub',f:40,type:'lowshelf'},{id:'eqBass',f:100,type:'peaking',q:1.2},
      {id:'eqWarmth',f:200,type:'peaking',q:1},{id:'eqBody',f:400,type:'peaking',q:1},
      {id:'eqLowMid',f:800,type:'peaking',q:1},{id:'eqMid',f:1500,type:'peaking',q:1.2},
      {id:'eqPresence',f:3000,type:'peaking',q:1.5},{id:'eqClarity',f:5000,type:'peaking',q:1.2},
      {id:'eqAir',f:10000,type:'highshelf'},{id:'eqBrill',f:16000,type:'highshelf'}
    ];
    const eqNodes = eqDefs.map(b => {
      const n = c.createBiquadFilter(); n.type=b.type; n.frequency.value=b.f;
      if(b.q) n.Q.value=b.q; n.gain.value=p[b.id]||0; return {node:n,id:b.id};
    });

    const deEss = c.createBiquadFilter(); deEss.type='peaking'; deEss.frequency.value=p.deEssFreq; deEss.Q.value=3; deEss.gain.value=-(p.deEssAmt/100)*10;
    const tilt = c.createBiquadFilter(); tilt.type='highshelf'; tilt.frequency.value=1000; tilt.gain.value=p.specTilt;
    const vfLo = c.createBiquadFilter(); vfLo.type='highpass'; vfLo.frequency.value=p.voiceFocusLo; vfLo.Q.value=0.5;
    const vfHi = c.createBiquadFilter(); vfHi.type='lowpass'; vfHi.frequency.value=p.voiceFocusHi; vfHi.Q.value=0.5;
    const comp = c.createDynamicsCompressor();
    comp.threshold.value=p.compThresh; comp.ratio.value=p.compRatio; comp.attack.value=p.compAttack/1000; comp.release.value=p.compRelease/1000; comp.knee.value=p.compKnee;
    const makeup = c.createGain(); makeup.gain.value=Math.pow(10,p.compMakeup/20);
    const lim = c.createDynamicsCompressor(); lim.threshold.value=p.limThresh; lim.knee.value=0; lim.ratio.value=20; lim.attack.value=0.001; lim.release.value=p.limRelease/1000;
    const outG = c.createGain(); outG.gain.value=Math.pow(10,p.outGain/20);
    const widthG = c.createGain(); widthG.gain.value=p.outWidth/100;
    const analyser = c.createAnalyser(); analyser.fftSize=4096; analyser.smoothingTimeConstant=0.75;

    const chain = [src,hp,lp,...eqNodes.map(e=>e.node),deEss,tilt,vfLo,vfHi,comp,makeup,lim,outG,widthG,analyser];
    for(let i=0;i<chain.length-1;i++) chain[i].connect(chain[i+1]);
    analyser.connect(c.destination);
    src.start(0, this.playOffset);

    this.currentSource=src; this.analyserNode=analyser;
    this.liveNodes={hp,lp,eqNodes,deEss,tilt,vfLo,vfHi,comp,makeup,lim,outG,widthG,chain};
    this.liveChainBuilt=true;
  }

  updateLive() {
    if(!this.liveChainBuilt) return;
    const p=this.params, n=this.liveNodes, t=this.ctx.currentTime, s=0.02;
    try {
      n.hp.frequency.setTargetAtTime(p.hpFreq,t,s); n.hp.Q.setTargetAtTime(p.hpQ,t,s);
      n.lp.frequency.setTargetAtTime(p.lpFreq,t,s); n.lp.Q.setTargetAtTime(p.lpQ,t,s);
      const eqIds=['eqSub','eqBass','eqWarmth','eqBody','eqLowMid','eqMid','eqPresence','eqClarity','eqAir','eqBrill'];
      n.eqNodes.forEach((eq,i)=>eq.node.gain.setTargetAtTime(p[eqIds[i]]||0,t,s));
      n.deEss.frequency.setTargetAtTime(p.deEssFreq,t,s); n.deEss.gain.setTargetAtTime(-(p.deEssAmt/100)*10,t,s);
      n.tilt.gain.setTargetAtTime(p.specTilt,t,s);
      n.vfLo.frequency.setTargetAtTime(p.voiceFocusLo,t,s); n.vfHi.frequency.setTargetAtTime(p.voiceFocusHi,t,s);
      n.comp.threshold.setTargetAtTime(p.compThresh,t,s); n.comp.ratio.setTargetAtTime(p.compRatio,t,s);
      n.comp.attack.setTargetAtTime(p.compAttack/1000,t,s); n.comp.release.setTargetAtTime(p.compRelease/1000,t,s);
      n.comp.knee.setTargetAtTime(p.compKnee,t,s);
      n.makeup.gain.setTargetAtTime(Math.pow(10,p.compMakeup/20),t,s);
      n.lim.threshold.setTargetAtTime(p.limThresh,t,s); n.lim.release.setTargetAtTime(p.limRelease/1000,t,s);
      n.outG.gain.setTargetAtTime(Math.pow(10,p.outGain/20),t,s);
      n.widthG.gain.setTargetAtTime(p.outWidth/100,t,s);
    } catch(e){}
  }

  teardownChain() {
    if(this.currentSource){try{this.currentSource.stop();}catch(e){}try{this.currentSource.disconnect();}catch(e){}this.currentSource=null;}
    if(this.liveNodes.chain) this.liveNodes.chain.forEach(n=>{try{n.disconnect();}catch(e){}});
    this.liveNodes={}; this.liveChainBuilt=false;
  }

  // ---- 30-STAGE OFFLINE PIPELINE ----
  async runPipeline() {
    if(!this.inputBuffer||this.isProcessing) return;
    this.isProcessing=true; this.abortFlag=false;
    this.dom.processBtn.style.display='none'; this.dom.stopProcBtn.style.display='inline-flex';
    this.dom.saveProcBtn.disabled=true; this.dom.tpAB.disabled=true;
    this.setStatus('PROCESSING');
    const t0=performance.now(), p=this.params;
    const sr=this.inputBuffer.sampleRate, numCh=this.inputBuffer.numberOfChannels, len=this.inputBuffer.length;
    const total=STAGES.length;

    try {
      const off = new OfflineAudioContext(numCh,len,sr);
      const src = off.createBufferSource(); src.buffer=this.inputBuffer;

      for(let i=0;i<7;i++){await this.updPipe(i,total);if(this.abortFlag)throw 'abort';}

      await this.updPipe(7,total);
      const hp=off.createBiquadFilter();hp.type='highpass';hp.frequency.value=p.hpFreq;hp.Q.value=p.hpQ;
      await this.updPipe(8,total);
      const lp=off.createBiquadFilter();lp.type='lowpass';lp.frequency.value=p.lpFreq;lp.Q.value=p.lpQ;
      await this.updPipe(9,total);
      const vbp=off.createBiquadFilter();vbp.type='peaking';vbp.frequency.value=1500;vbp.Q.value=0.5;vbp.gain.value=(p.voiceIso/100)*6;
      await this.updPipe(10,total);
      const gate=off.createDynamicsCompressor();gate.threshold.value=p.gateThresh;gate.knee.value=2;gate.ratio.value=20;gate.attack.value=p.gateAttack/1000;gate.release.value=p.gateRelease/1000;
      await this.updPipe(11,total);
      await this.updPipe(12,total);
      const notch=off.createBiquadFilter();notch.type='notch';notch.frequency.value=60;notch.Q.value=30;
      if(this.abortFlag)throw 'abort';

      const eqDefs=[{id:'eqSub',f:40,t:'lowshelf'},{id:'eqBass',f:100,t:'peaking',q:1.2},{id:'eqWarmth',f:200,t:'peaking',q:1},{id:'eqBody',f:400,t:'peaking',q:1},{id:'eqLowMid',f:800,t:'peaking',q:1},{id:'eqMid',f:1500,t:'peaking',q:1.2},{id:'eqPresence',f:3000,t:'peaking',q:1.5},{id:'eqClarity',f:5000,t:'peaking',q:1.2},{id:'eqAir',f:10000,t:'highshelf'},{id:'eqBrill',f:16000,t:'highshelf'}];
      const eqN=[];
      for(let i=0;i<eqDefs.length;i++){
        await this.updPipe(13+i,total);
        const d=eqDefs[i],n=off.createBiquadFilter();n.type=d.t;n.frequency.value=d.f;if(d.q)n.Q.value=d.q;n.gain.value=p[d.id]||0;eqN.push(n);
        if(this.abortFlag)throw 'abort';
      }

      await this.updPipe(23,total);
      const deEss=off.createBiquadFilter();deEss.type='peaking';deEss.frequency.value=p.deEssFreq;deEss.Q.value=3;deEss.gain.value=-(p.deEssAmt/100)*10;
      await this.updPipe(24,total);
      const tilt=off.createBiquadFilter();tilt.type='highshelf';tilt.frequency.value=1000;tilt.gain.value=p.specTilt;
      await this.updPipe(25,total);
      const derev=off.createBiquadFilter();derev.type='highpass';derev.frequency.value=100+(p.derevAmt/100)*200;derev.Q.value=0.5;
      await this.updPipe(26,total);
      const harm=off.createWaveShaper();harm.curve=this.makeHarmCurve(p.harmRecov/100,p.harmOrder);harm.oversample='2x';
      await this.updPipe(27,total);
      const comp=off.createDynamicsCompressor();comp.threshold.value=p.compThresh;comp.ratio.value=p.compRatio;comp.attack.value=p.compAttack/1000;comp.release.value=p.compRelease/1000;comp.knee.value=p.compKnee;
      const mkG=off.createGain();mkG.gain.value=Math.pow(10,p.compMakeup/20);
      await this.updPipe(28,total);
      const lim=off.createDynamicsCompressor();lim.threshold.value=p.limThresh;lim.knee.value=0;lim.ratio.value=20;lim.attack.value=0.001;lim.release.value=p.limRelease/1000;
      const outG=off.createGain();outG.gain.value=Math.pow(10,p.outGain/20);

      if(this.abortFlag)throw 'abort';

      const chain=[src,hp,lp,vbp,gate,notch,...eqN,deEss,tilt,derev,harm,comp,mkG,lim,outG];
      for(let i=0;i<chain.length-1;i++) chain[i].connect(chain[i+1]);
      chain[chain.length-1].connect(off.destination);
      src.start(0);
      const rendered=await off.startRendering();
      if(this.abortFlag)throw 'abort';

      await this.updPipe(29,total);
      let final=rendered;
      if(p.nrAmount>0) final=this.applyNR(final,p.nrAmount/100,p.nrSmoothing/100,p.nrFloor);
      if(p.dryWet<100) final=this.mixDW(this.inputBuffer,final,p.dryWet/100);
      final=this.peakNorm(final,p.limThresh);

      this.outputBuffer=final;
      this.dom.stProcTime.textContent=((performance.now()-t0)/1000).toFixed(2)+'s';
      const oRMS=this.calcRMS(this.inputBuffer.getChannelData(0)), pRMS=this.calcRMS(final.getChannelData(0));
      this.dom.hSNR.textContent=((pRMS-oRMS)>=0?'+':'')+(pRMS-oRMS).toFixed(1)+' dB';
      this.sizeCanvas(this.dom.waveProcCanvas);
      this.drawWave(final,this.dom.waveProcCanvas,'#22d3ee');
      this.dom.stVoices.textContent=this.estVoices(final);
      this.dom.saveProcBtn.disabled=false; this.dom.tpAB.disabled=false; this.dom.reprocessBtn.disabled=false;
      this.dom.tpABLabel.textContent='Ready — A/B';
      this.setStatus('COMPLETE');
    } catch(e) {
      if(e==='abort'){this.setStatus('ABORTED');this.dom.pipeStage.textContent='Aborted';}
      else{console.error('Pipeline error:',e);this.setStatus('ERROR');}
    } finally {
      this.isProcessing=false; this.dom.processBtn.style.display='inline-flex'; this.dom.stopProcBtn.style.display='none';
    }
  }

  async updPipe(i,t){
    this.dom.pipeFill.style.width=((i+1)/t*100)+'%';
    this.dom.pipeStage.textContent=`${i+1}/${t}`;
    this.dom.pipeDetail.textContent=STAGES[i];
    this.dom.hStatus.textContent='S'+(i+1);
    await new Promise(r=>setTimeout(r,15));
  }

  // ---- DSP HELPERS ----
  applyNR(buf,amt,smooth,floorDb){
    const c=this.ctx,nCh=buf.numberOfChannels,len=buf.length,sr=buf.sampleRate;
    const out=c.createBuffer(nCh,len,sr);
    for(let ch=0;ch<nCh;ch++){
      const inp=buf.getChannelData(ch),o=out.getChannelData(ch);
      const nLen=Math.min(Math.floor(sr*0.15),len);
      let nRms=0;for(let i=0;i<nLen;i++)nRms+=inp[i]*inp[i];nRms=Math.sqrt(nRms/nLen);
      const flLin=Math.pow(10,floorDb/20);
      const thresh=Math.max(nRms,flLin)*(1+amt*4);
      const blk=256;let prev=1;
      for(let i=0;i<len;i+=blk){
        const end=Math.min(i+blk,len);let rms=0;
        for(let j=i;j<end;j++)rms+=inp[j]*inp[j];rms=Math.sqrt(rms/(end-i));
        let g=rms>thresh?1:Math.max(0.005,rms/thresh);
        g=prev+(g-prev)*(1-smooth);prev=g;
        for(let j=i;j<end;j++)o[j]=inp[j]*g;
      }
    }
    return out;
  }
  mixDW(dry,wet,wA){
    const c=this.ctx,nCh=Math.min(dry.numberOfChannels,wet.numberOfChannels),len=Math.min(dry.length,wet.length),sr=dry.sampleRate;
    const out=c.createBuffer(nCh,len,sr);
    for(let ch=0;ch<nCh;ch++){const d=dry.getChannelData(ch),w=wet.getChannelData(ch),o=out.getChannelData(ch);for(let i=0;i<len;i++)o[i]=d[i]*(1-wA)+w[i]*wA;}
    return out;
  }
  peakNorm(buf,tDb){
    const c=this.ctx,nCh=buf.numberOfChannels,len=buf.length;
    const out=c.createBuffer(nCh,len,buf.sampleRate);
    let pk=0;for(let ch=0;ch<nCh;ch++){const d=buf.getChannelData(ch);for(let i=0;i<len;i++){const a=Math.abs(d[i]);if(a>pk)pk=a;}}
    if(pk===0)return buf;
    const g=Math.pow(10,tDb/20)/pk;
    for(let ch=0;ch<nCh;ch++){const inp=buf.getChannelData(ch),o=out.getChannelData(ch);for(let i=0;i<len;i++)o[i]=Math.max(-1,Math.min(1,inp[i]*g));}
    return out;
  }
  makeHarmCurve(amt,order){
    const n=44100,c=new Float32Array(n),k=amt*(order||3)*2+1;
    for(let i=0;i<n;i++){const x=(i*2)/n-1;c[i]=Math.tanh(k*x)/Math.tanh(k);}return c;
  }
  estVoices(buf){
    const d=buf.getChannelData(0),sr=buf.sampleRate,blk=Math.floor(sr*0.5);
    let act=0;for(let i=0;i<d.length;i+=blk){let r=0;const e=Math.min(i+blk,d.length);for(let j=i;j<e;j++)r+=d[j]*d[j];r=Math.sqrt(r/(e-i));if(r>0.01)act++;}
    return act<3?'0-1':act<10?'1':'1-2+';
  }

  // ---- SAVE ----
  saveWav(buf,label){
    if(!buf)return;
    const wav=this.encWav(buf), blob=new Blob([wav],{type:'audio/wav'});
    const a=document.createElement('a');a.href=URL.createObjectURL(blob);
    a.download=`voiceisolate_v19_${label}_${Date.now()}.wav`;
    document.body.appendChild(a);a.click();document.body.removeChild(a);URL.revokeObjectURL(a.href);
  }
  encWav(buf){
    const nCh=buf.numberOfChannels,sr=buf.sampleRate,bps=16,byPS=2,dLen=buf.length*nCh*byPS;
    const a=new ArrayBuffer(44+dLen),v=new DataView(a);
    const ws=(o,s)=>{for(let i=0;i<s.length;i++)v.setUint8(o+i,s.charCodeAt(i));};
    ws(0,'RIFF');v.setUint32(4,36+dLen,true);ws(8,'WAVE');ws(12,'fmt ');
    v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,nCh,true);
    v.setUint32(24,sr,true);v.setUint32(28,sr*nCh*byPS,true);v.setUint16(32,nCh*byPS,true);v.setUint16(34,bps,true);
    ws(36,'data');v.setUint32(40,dLen,true);
    let off=44;for(let i=0;i<buf.length;i++){for(let ch=0;ch<nCh;ch++){let s=buf.getChannelData(ch)[i];s=Math.max(-1,Math.min(1,s));v.setInt16(off,s<0?s*0x8000:s*0x7FFF,true);off+=2;}}
    return a;
  }

  // ===== FIX #2: CANVAS — no DPR on spectrograms (raw pixel getImageData compatibility) =====
  initCanvases(){
    [this.dom.waveOrigCanvas,this.dom.waveProcCanvas].forEach(c=>this.sizeCanvas(c));
    [this.dom.spectro2DCanvas,this.dom.freqCanvas].forEach(c=>this.sizeCanvasRaw(c));
    this.clearCv(this.dom.waveOrigCanvas,'Load audio to begin');
    this.clearCv(this.dom.waveProcCanvas,'Process to see result');
    this.clearCvRaw(this.dom.spectro2DCanvas,'Play audio for live spectrogram');
    this.clearCvRaw(this.dom.freqCanvas,'Play audio for frequency analysis');
  }

  sizeCanvas(c){
    const r=c.getBoundingClientRect(), dpr=window.devicePixelRatio||1;
    c.width=r.width*dpr; c.height=r.height*dpr;
    c._w=r.width; c._h=r.height; c._dpr=dpr;
  }

  // Raw sizing (no DPR) — used for spectrograms to avoid getImageData/putImageData issues
  sizeCanvasRaw(c){
    const r=c.getBoundingClientRect();
    c.width=Math.floor(r.width); c.height=Math.floor(r.height);
    c._w=c.width; c._h=c.height; c._dpr=1;
  }

  clearCv(c,txt){
    const ctx=c.getContext('2d'), dpr=c._dpr||1;
    ctx.setTransform(dpr,0,0,dpr,0,0);
    ctx.fillStyle='#030306';ctx.fillRect(0,0,c._w,c._h);
    if(txt){ctx.font='11px Outfit,sans-serif';ctx.fillStyle='rgba(255,255,255,0.12)';ctx.textAlign='center';ctx.fillText(txt,c._w/2,c._h/2+3);}
  }
  clearCvRaw(c,txt){
    const ctx=c.getContext('2d');
    ctx.setTransform(1,0,0,1,0,0);
    ctx.fillStyle='#030306';ctx.fillRect(0,0,c.width,c.height);
    if(txt){ctx.font='11px Outfit,sans-serif';ctx.fillStyle='rgba(255,255,255,0.12)';ctx.textAlign='center';ctx.fillText(txt,c.width/2,c.height/2+3);}
  }

  drawWave(buf,canvas,color){
    const ctx=canvas.getContext('2d'), dpr=canvas._dpr||1, w=canvas._w, h=canvas._h;
    ctx.setTransform(dpr,0,0,dpr,0,0);
    ctx.fillStyle='#030306';ctx.fillRect(0,0,w,h);
    if(!buf)return;
    const data=buf.getChannelData(0), step=Math.max(1,Math.floor(data.length/w));
    ctx.strokeStyle='rgba(255,255,255,0.04)';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(0,h/2);ctx.lineTo(w,h/2);ctx.stroke();
    ctx.fillStyle=color;
    for(let x=0;x<w;x++){
      const idx=x*step;let mn=1,mx=-1;
      for(let i=0;i<step&&(idx+i)<data.length;i++){const v=data[idx+i];if(v<mn)mn=v;if(v>mx)mx=v;}
      const y1=((1-mx)*0.5)*h, y2=((1-mn)*0.5)*h;
      ctx.globalAlpha=0.8;ctx.fillRect(x,y1,1,Math.max(1,y2-y1));
    }
    ctx.globalAlpha=1;
  }

  // ---- 2D SPECTROGRAM (raw pixel coords, no DPR) ----
  startSpectro(analyser){
    this.stopSpectro(); this.spectroRunning=true; this.spectroX=0;
    const c=this.dom.spectro2DCanvas; this.sizeCanvasRaw(c);
    const ctx=c.getContext('2d');
    ctx.fillStyle='#030306'; ctx.fillRect(0,0,c.width,c.height);
    const bufLen=analyser.frequencyBinCount, arr=new Uint8Array(bufLen);

    const draw=()=>{
      if(!this.spectroRunning)return;
      this.animId=requestAnimationFrame(draw);
      analyser.getByteFrequencyData(arr);
      const w=c.width, h=c.height, sw=2;

      if(this.spectroX+sw>=w){
        const img=ctx.getImageData(sw,0,w-sw,h);
        ctx.putImageData(img,0,0);
        ctx.fillStyle='#030306';ctx.fillRect(w-sw,0,sw,h);
        this.spectroX=w-sw;
      }

      for(let y=0;y<h;y++){
        const fi=Math.floor((y/h)*bufLen);
        const val=arr[bufLen-1-fi];
        ctx.fillStyle=this.spectroCol(val,fi,bufLen);
        ctx.fillRect(this.spectroX,y,sw,1);
      }
      this.spectroX+=sw;
      this.update3D(arr);
    };
    draw();
  }
  stopSpectro(){this.spectroRunning=false;if(this.animId){cancelAnimationFrame(this.animId);this.animId=null;}}

  spectroCol(val,fi,total){
    const v=val/255, f=fi/total;
    if(f<0.05) return `rgb(${0|v*40},${0|v*80},${0|60+v*195})`;
    if(f<0.2)  return `rgb(${0|60+v*195},${0|v*30},${0|v*20})`;
    if(f<0.5)  return `rgb(${0|80+v*175},${0|v*60},${0|v*10})`;
    if(f<0.75) return `rgb(${0|v*30},${0|50+v*180},${0|v*30})`;
    return `rgb(${0|60+v*195},${0|50+v*160},${0|v*20})`;
  }

  // ---- FREQUENCY ANALYZER (raw pixel coords) ----
  startFreq(analyser){
    const c=this.dom.freqCanvas; this.sizeCanvasRaw(c);
    const ctx=c.getContext('2d');
    const bufLen=analyser.frequencyBinCount, arr=new Uint8Array(bufLen);
    const draw=()=>{
      if(!this.spectroRunning)return;
      requestAnimationFrame(draw);
      analyser.getByteFrequencyData(arr);
      const w=c.width,h=c.height;
      ctx.fillStyle='#030306';ctx.fillRect(0,0,w,h);
      ctx.strokeStyle='rgba(255,255,255,0.03)';ctx.lineWidth=1;
      for(let i=1;i<5;i++){const gy=(i/5)*h;ctx.beginPath();ctx.moveTo(0,gy);ctx.lineTo(w,gy);ctx.stroke();}
      const bw=(w/bufLen)*2.5;let x=0;
      for(let i=0;i<bufLen&&x<w;i++){
        const bh=(arr[i]/255)*h, f=i/bufLen;
        let hue=f<0.05?220:f<0.2?0:f<0.5?10:f<0.75?130:50;
        ctx.fillStyle=`hsla(${hue},75%,50%,0.75)`;
        ctx.fillRect(x,h-bh,Math.max(1,bw-1),bh);x+=bw;
      }
    };
    draw();
  }

  // ---- 3D SPECTROGRAM ----
  init3D(){
    const cont=this.dom.spectro3DContainer;
    const w=cont.clientWidth, h=cont.clientHeight;
    const scene=new THREE.Scene();scene.background=new THREE.Color(0x030306);
    const cam=new THREE.PerspectiveCamera(45,w/h,0.1,1000);cam.position.set(0,40,60);cam.lookAt(0,0,0);
    const ren=new THREE.WebGLRenderer({canvas:this.dom.spectro3DCanvas,antialias:true});
    ren.setSize(w,h);ren.setPixelRatio(Math.min(window.devicePixelRatio,2));
    const gW=64,gD=128;
    const geo=new THREE.PlaneGeometry(80,40,gW-1,gD-1);geo.rotateX(-Math.PI*0.4);
    const cols=new Float32Array(geo.attributes.position.count*3);
    geo.setAttribute('color',new THREE.BufferAttribute(cols,3));
    const mat=new THREE.MeshBasicMaterial({vertexColors:true,side:THREE.DoubleSide});
    const mesh=new THREE.Mesh(geo,mat);scene.add(mesh);
    scene.add(new THREE.AmbientLight(0xffffff,0.5));
    this.three={scene,cam,ren,mesh,geo,gW,gD,cols};

    let drag=false,px=0,py=0;
    this.dom.spectro3DCanvas.addEventListener('mousedown',e=>{drag=true;px=e.clientX;py=e.clientY;});
    window.addEventListener('mouseup',()=>drag=false);
    window.addEventListener('mousemove',e=>{if(!drag)return;cam.position.x-=(e.clientX-px)*0.15;cam.position.y+=(e.clientY-py)*0.15;cam.lookAt(0,0,0);px=e.clientX;py=e.clientY;});
    this.dom.spectro3DCanvas.addEventListener('wheel',e=>{cam.position.z+=e.deltaY*0.05;cam.position.z=Math.max(20,Math.min(120,cam.position.z));});
    this.render3D();
  }
  reset3D(){this.three.cam.position.set(0,40,60);this.three.cam.lookAt(0,0,0);}
  update3D(fData){
    if(!this.three.mesh)return;
    const{geo,gW,gD,cols}=this.three, pos=geo.attributes.position, cA=geo.attributes.color;
    for(let z=gD-1;z>0;z--){for(let x=0;x<gW;x++){
      const c=z*gW+x, p=(z-1)*gW+x;
      pos.setY(c,pos.getY(p));cols[c*3]=cols[p*3];cols[c*3+1]=cols[p*3+1];cols[c*3+2]=cols[p*3+2];
    }}
    const step=Math.floor(fData.length/gW);
    for(let x=0;x<gW;x++){
      const fi=Math.min(x*step,fData.length-1), v=(fData[fi]||0)/255;
      pos.setY(x,v*15);
      const f=x/gW;
      if(f<0.05){cols[x*3]=v*0.15;cols[x*3+1]=v*0.3;cols[x*3+2]=0.3+v*0.7;}
      else if(f<0.3){cols[x*3]=0.3+v*0.7;cols[x*3+1]=v*0.1;cols[x*3+2]=v*0.05;}
      else if(f<0.6){cols[x*3]=v*0.1;cols[x*3+1]=0.2+v*0.6;cols[x*3+2]=v*0.1;}
      else{cols[x*3]=0.3+v*0.6;cols[x*3+1]=0.25+v*0.5;cols[x*3+2]=v*0.05;}
    }
    pos.needsUpdate=true;cA.needsUpdate=true;
  }
  render3D(){requestAnimationFrame(()=>this.render3D());if(this.three.ren)this.three.ren.render(this.three.scene,this.three.cam);}

  onSpectroClick(e){
    const rect=this.dom.spectro3DCanvas.getBoundingClientRect();
    const y=1-((e.clientY-rect.top)/rect.height);
    const sr=this.ctx?this.ctx.sampleRate:44100, freq=y*(sr/2), bw=sr/20;
    const lo=Math.max(0,freq-bw/2), hi=freq+bw/2, key=Math.round(lo)+'-'+Math.round(hi);
    let found=false;
    for(const b of this.mutedBands){if(b.key===key){this.mutedBands.delete(b);found=true;break;}}
    if(!found) this.mutedBands.add({lo,hi,key});
  }

  // ---- RESIZE ----
  onResize(){
    [this.dom.waveOrigCanvas,this.dom.waveProcCanvas].forEach(c=>this.sizeCanvas(c));
    [this.dom.spectro2DCanvas,this.dom.freqCanvas].forEach(c=>this.sizeCanvasRaw(c));
    if(this.inputBuffer)this.drawWave(this.inputBuffer,this.dom.waveOrigCanvas,'#dc2626');
    if(this.outputBuffer)this.drawWave(this.outputBuffer,this.dom.waveProcCanvas,'#22d3ee');
    const cont=this.dom.spectro3DContainer;
    if(this.three.ren){this.three.ren.setSize(cont.clientWidth,cont.clientHeight);this.three.cam.aspect=cont.clientWidth/cont.clientHeight;this.three.cam.updateProjectionMatrix();}
  }

  // ---- UTIL ----
  setStatus(s){
    this.dom.hStatus.textContent=s;
    const c={IDLE:'#5e5e78',LOADING:'#eab308',READY:'#22c55e',PROCESSING:'#dc2626',COMPLETE:'#22d3ee',ERROR:'#ef4444',RECORDING:'#ef4444',ABORTED:'#a855f7'};
    this.dom.hStatus.style.color=c[s]||'#5e5e78';
  }
  calcRMS(d){let s=0;for(let i=0;i<d.length;i++)s+=d[i]*d[i];const r=Math.sqrt(s/d.length);return r>0?20*Math.log10(r):-96;}
  calcPeak(d){let p=0;for(let i=0;i<d.length;i++){const a=Math.abs(d[i]);if(a>p)p=a;}return p>0?20*Math.log10(p):-96;}
  fmtDur(s){const m=Math.floor(s/60),sc=Math.floor(s%60);return m+':'+String(sc).padStart(2,'0');}
}

document.addEventListener('DOMContentLoaded',()=>{window.vip=new VoiceIsolatePro();});
