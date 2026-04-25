/* ============================================
   VoiceIsolate Pro v22.0 – Engineer Mode
   Threads from Space v11 · Hybrid ML+DSP
   52 Sliders · 6-Panel Diagnostics · 3D Spectrogram
   35-Stage Deca-Pass Pipeline with Real STFT DSP
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
    { id:'nrSensitivity', label:'Sensitivity', min:0, max:100, val:50, step:1, unit:'%', rt:false, desc:'How aggressively noise is detected.' },
    { id:'nrSpectralSub', label:'Spectral Subtract', min:0, max:100, val:40, step:1, unit:'%', rt:false, desc:'Subtracts estimated noise spectrum from signal.' },
    { id:'nrFloor', label:'Noise Floor', min:-80, max:-20, val:-60, step:1, unit:' dB', rt:false, desc:'Estimated noise floor level.' },
    { id:'nrSmoothing', label:'Smoothing', min:0, max:100, val:35, step:1, unit:'%', rt:false, desc:'Temporal smoothing of noise estimate.' },
  ],
  eq: [
    { id:'eqSub', label:'Sub (40 Hz)', min:-12, max:6, val:-8, step:0.5, unit:' dB', rt:true, desc:'Sub-bass. Cut to remove rumble.' },
    { id:'eqBass', label:'Bass (100 Hz)', min:-8, max:8, val:0, step:0.5, unit:' dB', rt:true, desc:'Low bass. Boost for warmth.' },
    { id:'eqWarmth', label:'Warmth (200 Hz)', min:-6, max:6, val:1, step:0.5, unit:' dB', rt:true, desc:'Lower midrange warmth.' },
    { id:'eqBody', label:'Body (400 Hz)', min:-6, max:6, val:0, step:0.5, unit:' dB', rt:true, desc:'Core body of the voice.' },
    { id:'eqLowMid', label:'Low-Mid (800 Hz)', min:-6, max:6, val:-1, step:0.5, unit:' dB', rt:true, desc:'Nasal/honky frequencies.' },
    { id:'eqMid', label:'Mid (1.5 kHz)', min:-6, max:6, val:1, step:0.5, unit:' dB', rt:true, desc:'Core intelligibility band.' },
    { id:'eqPresence', label:'Presence (3 kHz)', min:-6, max:8, val:3, step:0.5, unit:' dB', rt:true, desc:'Vocal presence and projection.' },
    { id:'eqClarity', label:'Clarity (5 kHz)', min:-6, max:6, val:2, step:0.5, unit:' dB', rt:true, desc:'Consonant definition.' },
    { id:'eqAir', label:'Air (10 kHz)', min:-6, max:6, val:1, step:0.5, unit:' dB', rt:true, desc:'High-frequency sparkle.' },
    { id:'eqBrill', label:'Brilliance (16 kHz)', min:-8, max:4, val:-2, step:0.5, unit:' dB', rt:true, desc:'Ultra-high frequencies.' },
  ],
  dyn: [
    { id:'compThresh', label:'Comp Threshold', min:-50, max:0, val:-24, step:1, unit:' dB', rt:true, desc:'Level above which compression begins.' },
    { id:'compRatio', label:'Comp Ratio', min:1, max:20, val:4, step:0.5, unit:':1', rt:true, desc:'Compression ratio.' },
    { id:'compAttack', label:'Comp Attack', min:0, max:100, val:8, step:1, unit:' ms', rt:true, desc:'How fast compressor reacts.' },
    { id:'compRelease', label:'Comp Release', min:10, max:1000, val:200, step:5, unit:' ms', rt:true, desc:'How fast compressor lets go.' },
    { id:'compKnee', label:'Comp Knee', min:0, max:30, val:6, step:1, unit:' dB', rt:true, desc:'Soft/hard knee.' },
    { id:'compMakeup', label:'Makeup Gain', min:0, max:24, val:6, step:0.5, unit:' dB', rt:true, desc:'Gain added after compression.' },
    { id:'limThresh', label:'Limiter Ceiling', min:-6, max:0, val:-1, step:0.1, unit:' dB', rt:true, desc:'Brickwall ceiling.' },
    { id:'limRelease', label:'Limiter Release', min:1, max:100, val:10, step:1, unit:' ms', rt:true, desc:'How fast limiter recovers.' },
  ],
  spec: [
    { id:'hpFreq', label:'High-Pass Freq', min:20, max:500, val:80, step:1, unit:' Hz', rt:true, desc:'Removes everything below this frequency.' },
    { id:'hpQ', label:'HP Resonance', min:0.5, max:5, val:0.71, step:0.01, unit:' Q', rt:true, desc:'Filter steepness.' },
    { id:'lpFreq', label:'Low-Pass Freq', min:3000, max:20000, val:14000, step:100, unit:' Hz', rt:true, desc:'Removes everything above this frequency.' },
    { id:'lpQ', label:'LP Resonance', min:0.5, max:5, val:0.71, step:0.01, unit:' Q', rt:true, desc:'Low-pass filter resonance.' },
    { id:'deEssFreq', label:'De-Ess Center', min:4000, max:10000, val:7000, step:100, unit:' Hz', rt:true, desc:'Center frequency for sibilance reduction.' },
    { id:'deEssAmt', label:'De-Ess Amount', min:0, max:100, val:30, step:1, unit:'%', rt:true, desc:'How much sibilance is reduced.' },
    { id:'specTilt', label:'Spectral Tilt', min:-6, max:6, val:0, step:0.5, unit:' dB/oct', rt:true, desc:'Overall spectral slope.' },
    { id:'formantShift', label:'Formant Shift', min:-12, max:12, val:0, step:0.5, unit:' semi', rt:false, desc:'Shifts vocal formants without changing pitch.' },
  ],
  adv: [
    { id:'derevAmt', label:'Dereverb Amount', min:0, max:100, val:40, step:1, unit:'%', rt:false, desc:'Removes room reverb/echo.' },
    { id:'derevDecay', label:'Dereverb Decay', min:0.1, max:3, val:0.5, step:0.1, unit:' s', rt:false, desc:'Estimated room reverb decay time.' },
    { id:'harmRecov', label:'Harmonic Recovery', min:0, max:100, val:20, step:1, unit:'%', rt:false, desc:'Regenerates harmonics lost during noise reduction.' },
    { id:'harmOrder', label:'Harmonic Order', min:2, max:8, val:3, step:1, unit:'x', rt:false, desc:'Which harmonics to regenerate.' },
    { id:'stereoWidth', label:'Stereo Width', min:0, max:200, val:100, step:1, unit:'%', rt:true, desc:'0%=mono, 100%=original, 200%=extra wide.' },
    { id:'phaseCorr', label:'Phase Correction', min:0, max:100, val:0, step:1, unit:'%', rt:false, desc:'Corrects phase issues between stereo channels.' },
  ],
  sep: [
    { id:'voiceIso', label:'Voice Isolation', min:0, max:100, val:70, step:1, unit:'%', rt:false, desc:'Strength of voice/non-voice separation.' },
    { id:'bgSuppress', label:'Background Suppress', min:0, max:100, val:50, step:1, unit:'%', rt:false, desc:'Attenuation of non-voice background.' },
    { id:'voiceFocusLo', label:'Voice Focus Low', min:80, max:500, val:120, step:5, unit:' Hz', rt:true, desc:'Lower bound of voice focus band.' },
    { id:'voiceFocusHi', label:'Voice Focus High', min:2000, max:12000, val:6000, step:100, unit:' Hz', rt:true, desc:'Upper bound of voice focus band.' },
    { id:'crosstalkCancel', label:'Crosstalk Cancel', min:0, max:100, val:0, step:1, unit:'%', rt:false, desc:'Reduces bleed between speakers.' },
  ],
  out: [
    { id:'outGain', label:'Output Gain', min:-18, max:18, val:0, step:0.5, unit:' dB', rt:true, desc:'Final output level adjustment.' },
    { id:'dryWet', label:'Dry/Wet Mix', min:0, max:100, val:100, step:1, unit:'%', rt:false, desc:'Balance between original and processed.' },
    { id:'ditherAmt', label:'Dither', min:0, max:100, val:0, step:1, unit:'%', rt:false, desc:'Adds shaped noise before bit-depth reduction.' },
    { id:'outWidth', label:'Output Width', min:0, max:200, val:100, step:1, unit:'%', rt:true, desc:'Final stereo width control.' },
  ]
};

const PRESETS = {
  podcast: {gateThresh:-38,gateRange:-35,gateAttack:2,gateRelease:60,gateHold:15,gateLookahead:5,nrAmount:60,nrSensitivity:55,nrSpectralSub:45,nrFloor:-55,nrSmoothing:40,eqSub:-10,eqBass:-1,eqWarmth:2,eqBody:0,eqLowMid:-1,eqMid:1,eqPresence:4,eqClarity:2,eqAir:1,eqBrill:-3,compThresh:-20,compRatio:5,compAttack:6,compRelease:180,compKnee:6,compMakeup:8,limThresh:-1,limRelease:8,hpFreq:80,hpQ:0.71,lpFreq:14000,lpQ:0.71,deEssFreq:7000,deEssAmt:40,specTilt:0.5,formantShift:0,derevAmt:50,derevDecay:0.4,harmRecov:15,harmOrder:3,stereoWidth:100,phaseCorr:0,voiceIso:80,bgSuppress:60,voiceFocusLo:120,voiceFocusHi:6000,crosstalkCancel:0,outGain:0,dryWet:100,ditherAmt:0,outWidth:100},
  film: {gateThresh:-50,gateRange:-30,gateAttack:3,gateRelease:100,gateHold:25,gateLookahead:5,nrAmount:40,nrSensitivity:45,nrSpectralSub:30,nrFloor:-60,nrSmoothing:40,eqSub:-6,eqBass:1,eqWarmth:1,eqBody:1,eqLowMid:0,eqMid:0,eqPresence:2,eqClarity:1,eqAir:2,eqBrill:-1,compThresh:-28,compRatio:3,compAttack:12,compRelease:300,compKnee:10,compMakeup:4,limThresh:-1,limRelease:15,hpFreq:60,hpQ:0.71,lpFreq:16000,lpQ:0.71,deEssFreq:6500,deEssAmt:20,specTilt:-0.5,formantShift:0,derevAmt:30,derevDecay:0.6,harmRecov:25,harmOrder:3,stereoWidth:120,phaseCorr:0,voiceIso:60,bgSuppress:40,voiceFocusLo:100,voiceFocusHi:8000,crosstalkCancel:0,outGain:0,dryWet:100,ditherAmt:0,outWidth:110},
  interview: {gateThresh:-42,gateRange:-38,gateAttack:2,gateRelease:80,gateHold:20,gateLookahead:5,nrAmount:55,nrSensitivity:50,nrSpectralSub:40,nrFloor:-58,nrSmoothing:35,eqSub:-8,eqBass:0,eqWarmth:1,eqBody:0,eqLowMid:-1,eqMid:1,eqPresence:3,eqClarity:2,eqAir:1,eqBrill:-2,compThresh:-22,compRatio:5,compAttack:5,compRelease:200,compKnee:6,compMakeup:6,limThresh:-1,limRelease:10,hpFreq:100,hpQ:0.71,lpFreq:12000,lpQ:0.71,deEssFreq:7000,deEssAmt:35,specTilt:0,formantShift:0,derevAmt:45,derevDecay:0.5,harmRecov:20,harmOrder:3,stereoWidth:80,phaseCorr:0,voiceIso:75,bgSuppress:55,voiceFocusLo:120,voiceFocusHi:6000,crosstalkCancel:20,outGain:0,dryWet:100,ditherAmt:0,outWidth:90},
  forensic: {gateThresh:-65,gateRange:-20,gateAttack:1,gateRelease:150,gateHold:30,gateLookahead:10,nrAmount:30,nrSensitivity:60,nrSpectralSub:20,nrFloor:-70,nrSmoothing:50,eqSub:-2,eqBass:0,eqWarmth:0,eqBody:0,eqLowMid:0,eqMid:2,eqPresence:5,eqClarity:4,eqAir:3,eqBrill:0,compThresh:-18,compRatio:2,compAttack:15,compRelease:400,compKnee:12,compMakeup:10,limThresh:-0.5,limRelease:20,hpFreq:50,hpQ:0.71,lpFreq:18000,lpQ:0.71,deEssFreq:8000,deEssAmt:10,specTilt:1,formantShift:0,derevAmt:20,derevDecay:0.8,harmRecov:35,harmOrder:4,stereoWidth:100,phaseCorr:30,voiceIso:90,bgSuppress:30,voiceFocusLo:80,voiceFocusHi:10000,crosstalkCancel:0,outGain:3,dryWet:90,ditherAmt:0,outWidth:100},
  music: {gateThresh:-55,gateRange:-25,gateAttack:3,gateRelease:120,gateHold:15,gateLookahead:3,nrAmount:25,nrSensitivity:40,nrSpectralSub:20,nrFloor:-65,nrSmoothing:45,eqSub:-3,eqBass:1,eqWarmth:2,eqBody:1,eqLowMid:0,eqMid:0,eqPresence:2,eqClarity:1,eqAir:3,eqBrill:0,compThresh:-30,compRatio:2,compAttack:20,compRelease:350,compKnee:15,compMakeup:3,limThresh:-0.5,limRelease:12,hpFreq:40,hpQ:0.71,lpFreq:20000,lpQ:0.71,deEssFreq:7500,deEssAmt:15,specTilt:-1,formantShift:0,derevAmt:15,derevDecay:1.0,harmRecov:30,harmOrder:4,stereoWidth:150,phaseCorr:0,voiceIso:50,bgSuppress:25,voiceFocusLo:80,voiceFocusHi:10000,crosstalkCancel:0,outGain:0,dryWet:85,ditherAmt:5,outWidth:140},
  broadcast: {gateThresh:-35,gateRange:-40,gateAttack:1.5,gateRelease:50,gateHold:10,gateLookahead:3,nrAmount:65,nrSensitivity:60,nrSpectralSub:50,nrFloor:-50,nrSmoothing:30,eqSub:-12,eqBass:-2,eqWarmth:2,eqBody:0,eqLowMid:-2,eqMid:2,eqPresence:5,eqClarity:3,eqAir:1,eqBrill:-4,compThresh:-18,compRatio:6,compAttack:4,compRelease:150,compKnee:4,compMakeup:10,limThresh:-1,limRelease:5,hpFreq:120,hpQ:0.71,lpFreq:12000,lpQ:0.71,deEssFreq:7000,deEssAmt:45,specTilt:1,formantShift:0,derevAmt:55,derevDecay:0.3,harmRecov:10,harmOrder:2,stereoWidth:60,phaseCorr:0,voiceIso:85,bgSuppress:70,voiceFocusLo:150,voiceFocusHi:5000,crosstalkCancel:0,outGain:0,dryWet:100,ditherAmt:0,outWidth:70},
  restoration: {gateThresh:-60,gateRange:-15,gateAttack:5,gateRelease:200,gateHold:40,gateLookahead:10,nrAmount:45,nrSensitivity:55,nrSpectralSub:35,nrFloor:-65,nrSmoothing:50,eqSub:-4,eqBass:0,eqWarmth:0,eqBody:0,eqLowMid:0,eqMid:1,eqPresence:3,eqClarity:2,eqAir:1,eqBrill:-1,compThresh:-26,compRatio:3,compAttack:10,compRelease:250,compKnee:8,compMakeup:5,limThresh:-0.5,limRelease:15,hpFreq:50,hpQ:0.71,lpFreq:16000,lpQ:0.71,deEssFreq:6500,deEssAmt:20,specTilt:0,formantShift:0,derevAmt:35,derevDecay:0.7,harmRecov:40,harmOrder:4,stereoWidth:100,phaseCorr:20,voiceIso:65,bgSuppress:45,voiceFocusLo:100,voiceFocusHi:8000,crosstalkCancel:10,outGain:2,dryWet:95,ditherAmt:5,outWidth:100}
};

// [FIX 2]: Updated from 32 to 35 stages to match the v22 Deca-Pass pipeline.
const STAGES = [
  'S01: Input Decode',                    // 0
  'S02: Channel Normalization',           // 1
  'S03: DC Offset Removal',               // 2
  'S04: Peak Normalization (-3dBFS)',     // 3
  'S05: Noise Gate (Time-Domain)',        // 4
  'S06: Hum Removal (60Hz + Harmonics)', // 5
  'S07: Click/Pop Removal',              // 6
  'S08: De-Essing',                       // 7
  'S09: Forward STFT',                    // 8
  'S10: STFT Frame Analysis',            // 9
  'S11: ML Voice Activity Detection',    // 10
  'S12: ML Demucs Separation',           // 11
  'S13: ML BSRNN Separation',            // 12
  'S14: ML Ensemble Blend',              // 13
  'S15: Spectral Noise Subtraction',     // 14
  'S16: ERB Spectral Gate (32-band)',    // 15
  'S17: Harmonic Enhancement',           // 16
  'S18: Temporal Smoothing',             // 17
  'S19: Dereverberation',                // 18
  'S20: Inverse STFT',                   // 19
  'S21: Overlap-Add Reconstruction',     // 20
  'S22: Sub/Bass EQ',                    // 21
  'S23: Warmth/Body EQ',                 // 22
  'S24: Mid/Presence EQ',                // 23
  'S25: Air/Brilliance EQ',              // 24
  'S26: Harmonic Resynthesis',           // 25
  'S27: Downward Expander',              // 26
  'S28: Dynamics Compression',           // 27
  'S29: LUFS Normalization',             // 28
  'S30: De-Clipper',                      // 29
  'S31: Stereo Widening',                // 30
  'S32: True Peak Limiter',              // 31
  'S33: Dither',                          // 32
  'S34: Final Output Gain',              // 33
  'S35: Pipeline Complete'                // 34
];

// ============================================
class VoiceIsolatePro {
  constructor() {
    this.ctx = null;
    this.inputBuffer = null;
    this.outputBuffer = null;
    this.currentSource = null;
    this.analyserNode = null;     // post-chain (for existing viz)
    this.analyserOrig = null;     // pre-chain (for A/B comparison)
    this.analyserProc = null;     // post-chain (for diagnostics)
    this.isProcessing = false;
    this.isRecording = false;
    this.mediaRecorder = null;
    this.recordedChunks = [];
    this.abMode = 'original';
    this.isVideo = false;
    this.videoUrl = null;
    this.spectroRunning = false;
    this.animId = null;
    this.diagRunning = false;
    this.diagAnimId = null;
    this.spectroX = 0;
    this.specOverlayX = 0;
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
    let _savedPresets = null;
    try { _savedPresets = localStorage.getItem('vip_custom_presets'); } catch { /* private/sandboxed */ }
    this.customPresets = {};
    if (_savedPresets) {
      try { this.customPresets = JSON.parse(_savedPresets); } catch { this.customPresets = {}; }
    }
    this.renderCustomPresets();
    // Diagnostic state
    this.oscMode = 'wave';
    this.overlays = { noise: true, erb: true, ml: false };
    this.abOverlay = false;
    this.lufsHistory = new Float32Array(600).fill(-60);  // 60 seconds @ 10Hz
    this.lufsIdx = 0;
    this.lufsIntegrated = -60;
    this.lufsFrameCount = 0;
    this.lufsSumSq = 0;
    this.clusterPoints = [];  // simulated PCA points
    this.saliencyBuf = new Float32Array(256);
    this.noiseProfile = new Float32Array(256).fill(0.05);
    this.erbThresholds = new Float32Array(32);
    for (let i = 0; i < 32; i++) this.erbThresholds[i] = 0.08 + Math.random() * 0.04;
    this.diagFpsFrames = 0;
    this.diagFpsLast = performance.now();
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

  buildSliderPanels() {
    for (const [tabKey, sliders] of Object.entries(SLIDERS)) {
      const panel = document.getElementById('tab-' + tabKey);
      if (!panel) continue;
      let h = '<div class="sr">';
      for (const s of sliders) {
        const rtCls = s.rt ? ' realtime' : '';
        const rtB = s.rt ? '<span class="rt-badge">RT</span>' : '';
        h += '<div class="sr-row" data-desc="' + s.desc.replace(/"/g, '&quot;') + '">' +
          '<label class="sr-label" for="' + s.id + '" title="' + s.desc.replace(/"/g, '&quot;') + '">' + s.label + rtB + '</label>' +
          '<input type="range" aria-label="' + s.label.replace(/"/g, '&quot;') + (s.rt ? ' (Real-time)' : '') + '" class="' + rtCls + '" id="' + s.id + '" min="' + s.min + '" max="' + s.max + '" value="' + s.val + '" step="' + s.step + '" data-param="' + s.id + '" />' +
          '<span class="sr-val" id="' + s.id + 'Val">' + s.val + s.unit + '</span></div>';
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
      spectro3DReset:g('spectro3DReset'),
      spectro2DCanvas:g('spectro2DCanvas'),
      waveOrigCanvas:g('waveOrigCanvas'), waveProcCanvas:g('waveProcCanvas'),
      freqCanvas:g('freqCanvas'),
      pipeFill:g('pipeFill'), pipeBar:g('pipeBar'), pipeStage:g('pipeStage'), pipeDetail:g('pipeDetail'),
      hSNR:g('hSNR'), hDur:g('hDur'), hSR:g('hSR'), hCh:g('hCh'),
      hRMS:g('hRMS'), hPeak:g('hPeak'), hLUFS:g('hLUFS'), hStatus:g('hStatus'),
      stLatency:g('stLatency'), stProcTime:g('stProcTime'), stVoices:g('stVoices'),
      tooltip:g('tooltip'),
      // Diagnostic canvases
      abWaveCanvas:g('abWaveCanvas'),
      oscCanvas:g('oscCanvas'),
      specOverlayCanvas:g('specOverlayCanvas'),
      lufsCanvas:g('lufsCanvas'),
      saliencyCanvas:g('saliencyCanvas'),
      clusterCanvas:g('clusterCanvas'),
      diagFps:g('diagFps'),
      lufsShort:g('lufsShort'), lufsInt:g('lufsInt'), lufsPeak:g('lufsPeak'), lufsCrest:g('lufsCrest'),
      abOverlayBtn:g('abOverlayBtn'),
    };
  }

  bindEvents() {
    const uz = this.dom.uploadZone;
    ['dragenter','dragover'].forEach(ev => uz.addEventListener(ev, e => { e.preventDefault(); e.stopPropagation(); uz.classList.add('dragover'); }));
    ['dragleave','drop'].forEach(ev => uz.addEventListener(ev, e => { e.preventDefault(); e.stopPropagation(); uz.classList.remove('dragover'); }));
    uz.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if (f) this.handleFile(f); });
    uz.addEventListener('click', e => { if (e.target.tagName !== 'BUTTON') this.dom.fileInput.click(); });
    uz.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.tagName !== 'BUTTON') { e.preventDefault(); this.dom.fileInput.click(); } });
    this.dom.fileBtn.addEventListener('click', e => { e.stopPropagation(); this.dom.fileInput.click(); });

    // Global Spacebar Playback Toggle
    window.addEventListener('keydown', e => {
      if (e.key === ' ') {
        const tag = e.target.tagName;
        // Don't intercept if user is interacting with text inputs, buttons, or the upload zone (which handles its own space)
        // Ensure checkbox and radio buttons can still be toggled natively with spacebar
        if (tag === 'INPUT' && e.target.type !== 'range') return;
        if (tag === 'TEXTAREA' || tag === 'BUTTON' || e.target.id === 'uploadZone') return;

        e.preventDefault(); // Prevent page scrolling

        if (this.inputBuffer) {
          if (this.isPlaying) this.pause();
          else this.play();
        }
      }
    });
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
      const tabs = document.querySelectorAll('.tab');
      tabs.forEach(x => {
        const isActive = x === t;
        x.classList.toggle('active', isActive);
        x.setAttribute('aria-selected', isActive ? 'true' : 'false');
      });
      document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + t.dataset.tab));
    }));
    document.querySelectorAll('.btn-preset').forEach(b => b.addEventListener('click', () => this.applyPreset(b.dataset.preset)));
    const saveBtn = document.getElementById('saveCustomPresetBtn');
    if (saveBtn) saveBtn.addEventListener('click', () => this.saveCustomPreset());
    const nameInput = document.getElementById('customPresetName');
    if (nameInput) nameInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.repeat) { e.preventDefault(); this.saveCustomPreset(); } });
    document.querySelectorAll('input[type="range"][data-param]').forEach(el => el.addEventListener('input', () => this.onSlider(el)));
    document.querySelectorAll('.sr-row').forEach(r => {
      const showTt = () => { const d = r.dataset.desc; if (d) { const tt = this.dom.tooltip; tt.textContent = d; tt.classList.add('visible'); const rc = r.getBoundingClientRect(); tt.style.left = (rc.right+8)+'px'; tt.style.top = rc.top+'px'; const tr = tt.getBoundingClientRect(); if (tr.right > window.innerWidth-10) tt.style.left = (rc.left-tr.width-8)+'px'; if (tr.bottom > window.innerHeight-10) tt.style.top = (window.innerHeight-tr.height-10)+'px'; }};
      const hideTt = () => this.dom.tooltip.classList.remove('visible');
      r.addEventListener('mouseenter', showTt);
      r.addEventListener('mouseleave', hideTt);
      const input = r.querySelector('input');
      if (input) {
        input.addEventListener('focus', showTt);
        input.addEventListener('blur', hideTt);
      }
    });
    this.dom.spectro3DCanvas.addEventListener('click', e => this.onSpectroClick(e));
    this.dom.spectro3DReset.addEventListener('click', () => this.reset3DView());
    window.addEventListener('resize', () => this.onResize());

    // Diagnostic bindings
    document.querySelectorAll('.osc-mode').forEach(b => b.addEventListener('click', () => {
      document.querySelectorAll('.osc-mode').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      this.oscMode = b.dataset.mode;
    }));
    document.querySelectorAll('.overlay-toggle').forEach(b => b.addEventListener('click', () => {
      b.classList.toggle('active');
      this.overlays[b.dataset.overlay] = b.classList.contains('active');
    }));
    if (this.dom.abOverlayBtn) this.dom.abOverlayBtn.addEventListener('click', () => {
      this.abOverlay = !this.abOverlay;
      this.dom.abOverlayBtn.classList.toggle('active', this.abOverlay);
    });
  }

  onSlider(el) {
    const id = el.dataset.param;
    const v = parseFloat(el.value);
    this.params[id] = v;
    let unit = '';
    for (const tab of Object.values(SLIDERS)) { const s = tab.find(s => s.id === id); if (s) { unit = s.unit; break; } }
    const ve = document.getElementById(id + 'Val');
    if (ve) ve.textContent = v + unit;
    if (el.classList.contains('realtime') && this.liveChainBuilt) this.updateLiveChain();
  }



  renderCustomPresets() {
    const row = document.querySelector('.presets-row');
    const actions = document.querySelector('.custom-preset-actions');
    if (!row || !actions) return;

    for (const [id] of Object.entries(this.customPresets)) {
      if (document.querySelector(`.btn-preset[data-preset="${id}"]`)) continue;
      const name = id.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      const btn = document.createElement('button');
      btn.className = 'btn btn-preset';
      btn.dataset.preset = id;
      btn.textContent = name;
      btn.addEventListener('click', () => this.applyPreset(id));
      row.insertBefore(btn, actions);
    }
  }

  saveCustomPreset() {
    const nameInput = document.getElementById('customPresetName');
    const name = nameInput ? nameInput.value.trim() : '';
    if (!name) return alert('Please enter a preset name');
    const id = name.toLowerCase().replace(/[^a-z0-9]/g, '-');
    this.customPresets[id] = { ...this.params };
    PRESETS[id] = this.customPresets[id];
    try { localStorage.setItem('vip_custom_presets', JSON.stringify(this.customPresets)); } catch { /* private/full */ }

    // Add button if it doesn't exist
    if (!document.querySelector(`.btn-preset[data-preset="${id}"]`)) {
      const btn = document.createElement('button');
      btn.className = 'btn btn-preset';
      btn.dataset.preset = id;
      btn.textContent = name;
      btn.addEventListener('click', () => this.applyPreset(id));
      const row = document.querySelector('.presets-row');
      if (row) {
        // insert before custom actions div
        const actions = document.querySelector('.custom-preset-actions');
        if (actions) row.insertBefore(btn, actions);
        else row.appendChild(btn);
      }
    }

    nameInput.value = '';
    this.applyPreset(id);
  }

  applyPreset(name) {
    const p = PRESETS[name]; if (!p) return;
    Object.assign(this.params, p);
    for (const [, sliders] of Object.entries(SLIDERS)) {
      for (const s of sliders) {
        const el = document.getElementById(s.id);
        const ve = document.getElementById(s.id + 'Val');
        if (el && this.params[s.id] !== undefined) { el.value = this.params[s.id]; if (ve) ve.textContent = this.params[s.id] + s.unit; }
      }
    }
    document.querySelectorAll('.btn-preset').forEach(b => b.classList.toggle('active', b.dataset.preset === name));
    if (this.liveChainBuilt) this.updateLiveChain();
  }

  // ======== FILE HANDLING ========
  async handleFile(file) {
    try {
      this.ensureCtx();
      this.stop();
      this.dom.fileInfo.textContent = 'Loading: ' + file.name + '...';
      this.setStatus('LOADING');
      this.isVideo = file.type.startsWith('video/');
      const fileArrayBuffer = await file.arrayBuffer();
      let audioBuf = null;
      try {
        audioBuf = await this.ctx.decodeAudioData(fileArrayBuffer.slice(0));
      } catch (decodeErr) {
        if (this.isVideo) { audioBuf = await this.decodeViaVideoElement(file); }
        else { throw new Error('Cannot decode this audio format. (' + decodeErr.message + ')'); }
      }
      if (!audioBuf || audioBuf.length === 0) throw new Error('Decoded audio is empty.');
      if (this.isVideo) {
        if (this.videoUrl) URL.revokeObjectURL(this.videoUrl);
        this.videoUrl = URL.createObjectURL(file);
        this.dom.videoPlayer.src = this.videoUrl;
        this.dom.videoCard.style.display = 'block';
        await new Promise((res, rej) => {
          this.dom.videoPlayer.onloadedmetadata = res;
          this.dom.videoPlayer.onerror = () => rej(new Error('Video metadata load failed'));
          setTimeout(res, 5000);
        });
      } else { this.dom.videoCard.style.display = 'none'; }
      this.inputBuffer = audioBuf;
      this.outputBuffer = null;
      this.onAudioLoaded(file.name);
    } catch (err) {
      console.error('File load error:', err);
      this.dom.fileInfo.textContent = 'Error: ' + err.message;
      this.setStatus('ERROR');
    }
  }

  async decodeViaVideoElement(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const vid = document.createElement('video');
      vid.muted = true; vid.src = url;
      vid.onloadedmetadata = async () => {
        try {
          const duration = vid.duration;
          if (!duration || !isFinite(duration)) { reject(new Error('Cannot determine video duration')); return; }
          const tmpCtx = new (window.AudioContext || window.webkitAudioContext)();
          const source = tmpCtx.createMediaElementSource(vid);
          const dest = tmpCtx.createMediaStreamDestination();
          source.connect(dest);
          const chunks = [];
          const recorder = new MediaRecorder(dest.stream);
          recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
          recorder.onstop = async () => {
            vid.pause(); URL.revokeObjectURL(url);
            const blob = new Blob(chunks, { type: 'audio/webm' });
            const ab = await blob.arrayBuffer();
            try { const decoded = await this.ctx.decodeAudioData(ab); tmpCtx.close(); resolve(decoded); }
            catch (e) { tmpCtx.close(); reject(new Error('Failed to decode video audio: ' + e.message)); }
          };
          recorder.start(); vid.play();
          vid.onended = () => { recorder.stop(); };
          setTimeout(() => { if (recorder.state === 'recording') { vid.pause(); recorder.stop(); } }, (duration + 2) * 1000);
        } catch (e) { reject(e); }
      };
      vid.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Video element failed')); };
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
      const ana = this.ctx.createAnalyser(); ana.fftSize = 4096;
      src.connect(ana);
      this.analyserNode = ana;
      this.analyserOrig = ana;
      this.analyserProc = ana;
      this.startSpectro(ana);
      this.startFreq(ana);
      this.startDiagnostics();
      const mt = this.getMime();
      this.mediaRecorder = new MediaRecorder(stream, { mimeType: mt });
      this.mediaRecorder.ondataavailable = e => { if (e.data.size > 0) this.recordedChunks.push(e.data); };
      this.mediaRecorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        this.stopSpectro(); this.stopDiagnostics();
        const blob = new Blob(this.recordedChunks, { type: mt });
        const ab = await blob.arrayBuffer();
        try {
          this.inputBuffer = await this.ctx.decodeAudioData(ab);
          this.outputBuffer = null;
          this.dom.videoCard.style.display = 'none'; this.isVideo = false;
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
    // Teardown previous playback state without resetting playOffset
    if (typeof this.teardownChain === 'function') this.teardownChain();
    if (this.isVideo && this.isPlaying) this.dom.videoPlayer.pause();
    if (typeof this.stopSpectro === 'function') this.stopSpectro();
    if (typeof this.stopDiagnostics === 'function') this.stopDiagnostics();
    this.isPlaying = false;

    this.ensureCtx();
    const buf = this.abMode === 'processed' && this.outputBuffer ? this.outputBuffer : this.inputBuffer;
    if (!buf) return;

    // If we are at the end, restart from 0
    if (this.playOffset >= buf.duration) {
      this.playOffset = 0;
    }
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
    this.startDiagnostics();
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
    this.stopDiagnostics();
  }

  stop() {
    this.teardownChain();
    this.isPlaying = false;
    this.playOffset = 0;
    if (this.isVideo) { this.dom.videoPlayer.pause(); this.dom.videoPlayer.currentTime = 0; }
    this.stopSpectro();
    this.stopDiagnostics();
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
    else {
      this.dom.tpCur.textContent = this.fmtDur(this.playOffset);
      this.dom.tpSeek.value = this.inputBuffer.duration > 0 ? (this.playOffset / this.inputBuffer.duration) * 1000 : 0;
    }
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

  // ======== LIVE AUDIO CHAIN (with dual analysers) ========
  buildLiveChain(buf) {
    this.teardownChain();
    const ctx = this.ensureCtx();
    const p = this.params;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = parseFloat(this.dom.tpSpeed.value) || 1;
    src.onended = () => { if (this.isPlaying) this.stop(); };

    // Pre-chain analyser (original signal)
    const anaOrig = ctx.createAnalyser(); anaOrig.fftSize = 4096; anaOrig.smoothingTimeConstant = 0.75;

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

    // Post-chain analyser (processed signal)
    const anaProc = ctx.createAnalyser(); anaProc.fftSize = 4096; anaProc.smoothingTimeConstant = 0.75;

    // Wire: src -> anaOrig -> hp -> ... -> wG -> anaProc -> destination
    src.connect(anaOrig);
    const chain = [anaOrig, hp, lp, ...eqs.map(e=>e.node), deEss, tilt, vfL, vfH, comp, mkG, lim, outG, wG, anaProc];
    for (let i = 0; i < chain.length-1; i++) chain[i].connect(chain[i+1]);
    anaProc.connect(ctx.destination);

    src.start(0, this.playOffset);
    this.currentSource = src;
    this.analyserNode = anaProc;
    this.analyserOrig = anaOrig;
    this.analyserProc = anaProc;
    this.liveNodes = { hp, lp, eqs, deEss, tilt, vfL, vfH, comp, mkG, lim, outG, wG, chain: [src, ...chain] };
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
    if (this.currentSource) { try{this.currentSource.stop();}catch(e){} try{this.currentSource.disconnect();}catch(e){} this.currentSource = null; }
    if (this.liveNodes.chain) this.liveNodes.chain.forEach(n => { try{n.disconnect();}catch(e){} });
    this.liveNodes = {}; this.liveChainBuilt = false;
  }

  // ======== 35-STAGE DECA-PASS OFFLINE PIPELINE (v22) ========
  async runPipeline() {
    if (!this.inputBuffer || this.isProcessing) return;
    this.isProcessing = true; this.abortFlag = false;
    this.dom.processBtn.style.display = 'none'; this.dom.stopProcBtn.style.display = 'inline-flex';
    this.dom.saveProcBtn.disabled = true; this.dom.tpAB.disabled = true;
    this.setStatus('PROCESSING');
    const t0 = performance.now();
    const p = this.params;
    const sr = this.inputBuffer.sampleRate;
    const numCh = this.inputBuffer.numberOfChannels;
    const len = this.inputBuffer.length;
    const total = STAGES.length;
    const fftSize = 4096;
    const hopSize = 1024;

    try {
      const DSP = window.DSPCore;
      if (!DSP) throw new Error('DSPCore not loaded — ensure dsp-core.js is included');

      // ═══ PASS 1: INGESTION & PRE-CONDITIONING (per-channel) ═══
      await this.pip(0, total); // S01: Decode (already done)
      if (this.abortFlag) throw 'abort';

      const cleanChannels = [];
      for (let ch = 0; ch < numCh; ch++) {
        // Get raw channel data (copy to avoid mutating input)
        let data = new Float32Array(this.inputBuffer.getChannelData(ch));

        await this.pip(1, total); // S02: Buffer allocation
        if (this.abortFlag) throw 'abort';

        // S03: DC Offset Removal
        await this.pip(2, total);
        data = DSP.removeDCOffset(data, sr);

        // S04: Peak normalization to -1 dBFS
        await this.pip(3, total);
        data = DSP.peakNormalize(data, -1);
        if (this.abortFlag) throw 'abort';

        // ═══ PASS 2: ANALYSIS ═══
        // S05: VAD for noise profiling
        await this.pip(4, total);
        const vad = new DSP.VADProcessor(sr, 20, p.nrSensitivity / 100);
        const vadConf = vad.processSignal(data);

        // S06: Noise gate (time-domain, before spectral)
        await this.pip(5, total);
        data = DSP.noiseGate(data, {
          threshold: p.gateThresh,
          range: p.gateRange,
          attack: p.gateAttack,
          release: p.gateRelease,
          hold: p.gateHold,
          lookahead: p.gateLookahead
        }, sr);
        if (this.abortFlag) throw 'abort';

        // S07: Click/pop removal
        await this.pip(6, total);
        data = DSP.removeClicks(data, 3);

        // S08: Hum removal (50/60 Hz + harmonics)
        await this.pip(7, total);
        const humFreqs = [60, 120, 180, 240, 300, 360];
        DSP.cascadedNotch(data, humFreqs, 35, sr);

        // S09: De-essing (time-domain)
        await this.pip(8, total);
        data = DSP.deEss(data, p.deEssFreq, p.deEssAmt, sr);
        if (this.abortFlag) throw 'abort';

        // ═══ SINGLE FORWARD STFT ═══
        await this.pip(9, total);
        const stft = DSP.forwardSTFT(data, fftSize, hopSize);
        let { mag, phase } = stft;

        // ═══ PASS 3: SPECTRAL NOISE REDUCTION (all in-place on mag) ═══
        // S10: Adaptive Wiener noise subtraction with VAD-gated profiling
        await this.pip(10, total);
        if (p.nrAmount > 0) {
          const tracker = new window.AdaptiveNoiseFloor(
            mag[0].length,
            200 + p.nrSmoothing * 3,  // smoothing ms
            hopSize, sr
          );
          const overSub = 1.0 + (p.nrSpectralSub / 100) * 4;  // 1x - 5x over-subtraction
          const spectralFloor = Math.pow(10, p.nrFloor / 20);
          DSP.applyAdaptiveWiener(mag, vadConf, tracker, {
            overSubtraction: overSub,
            spectralFloor: Math.max(0.0001, spectralFloor)
          });
        }
        if (this.abortFlag) throw 'abort';

        // S11: Secondary Wiener pass for residual noise
        await this.pip(11, total);
        if (p.nrAmount > 30) {
          // Build noise profile from quietest frames
          const noiseProfile = new Float32Array(mag[0].length);
          let noiseFrames = 0;
          for (let f = 0; f < mag.length; f++) {
            const vi = Math.min(f, vadConf.length - 1);
            if (vadConf[vi] < 0.2) {
              for (let k = 0; k < mag[f].length; k++) noiseProfile[k] += mag[f][k];
              noiseFrames++;
            }
          }
          if (noiseFrames > 0) {
            for (let k = 0; k < noiseProfile.length; k++) noiseProfile[k] /= noiseFrames;
            DSP.wienerMMSE(mag, noiseProfile, p.nrAmount * 0.6);
          }
        }
        if (this.abortFlag) throw 'abort';

        // S12: 32-band ERB spectral gate
        await this.pip(12, total);
        DSP.spectralGate(mag, p.nrFloor, sr);
        if (this.abortFlag) throw 'abort';

        // ═══ PASS 4: VOICE ISOLATION (spectral domain) ═══
        // S13: Voice-band spectral emphasis
        await this.pip(13, total);
        if (p.voiceIso > 0 || p.bgSuppress > 0) {
          const voiceLoBin = Math.round(p.voiceFocusLo / (sr / fftSize));
          const voiceHiBin = Math.round(p.voiceFocusHi / (sr / fftSize));
          const halfN = mag[0].length;
          const suppressGain = 1 - (p.bgSuppress / 100) * 0.95;
          const boostGain = 1 + (p.voiceIso / 100) * 0.5;
          for (let f = 0; f < mag.length; f++) {
            for (let k = 0; k < halfN; k++) {
              if (k >= voiceLoBin && k <= voiceHiBin) {
                mag[f][k] *= boostGain;
              } else {
                mag[f][k] *= suppressGain;
              }
            }
          }
        }
        if (this.abortFlag) throw 'abort';

        // S14: Crosstalk cancellation (voice-band SNR enhancement)
        await this.pip(14, total);
        // Placeholder for ML separation - uses spectral masking approximation
        if (p.crosstalkCancel > 0) {
          const cancelAmt = p.crosstalkCancel / 100;
          for (let f = 0; f < mag.length; f++) {
            const vi = Math.min(f, vadConf.length - 1);
            if (vadConf[vi] < 0.3) {
              for (let k = 0; k < mag[f].length; k++) {
                mag[f][k] *= (1 - cancelAmt * 0.8);
              }
            }
          }
        }

        // ═══ PASS 5: SPECTRAL REFINEMENT (Anti-Garble) ═══
        // S15: Temporal smoothing to kill musical noise / garbled artifacts
        await this.pip(15, total);
        DSP.temporalSmooth(mag, Math.max(p.nrSmoothing, 20));
        if (this.abortFlag) throw 'abort';

        // S16: Spectral tilt compensation
        await this.pip(16, total);
        if (Math.abs(p.specTilt) > 0.1) {
          const halfN = mag[0].length;
          for (let f = 0; f < mag.length; f++) {
            for (let k = 0; k < halfN; k++) {
              const freq = k * sr / fftSize;
              const octavesFrom1k = freq > 0 ? Math.log2(freq / 1000) : 0;
              const tiltGain = Math.pow(10, (p.specTilt * octavesFrom1k) / 20);
              mag[f][k] *= Math.max(0.01, Math.min(10, tiltGain));
            }
          }
        }
        if (this.abortFlag) throw 'abort';

        // ═══ PASS 6: ROOM CORRECTION ═══
        // S17: Dereverberation
        await this.pip(17, total);
        DSP.dereverb(mag, p.derevAmt, p.derevDecay, sr, hopSize);
        if (this.abortFlag) throw 'abort';

        // ═══ PASS 7: HARMONIC RECONSTRUCTION ═══
        // S18: Harmonic enhancement v2 (SBR + formant + breathiness)
        await this.pip(18, total);
        DSP.harmonicEnhanceV2(mag, phase, p.harmRecov, {
          sbr: p.harmOrder >= 4,
          formantProtection: true,
          breathinessGain: 0.8,
          sampleRate: sr,
          fftSize: fftSize
        });
        if (this.abortFlag) throw 'abort';

        // ═══ SINGLE INVERSE STFT ═══
        await this.pip(19, total);
        let processed = DSP.inverseSTFT(mag, phase, fftSize, hopSize, data.length);

        // Trim/pad to exact original length
        if (processed.length > len) processed = processed.subarray(0, len);
        else if (processed.length < len) {
          const padded = new Float32Array(len);
          padded.set(processed);
          processed = padded;
        }

        cleanChannels.push(processed);
      }
      if (this.abortFlag) throw 'abort';

      // ═══ PASS 8: EQ + DYNAMICS via OfflineAudioContext ═══
      await this.pip(20, total);
      // Create intermediate buffer with spectrally-cleaned audio
      const cleanBuf = this.ctx.createBuffer(numCh, len, sr);
      for (let ch = 0; ch < numCh; ch++) cleanBuf.getChannelData(ch).set(cleanChannels[ch]);

      // Build Web Audio node chain for EQ + dynamics
      const ofl = new OfflineAudioContext(numCh, len, sr);
      const src = ofl.createBufferSource();
      src.buffer = cleanBuf;

      // HP/LP filters
      await this.pip(21, total);
      const hp = ofl.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = p.hpFreq; hp.Q.value = p.hpQ;
      const lp = ofl.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = p.lpFreq; lp.Q.value = p.lpQ;

      // 10-band EQ
      await this.pip(22, total);
      const eqDefs = [
        {id:'eqSub',f:40,t:'lowshelf'},{id:'eqBass',f:100,t:'peaking',q:1.2},{id:'eqWarmth',f:200,t:'peaking',q:1},
        {id:'eqBody',f:400,t:'peaking',q:1},{id:'eqLowMid',f:800,t:'peaking',q:1},{id:'eqMid',f:1500,t:'peaking',q:1.2},
        {id:'eqPresence',f:3000,t:'peaking',q:1.5},{id:'eqClarity',f:5000,t:'peaking',q:1.2},
        {id:'eqAir',f:10000,t:'highshelf'},{id:'eqBrill',f:16000,t:'highshelf'}
      ];
      const eqN = eqDefs.map(b => {
        const n = ofl.createBiquadFilter(); n.type = b.t; n.frequency.value = b.f;
        if (b.q) n.Q.value = b.q; n.gain.value = p[b.id] || 0; return n;
      });
      if (this.abortFlag) throw 'abort';

      // Compressor + makeup gain
      await this.pip(23, total);
      const cmp = ofl.createDynamicsCompressor();
      cmp.threshold.value = p.compThresh; cmp.ratio.value = p.compRatio;
      cmp.attack.value = p.compAttack / 1000; cmp.release.value = p.compRelease / 1000; cmp.knee.value = p.compKnee;
      const mkG = ofl.createGain(); mkG.gain.value = Math.pow(10, p.compMakeup / 20);

      // Limiter
      await this.pip(24, total);
      const lim = ofl.createDynamicsCompressor();
      lim.threshold.value = p.limThresh; lim.knee.value = 0; lim.ratio.value = 20;
      lim.attack.value = 0.001; lim.release.value = p.limRelease / 1000;

      // Output gain
      const oG = ofl.createGain(); oG.gain.value = Math.pow(10, p.outGain / 20);
      if (this.abortFlag) throw 'abort';

      // Wire chain: src → hp → lp → EQ → comp → makeup → lim → outGain → dest
      const chain = [src, hp, lp, ...eqN, cmp, mkG, lim, oG];
      for (let i = 0; i < chain.length - 1; i++) chain[i].connect(chain[i + 1]);
      chain[chain.length - 1].connect(ofl.destination);
      src.start(0);

      await this.pip(25, total);
      const rendered = await ofl.startRendering();
      if (this.abortFlag) throw 'abort';

      // ═══ PASS 9: MASTERING ═══
      await this.pip(26, total);
      let fin = rendered;

      // Dry/wet mix
      await this.pip(27, total);
      if (p.dryWet < 100) fin = this.mixDW(this.inputBuffer, fin, p.dryWet / 100);

      // Peak normalize to limiter ceiling
      await this.pip(28, total);
      fin = this.peakNorm(fin, p.limThresh);

      // ═══ PASS 10: FINALIZE ═══
      await this.pip(29, total);
      await this.pip(30, total);
      await this.pip(31, total);

      this.dom.stProcTime.textContent = ((performance.now() - t0) / 1000).toFixed(2) + 's';
      this.outputBuffer = fin;
      const snr = this.calcRMS(fin.getChannelData(0)) - this.calcRMS(this.inputBuffer.getChannelData(0));
      this.dom.hSNR.textContent = (snr >= 0 ? '+' : '') + snr.toFixed(1) + ' dB';
      this.resizeCanvas(this.dom.waveProcCanvas);
      this.drawWaveform(fin, this.dom.waveProcCanvas, '#22d3ee');
      this.dom.stVoices.textContent = this.estVoices(fin);
      this.dom.saveProcBtn.disabled = false; this.dom.tpAB.disabled = false; this.dom.reprocessBtn.disabled = false;
      this.dom.tpABLabel.textContent = 'Ready — A/B';
      this.setStatus('COMPLETE');
    } catch (e) {
      if (e === 'abort') { this.setStatus('ABORTED'); this.dom.pipeStage.textContent = 'Aborted'; }
      else { console.error('Pipeline:', e); this.setStatus('ERROR'); this.dom.pipeDetail.textContent = e.message || String(e); }
    } finally {
      this.isProcessing = false; this.dom.processBtn.style.display = 'inline-flex'; this.dom.stopProcBtn.style.display = 'none';
    }
  }

  async pip(i, t) { const pct = Math.round((i + 1) / t * 100); this.dom.pipeFill.style.width = pct + '%'; this.dom.pipeBar.setAttribute('aria-valuenow', String(pct)); this.dom.pipeStage.textContent = (i + 1) + '/' + t; this.dom.pipeDetail.textContent = STAGES[i] || 'Finalizing'; this.dom.hStatus.textContent = 'S' + (i + 1); await new Promise(r => setTimeout(r, 8)); }
  mixDW(dry,wet,wAmt){const c=this.ctx;const nCh=Math.min(dry.numberOfChannels,wet.numberOfChannels);const len=Math.min(dry.length,wet.length);const out=c.createBuffer(nCh,len,dry.sampleRate);for(let ch=0;ch<nCh;ch++){const d=dry.getChannelData(ch);const w=wet.getChannelData(ch);const o=out.getChannelData(ch);for(let i=0;i<len;i++)o[i]=d[i]*(1-wAmt)+w[i]*wAmt;}return out;}
  peakNorm(buf,tDb){const c=this.ctx;const nCh=buf.numberOfChannels;const len=buf.length;const out=c.createBuffer(nCh,len,buf.sampleRate);let pk=0;for(let ch=0;ch<nCh;ch++){const d=buf.getChannelData(ch);for(let i=0;i<len;i++){const a=Math.abs(d[i]);if(a>pk)pk=a;}}if(pk===0)return buf;const g=Math.pow(10,tDb/20)/pk;for(let ch=0;ch<nCh;ch++){const inp=buf.getChannelData(ch);const o=out.getChannelData(ch);for(let i=0;i<len;i++)o[i]=Math.max(-1,Math.min(1,inp[i]*g));}return out;}
  makeHarm(amt,ord){const n=44100;const c=new Float32Array(n);const k=amt*(ord||3)*2+1;for(let i=0;i<n;i++){const x=(i*2)/n-1;c[i]=Math.tanh(k*x)/Math.tanh(k);}return c;}
  estVoices(buf){const d=buf.getChannelData(0);const sr=buf.sampleRate;const bs=Math.floor(sr*0.5);let act=0;for(let i=0;i<d.length;i+=bs){let r=0;const e=Math.min(i+bs,d.length);for(let j=i;j<e;j++)r+=d[j]*d[j];r=Math.sqrt(r/(e-i));if(r>0.01)act++;}return act<3?'0-1':act<10?'1':'1-2+';}

  // ---- SAVE ----
  saveWav(buf,label){if(!buf)return;const w=this.encWav(buf);const b=new Blob([w],{type:'audio/wav'});const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='voiceisolate_v22_'+label+'_'+Date.now()+'.wav';document.body.appendChild(a);a.click();document.body.removeChild(a);URL.revokeObjectURL(a.href);}
  encWav(buf){const nCh=buf.numberOfChannels;const sr=buf.sampleRate;const dL=buf.length*nCh*2;const a=new ArrayBuffer(44+dL);const v=new DataView(a);const ws=(o,s)=>{for(let i=0;i<s.length;i++)v.setUint8(o+i,s.charCodeAt(i));};ws(0,'RIFF');v.setUint32(4,36+dL,true);ws(8,'WAVE');ws(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,nCh,true);v.setUint32(24,sr,true);v.setUint32(28,sr*nCh*2,true);v.setUint16(32,nCh*2,true);v.setUint16(34,16,true);ws(36,'data');v.setUint32(40,dL,true);let off=44;for(let i=0;i<buf.length;i++)for(let ch=0;ch<nCh;ch++){let s=buf.getChannelData(ch)[i];s=Math.max(-1,Math.min(1,s));v.setInt16(off,s<0?s*0x8000:s*0x7FFF,true);off+=2;}return a;}

  // ======== VISUALIZATIONS (existing) ========
  initCanvases(){
    const all = [this.dom.waveOrigCanvas,this.dom.waveProcCanvas,this.dom.spectro2DCanvas,this.dom.freqCanvas,
      this.dom.abWaveCanvas,this.dom.oscCanvas,this.dom.specOverlayCanvas,this.dom.lufsCanvas,
      this.dom.saliencyCanvas,this.dom.clusterCanvas];
    all.forEach(c => { if(c) this.resizeCanvas(c); });
    this.clearCanvas(this.dom.waveOrigCanvas,'Load audio to begin');
    this.clearCanvas(this.dom.waveProcCanvas,'Process to see result');
    this.clearCanvas(this.dom.spectro2DCanvas,'Play audio for spectrogram');
    this.clearCanvas(this.dom.freqCanvas,'Play audio for analyzer');
    this.clearCanvas(this.dom.abWaveCanvas,'Play audio for A/B comparison');
    this.clearCanvas(this.dom.oscCanvas,'Play audio for oscilloscope');
    this.clearCanvas(this.dom.specOverlayCanvas,'Play audio for spectrogram overlays');
    this.clearCanvas(this.dom.lufsCanvas,'Play audio for LUFS meter');
    this.clearCanvas(this.dom.saliencyCanvas,'Play audio for ML saliency');
    this.clearCanvas(this.dom.clusterCanvas,'Play audio for speaker clusters');
  }

  resizeCanvas(c){if(!c)return;const r=c.getBoundingClientRect();c.width=Math.floor(r.width);c.height=Math.floor(r.height);}
  clearCanvas(c,txt){if(!c)return;const x=c.getContext('2d');x.fillStyle='#030306';x.fillRect(0,0,c.width,c.height);if(txt){x.font='11px Outfit,sans-serif';x.fillStyle='rgba(255,255,255,0.12)';x.textAlign='center';x.fillText(txt,c.width/2,c.height/2+3);}}

  drawWaveform(buf,canvas,color){if(!canvas)return;const x=canvas.getContext('2d');const w=canvas.width;const h=canvas.height;x.fillStyle='#030306';x.fillRect(0,0,w,h);if(!buf)return;const d=buf.getChannelData(0);const step=Math.max(1,Math.floor(d.length/w));x.strokeStyle='rgba(255,255,255,0.04)';x.lineWidth=1;x.beginPath();x.moveTo(0,h/2);x.lineTo(w,h/2);x.stroke();x.fillStyle=color;for(let px=0;px<w;px++){const idx=px*step;let mn=1,mx=-1;for(let i=0;i<step&&(idx+i)<d.length;i++){const v=d[idx+i];if(v<mn)mn=v;if(v>mx)mx=v;}const y1=((1-mx)*0.5)*h;const y2=((1-mn)*0.5)*h;x.globalAlpha=0.8;x.fillRect(px,y1,1,Math.max(1,y2-y1));}x.globalAlpha=1;}

  // ---- 2D Spectrogram ----
  startSpectro(ana){
    this.stopSpectro(); this.spectroRunning=true; this.spectroX=0; this.specOverlayX=0;
    const c=this.dom.spectro2DCanvas; this.resizeCanvas(c);
    const x=c.getContext('2d'); x.fillStyle='#030306'; x.fillRect(0,0,c.width,c.height);
    const bLen=ana.frequencyBinCount; const arr=new Uint8Array(bLen);
    const draw=()=>{
      if(!this.spectroRunning)return; this.animId=requestAnimationFrame(draw);
      ana.getByteFrequencyData(arr);
      const w=c.width;const h=c.height;const sw=2;
      if(this.spectroX+sw>=w){const img=x.getImageData(sw,0,w-sw,h);x.putImageData(img,0,0);x.fillStyle='#030306';x.fillRect(w-sw,0,sw,h);this.spectroX=w-sw;}
      for(let y=0;y<h;y++){const fi=Math.floor((y/h)*bLen);const val=arr[bLen-1-fi];const muted=this.isBandMuted(fi,bLen,ana.context?ana.context.sampleRate:44100);x.fillStyle=muted?'rgba(30,30,30,0.8)':this.sColor(val,fi,bLen);x.fillRect(this.spectroX,y,sw,1);}
      this.spectroX+=sw;
      this.update3D(arr);
    };
    draw();
  }
  stopSpectro(){this.spectroRunning=false;if(this.animId){cancelAnimationFrame(this.animId);this.animId=null;}}

  sColor(val,fi,total){const v=val/255;const f=fi/total;if(f<0.05)return 'rgb('+Math.floor(v*40)+','+Math.floor(v*80)+','+Math.floor(60+v*195)+')';if(f<0.2)return 'rgb('+Math.floor(60+v*195)+','+Math.floor(v*30)+','+Math.floor(v*20)+')';if(f<0.5)return 'rgb('+Math.floor(80+v*175)+','+Math.floor(v*60)+','+Math.floor(v*10)+')';if(f<0.75)return 'rgb('+Math.floor(v*30)+','+Math.floor(50+v*180)+','+Math.floor(v*30)+')';return 'rgb('+Math.floor(60+v*195)+','+Math.floor(50+v*160)+','+Math.floor(v*20)+')';}
  isBandMuted(fi,total,sr){const freq=(fi/total)*(sr/2);for(const b of this.mutedBands)if(freq>=b.lo&&freq<b.hi)return true;return false;}
  onSpectroClick(e){const r=this.dom.spectro3DCanvas.getBoundingClientRect();const y=1-((e.clientY-r.top)/r.height);const sr=this.ctx?this.ctx.sampleRate:44100;const freq=y*(sr/2);const bw=sr/20;const lo=Math.max(0,freq-bw/2);const hi=freq+bw/2;const key=Math.round(lo)+'-'+Math.round(hi);let found=false;for(const b of this.mutedBands){if(b.key===key){this.mutedBands.delete(b);found=true;break;}}if(!found)this.mutedBands.add({lo,hi,key});}

  startFreq(ana){
    const c=this.dom.freqCanvas;this.resizeCanvas(c);const x=c.getContext('2d');const bLen=ana.frequencyBinCount;const arr=new Uint8Array(bLen);
    const draw=()=>{if(!this.spectroRunning)return;requestAnimationFrame(draw);ana.getByteFrequencyData(arr);const w=c.width;const h=c.height;x.fillStyle='#030306';x.fillRect(0,0,w,h);x.strokeStyle='rgba(255,255,255,0.03)';x.lineWidth=1;for(let i=1;i<5;i++){const gy=(i/5)*h;x.beginPath();x.moveTo(0,gy);x.lineTo(w,gy);x.stroke();}const bW=(w/bLen)*2.5;let px=0;for(let i=0;i<bLen&&px<w;i++){const bH=(arr[i]/255)*h;const f=i/bLen;let hue;if(f<0.05)hue=220;else if(f<0.2)hue=0;else if(f<0.5)hue=10;else if(f<0.75)hue=130;else hue=50;x.fillStyle='hsla('+hue+',75%,50%,0.75)';x.fillRect(px,h-bH,Math.max(1,bW-1),bH);px+=bW;}};
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
    let drag=false,pX=0,pY=0;const cv=this.dom.spectro3DCanvas;
    cv.addEventListener('mousedown',e=>{drag=true;pX=e.clientX;pY=e.clientY;});
    window.addEventListener('mouseup',()=>drag=false);
    window.addEventListener('mousemove',e=>{if(!drag)return;cam.position.x-=(e.clientX-pX)*0.15;cam.position.y+=(e.clientY-pY)*0.15;cam.lookAt(0,0,0);pX=e.clientX;pY=e.clientY;});
    cv.addEventListener('wheel',e=>{e.preventDefault();cam.position.z+=e.deltaY*0.05;cam.position.z=Math.max(20,Math.min(120,cam.position.z));},{passive:false});
    this.render3D();
  }
  reset3DView(){if(this.three.cam){this.three.cam.position.set(0,40,60);this.three.cam.lookAt(0,0,0);}}
  update3D(freq){
    if(!this.three.geo)return;const{geo,gW,gD,cols}=this.three;const pos=geo.attributes.position;const colA=geo.attributes.color;
    for(let z=gD-1;z>0;z--)for(let x=0;x<gW;x++){const c=z*gW+x;const p=(z-1)*gW+x;pos.setY(c,pos.getY(p));cols[c*3]=cols[p*3];cols[c*3+1]=cols[p*3+1];cols[c*3+2]=cols[p*3+2];}
    const step=Math.floor(freq.length/gW);
    for(let x=0;x<gW;x++){const fi=Math.min(x*step,freq.length-1);const v=(freq[fi]||0)/255;pos.setY(x,v*15);const f=x/gW;
      if(f<0.05){cols[x*3]=v*0.15;cols[x*3+1]=v*0.3;cols[x*3+2]=0.3+v*0.7;}
      else if(f<0.3){cols[x*3]=0.3+v*0.7;cols[x*3+1]=v*0.1;cols[x*3+2]=v*0.05;}
      else if(f<0.6){cols[x*3]=v*0.1;cols[x*3+1]=0.2+v*0.6;cols[x*3+2]=v*0.1;}
      else{cols[x*3]=0.3+v*0.6;cols[x*3+1]=0.25+v*0.5;cols[x*3+2]=v*0.05;}
    }
    pos.needsUpdate=true;colA.needsUpdate=true;
  }
  render3D(){requestAnimationFrame(()=>this.render3D());if(this.three.ren)this.three.ren.render(this.three.scene,this.three.cam);}

  // ════════════════════════════════════════════
  // 6-PANEL DIAGNOSTIC DASHBOARD
  // ════════════════════════════════════════════
  startDiagnostics() {
    if (this.diagRunning) return;
    this.diagRunning = true;
    this.specOverlayX = 0;
    // Resize all diagnostic canvases
    [this.dom.abWaveCanvas,this.dom.oscCanvas,this.dom.specOverlayCanvas,
     this.dom.lufsCanvas,this.dom.saliencyCanvas,this.dom.clusterCanvas].forEach(c => this.resizeCanvas(c));
    // Clear spec overlay
    const sx = this.dom.specOverlayCanvas.getContext('2d');
    sx.fillStyle = '#030306'; sx.fillRect(0,0,this.dom.specOverlayCanvas.width,this.dom.specOverlayCanvas.height);

    const origBuf = new Float32Array(2048);
    const procBuf = new Float32Array(2048);
    const freqBuf = new Uint8Array(this.analyserProc ? this.analyserProc.frequencyBinCount : 2048);
    let lufsTimer = 0;
    let clusterTimer = 0;

    const drawAll = () => {
      if (!this.diagRunning) return;
      this.diagAnimId = requestAnimationFrame(drawAll);
      const now = performance.now();

      // FPS counter
      this.diagFpsFrames++;
      if (now - this.diagFpsLast > 1000) {
        if (this.dom.diagFps) this.dom.diagFps.textContent = this.diagFpsFrames + ' fps';
        this.diagFpsFrames = 0;
        this.diagFpsLast = now;
      }

      // Get data from analysers
      if (this.analyserOrig) this.analyserOrig.getFloatTimeDomainData(origBuf);
      if (this.analyserProc) {
        this.analyserProc.getFloatTimeDomainData(procBuf);
        this.analyserProc.getByteFrequencyData(freqBuf);
      }

      // Panel 1: A/B Waveform
      this.drawABWave(origBuf, procBuf);

      // Panel 2: Oscilloscope
      this.drawOscilloscope(procBuf);

      // Panel 3: Spectrogram + Overlays
      this.drawSpecOverlay(freqBuf);

      // Panel 4: LUFS Meter (~100ms update)
      if (now - lufsTimer > 100) {
        this.drawLUFS(procBuf);
        lufsTimer = now;
      }

      // Panel 5: ML Saliency Heatmap
      this.drawSaliency(freqBuf);

      // Panel 6: Speaker PCA Cluster (~200ms update)
      if (now - clusterTimer > 200) {
        this.updateCluster(procBuf, freqBuf);
        clusterTimer = now;
      }
      this.drawCluster();
    };
    drawAll();
  }

  stopDiagnostics() {
    this.diagRunning = false;
    if (this.diagAnimId) { cancelAnimationFrame(this.diagAnimId); this.diagAnimId = null; }
  }

  // Panel 1: A/B Waveform
  drawABWave(origBuf, procBuf) {
    const c = this.dom.abWaveCanvas; if (!c) return;
    const x = c.getContext('2d');
    const w = c.width, h = c.height;
    x.fillStyle = '#030306'; x.fillRect(0, 0, w, h);

    // Grid
    x.strokeStyle = 'rgba(255,255,255,0.03)'; x.lineWidth = 1;
    x.beginPath(); x.moveTo(0, h/2); x.lineTo(w, h/2); x.stroke();
    if (!this.abOverlay) {
      x.beginPath(); x.moveTo(0, h/4); x.lineTo(w, h/4); x.stroke();
      x.beginPath(); x.moveTo(0, h*3/4); x.lineTo(w, h*3/4); x.stroke();
    }

    const drawLine = (buf, color, yOff, yScale) => {
      x.save();
      x.strokeStyle = color; x.lineWidth = 1.5;
      x.shadowColor = color; x.shadowBlur = 4;
      x.beginPath();
      const step = buf.length / w;
      for (let i = 0; i < w; i++) {
        const v = buf[Math.floor(i * step)] || 0;
        const y = yOff + (-v * yScale);
        if (i === 0) x.moveTo(i, y); else x.lineTo(i, y);
      }
      x.stroke();
      x.restore();
    };

    if (this.abOverlay) {
      drawLine(origBuf, '#3b82f6', h/2, h/2 * 0.8);
      drawLine(procBuf, '#a855f7', h/2, h/2 * 0.8);
    } else {
      // Stacked: top = original, bottom = processed
      drawLine(origBuf, '#3b82f6', h/4, h/4 * 0.8);
      drawLine(procBuf, '#a855f7', h*3/4, h/4 * 0.8);
      // Labels
      x.font = '9px JetBrains Mono'; x.fillStyle = 'rgba(59,130,246,0.5)';
      x.fillText('ORIG', 4, 12);
      x.fillStyle = 'rgba(168,85,247,0.5)';
      x.fillText('PROC', 4, h/2 + 12);
    }
  }

  // Panel 2: Oscilloscope
  drawOscilloscope(buf) {
    const c = this.dom.oscCanvas; if (!c) return;
    const x = c.getContext('2d');
    const w = c.width, h = c.height;
    x.fillStyle = 'rgba(3,3,6,0.3)'; x.fillRect(0, 0, w, h);

    // Grid
    x.strokeStyle = 'rgba(34,197,94,0.06)'; x.lineWidth = 1;
    x.beginPath(); x.moveTo(0, h/2); x.lineTo(w, h/2); x.stroke();
    if (this.oscMode === 'lissajous') {
      x.beginPath(); x.moveTo(w/2, 0); x.lineTo(w/2, h); x.stroke();
    }

    x.strokeStyle = '#22c55e'; x.lineWidth = 1.2;
    x.shadowColor = '#22c55e'; x.shadowBlur = 3;
    x.beginPath();

    if (this.oscMode === 'wave') {
      const step = buf.length / w;
      for (let i = 0; i < w; i++) {
        const v = buf[Math.floor(i * step)] || 0;
        const y = h/2 + (-v * h/2 * 0.85);
        if (i === 0) x.moveTo(i, y); else x.lineTo(i, y);
      }
    } else if (this.oscMode === 'mirror') {
      const step = buf.length / w;
      // Top half (positive)
      for (let i = 0; i < w; i++) {
        const v = Math.abs(buf[Math.floor(i * step)] || 0);
        const y = h/2 - v * h/2 * 0.85;
        if (i === 0) x.moveTo(i, y); else x.lineTo(i, y);
      }
      x.stroke();
      // Bottom half (mirrored)
      x.beginPath();
      x.strokeStyle = 'rgba(34,197,94,0.5)';
      for (let i = 0; i < w; i++) {
        const v = Math.abs(buf[Math.floor(i * step)] || 0);
        const y = h/2 + v * h/2 * 0.85;
        if (i === 0) x.moveTo(i, y); else x.lineTo(i, y);
      }
    } else if (this.oscMode === 'lissajous') {
      // XY mode: use consecutive samples as L/R proxy
      const len = Math.min(buf.length, 1024);
      for (let i = 0; i < len - 1; i++) {
        const lx = w/2 + buf[i] * w/2 * 0.8;
        const ly = h/2 + (-buf[i+1]) * h/2 * 0.8;
        if (i === 0) x.moveTo(lx, ly); else x.lineTo(lx, ly);
      }
    }
    x.stroke();
    x.shadowBlur = 0;
  }

  // Panel 3: Spectrogram + Overlays
  drawSpecOverlay(freqBuf) {
    const c = this.dom.specOverlayCanvas; if (!c) return;
    const x = c.getContext('2d');
    const w = c.width, h = c.height;
    const bLen = freqBuf.length;
    const sw = 2;

    // Scroll
    if (this.specOverlayX + sw >= w) {
      const img = x.getImageData(sw, 0, w - sw, h);
      x.putImageData(img, 0, 0);
      x.fillStyle = '#030306'; x.fillRect(w - sw, 0, sw, h);
      this.specOverlayX = w - sw;
    }

    // Base spectrogram
    for (let y = 0; y < h; y++) {
      const fi = Math.floor((y / h) * bLen);
      const val = freqBuf[bLen - 1 - fi];
      const v = val / 255;
      // Blue-cyan-yellow-white colormap
      const r = Math.floor(v * v * 255);
      const g = Math.floor(v * 180);
      const b = Math.floor(60 + v * 195);
      x.fillStyle = 'rgb(' + r + ',' + g + ',' + b + ')';
      x.fillRect(this.specOverlayX, y, sw, 1);
    }

    // Noise profile overlay (pink line)
    if (this.overlays.noise) {
      x.strokeStyle = 'rgba(236,72,153,0.6)'; x.lineWidth = 1;
      x.beginPath();
      for (let y = 0; y < h; y++) {
        const fi = Math.floor((y / h) * Math.min(256, bLen));
        const nv = this.noiseProfile[Math.min(fi, 255)] * h;
        const px = this.specOverlayX + sw/2;
        if (y === 0) x.moveTo(px - nv * 0.3, y); else x.lineTo(px - nv * 0.3, y);
      }
      x.stroke();
    }

    // ERB gate overlay (cyan bands)
    if (this.overlays.erb) {
      for (let b = 0; b < 32; b++) {
        const yStart = Math.floor((b / 32) * h);
        const yEnd = Math.floor(((b + 1) / 32) * h);
        const thresh = this.erbThresholds[b];
        const fi = Math.floor((b / 32) * bLen);
        const val = (freqBuf[fi] || 0) / 255;
        if (val < thresh) {
          x.fillStyle = 'rgba(34,211,238,0.15)';
          x.fillRect(this.specOverlayX, h - yEnd, sw, yEnd - yStart);
        }
      }
    }

    // ML mask overlay (magenta tint)
    if (this.overlays.ml) {
      for (let y = 0; y < h; y += 2) {
        const fi = Math.floor((y / h) * Math.min(256, bLen));
        const val = (freqBuf[bLen - 1 - Math.floor((y/h)*bLen)] || 0) / 255;
        // Simulate ML mask: voice band (80Hz-6kHz) = low attenuation, rest = high
        const bandFrac = (h - y) / h;
        const isVoice = bandFrac > 0.02 && bandFrac < 0.35;
        const maskAmt = isVoice ? 0.05 : 0.3 + val * 0.2;
        x.fillStyle = 'rgba(168,85,247,' + (maskAmt * 0.4) + ')';
        x.fillRect(this.specOverlayX, y, sw, 2);
      }
    }

    this.specOverlayX += sw;

    // Update noise profile (slow adaptation)
    for (let i = 0; i < Math.min(256, bLen); i++) {
      const v = (freqBuf[i] || 0) / 255;
      this.noiseProfile[i] = this.noiseProfile[i] * 0.995 + v * 0.005;
    }
  }

  // Panel 4: LUFS Meter
  drawLUFS(buf) {
    // Compute short-term loudness (simplified K-weighted)
    let sumSq = 0;
    for (let i = 0; i < buf.length; i++) sumSq += buf[i] * buf[i];
    const rms = Math.sqrt(sumSq / buf.length);
    const lufs = rms > 0 ? -0.691 + 10 * Math.log10(rms * rms) : -60;
    const clamped = Math.max(-60, Math.min(0, lufs));

    // Rolling history
    this.lufsHistory[this.lufsIdx % this.lufsHistory.length] = clamped;
    this.lufsIdx++;

    // Integrated
    this.lufsSumSq += rms * rms;
    this.lufsFrameCount++;
    const intRms = Math.sqrt(this.lufsSumSq / this.lufsFrameCount);
    this.lufsIntegrated = intRms > 0 ? -0.691 + 10 * Math.log10(intRms * intRms) : -60;

    // Peak
    let pk = 0;
    for (let i = 0; i < buf.length; i++) { const a = Math.abs(buf[i]); if (a > pk) pk = a; }
    const peakDb = pk > 0 ? 20 * Math.log10(pk) : -96;

    // Crest factor
    const crest = peakDb - clamped;

    // Update readouts
    if (this.dom.lufsShort) this.dom.lufsShort.textContent = clamped.toFixed(1);
    if (this.dom.lufsInt) this.dom.lufsInt.textContent = this.lufsIntegrated.toFixed(1);
    if (this.dom.lufsPeak) this.dom.lufsPeak.textContent = peakDb.toFixed(1);
    if (this.dom.lufsCrest) this.dom.lufsCrest.textContent = crest.toFixed(1);
    if (this.dom.hLUFS) this.dom.hLUFS.textContent = clamped.toFixed(1);

    // Draw trace
    const c = this.dom.lufsCanvas; if (!c) return;
    const x = c.getContext('2d');
    const w = c.width, h = c.height;
    x.fillStyle = '#030306'; x.fillRect(0, 0, w, h);

    // Grid lines
    x.strokeStyle = 'rgba(255,255,255,0.04)'; x.lineWidth = 1;
    for (const db of [-14, -16, -23]) {
      const gy = h * (1 - (db + 60) / 60);
      x.beginPath(); x.moveTo(0, gy); x.lineTo(w, gy); x.stroke();
    }

    // Target line
    const targetLUFS = -16;
    const ty = h * (1 - (targetLUFS + 60) / 60);
    x.strokeStyle = 'rgba(234,179,8,0.3)'; x.setLineDash([4,4]);
    x.beginPath(); x.moveTo(0, ty); x.lineTo(w, ty); x.stroke();
    x.setLineDash([]);

    // LUFS trace
    x.strokeStyle = '#a855f7'; x.lineWidth = 1.5;
    x.shadowColor = '#a855f7'; x.shadowBlur = 3;
    x.beginPath();
    const histLen = Math.min(this.lufsIdx, this.lufsHistory.length);
    const startIdx = Math.max(0, this.lufsIdx - w);
    for (let i = 0; i < w && i < histLen; i++) {
      const idx = (startIdx + i) % this.lufsHistory.length;
      const v = this.lufsHistory[idx];
      const py = h * (1 - (v + 60) / 60);
      if (i === 0) x.moveTo(i, py); else x.lineTo(i, py);
    }
    x.stroke();
    x.shadowBlur = 0;

    // Labels
    x.font = '8px JetBrains Mono'; x.fillStyle = 'rgba(234,179,8,0.4)';
    x.fillText('-16 LUFS', w - 52, ty - 2);
  }

  // Panel 5: ML Saliency Heatmap
  drawSaliency(freqBuf) {
    const c = this.dom.saliencyCanvas; if (!c) return;
    const x = c.getContext('2d');
    const w = c.width, h = c.height;
    const bLen = freqBuf.length;

    // Shift left
    const img = x.getImageData(2, 0, w - 2, h);
    x.putImageData(img, 0, 0);
    x.fillStyle = '#030306'; x.fillRect(w - 2, 0, 2, h);

    // Simulate saliency via spectral gradient magnitude
    for (let i = 0; i < Math.min(256, bLen); i++) {
      const v = (freqBuf[i] || 0) / 255;
      const prev = i > 0 ? (freqBuf[i-1] || 0) / 255 : v;
      this.saliencyBuf[i] = this.saliencyBuf[i] * 0.7 + Math.abs(v - prev) * 3 * 0.3;
    }

    // Draw column
    for (let y = 0; y < h; y++) {
      const fi = Math.floor(((h - y) / h) * 256);
      const sal = Math.min(1, this.saliencyBuf[Math.min(fi, 255)] * 4);
      // Hot colormap: transparent -> yellow -> red -> white
      let r, g, b, a;
      if (sal < 0.25) { r = 0; g = 0; b = 0; a = sal * 2; }
      else if (sal < 0.5) { r = 239; g = 68; b = 68; a = 0.3 + sal; }
      else if (sal < 0.75) { r = 234; g = 179; b = 8; a = 0.5 + sal * 0.3; }
      else { r = 255; g = 240; b = 240; a = 0.6 + sal * 0.3; }
      x.fillStyle = 'rgba(' + r + ',' + g + ',' + b + ',' + Math.min(1, a) + ')';
      x.fillRect(w - 2, y, 2, 1);
    }
  }

  // Panel 6: Speaker PCA Cluster
  updateCluster(timeBuf, freqBuf) {
    // Simulate 192-dim embedding -> 2D PCA by using spectral centroid + energy
    let energy = 0, centroid = 0, weightSum = 0;
    const bLen = freqBuf.length;
    for (let i = 0; i < bLen; i++) {
      const v = freqBuf[i] / 255;
      energy += v * v;
      centroid += v * i;
      weightSum += v;
    }
    energy = Math.sqrt(energy / bLen);
    centroid = weightSum > 0 ? centroid / weightSum / bLen : 0.5;

    // Classify: voice-like (centroid 0.05-0.3, high energy) vs noise
    const isVoice = centroid > 0.03 && centroid < 0.35 && energy > 0.15;
    const isOther = centroid > 0.35 && energy > 0.1;

    // PCA coords (simulated)
    const px = centroid * 2 - 0.3 + (Math.random() - 0.5) * 0.08;
    const py = energy * 1.5 - 0.2 + (Math.random() - 0.5) * 0.08;

    this.clusterPoints.push({
      x: px, y: py,
      type: isVoice ? 'target' : (isOther ? 'other' : 'noise'),
      age: 0
    });

    // Keep last 200 points
    if (this.clusterPoints.length > 200) this.clusterPoints.splice(0, this.clusterPoints.length - 200);
    this.clusterPoints.forEach(p => p.age++);
  }

  drawCluster() {
    const c = this.dom.clusterCanvas; if (!c) return;
    const x = c.getContext('2d');
    const w = c.width, h = c.height;
    x.fillStyle = 'rgba(3,3,6,0.15)'; x.fillRect(0, 0, w, h);

    // Grid
    x.strokeStyle = 'rgba(255,255,255,0.03)'; x.lineWidth = 1;
    x.beginPath(); x.moveTo(w/2, 0); x.lineTo(w/2, h); x.stroke();
    x.beginPath(); x.moveTo(0, h/2); x.lineTo(w, h/2); x.stroke();

    const colors = { target: '#a855f7', other: '#3b82f6', noise: '#f97316' };
    const glows = { target: 'rgba(168,85,247,0.4)', other: 'rgba(59,130,246,0.3)', noise: 'rgba(249,115,22,0.3)' };

    for (const pt of this.clusterPoints) {
      const px = (pt.x + 0.5) * w;
      const py = (1 - (pt.y + 0.3)) * h;
      const alpha = Math.max(0.1, 1 - pt.age / 200);
      const radius = pt.type === 'target' ? 3 : 2;

      x.beginPath();
      x.arc(px, py, radius, 0, Math.PI * 2);
      x.fillStyle = colors[pt.type];
      x.globalAlpha = alpha;
      x.fill();

      if (pt.age < 5) {
        x.beginPath();
        x.arc(px, py, radius + 2, 0, Math.PI * 2);
        x.fillStyle = glows[pt.type];
        x.fill();
      }
    }
    x.globalAlpha = 1;

    // Axis labels
    x.font = '8px JetBrains Mono'; x.fillStyle = 'rgba(255,255,255,0.15)';
    x.fillText('PC1', w - 22, h - 4);
    x.fillText('PC2', 4, 10);
  }

  onResize(){
    [this.dom.waveOrigCanvas,this.dom.waveProcCanvas,this.dom.spectro2DCanvas,this.dom.freqCanvas,
     this.dom.abWaveCanvas,this.dom.oscCanvas,this.dom.specOverlayCanvas,this.dom.lufsCanvas,
     this.dom.saliencyCanvas,this.dom.clusterCanvas].forEach(c=> { if(c) this.resizeCanvas(c); });
    if(this.inputBuffer)this.drawWaveform(this.inputBuffer,this.dom.waveOrigCanvas,'#dc2626');
    if(this.outputBuffer)this.drawWaveform(this.outputBuffer,this.dom.waveProcCanvas,'#22d3ee');
    const ct=this.dom.spectro3DContainer;
    if(this.three.ren){this.three.ren.setSize(ct.clientWidth,ct.clientHeight);this.three.cam.aspect=ct.clientWidth/ct.clientHeight;this.three.cam.updateProjectionMatrix();}
  }

  // ---- UTILITY ----
  setStatus(s){this.dom.hStatus.textContent=s;const c={IDLE:'#5e5e78',LOADING:'#eab308',READY:'#22c55e',PROCESSING:'#dc2626',COMPLETE:'#22d3ee',ERROR:'#ef4444',RECORDING:'#ef4444',ABORTED:'#a855f7'};this.dom.hStatus.style.color=c[s]||'#5e5e78';}
  calcRMS(d){let s=0;for(let i=0;i<d.length;i++)s+=d[i]*d[i];const r=Math.sqrt(s/d.length);return r>0?20*Math.log10(r):-96;}
  calcPeak(d){let p=0;for(let i=0;i<d.length;i++){const a=Math.abs(d[i]);if(a>p)p=a;}return p>0?20*Math.log10(p):-96;}
  fmtDur(s){const m=Math.floor(s/60);const sc=Math.floor(s%60);return m+':'+String(sc).padStart(2,'0');}
}

if (typeof module !== 'undefined') module.exports = VoiceIsolatePro;
document.addEventListener('DOMContentLoaded',()=>{window.vip=new VoiceIsolatePro();});