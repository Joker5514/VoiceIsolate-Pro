/**
 * VoiceIsolate Pro — slider-map.js
 * Canonical slider registry and DOM builder.
 *
 * This file is the single source of truth for the 52-slider Engineer Mode UI.
 * It replaces the old patch-style duplication by exporting the slider registry,
 * DOM builders, and worklet/worker dispatch routing in one place.
 */

export const STAGES = [
  'S01: Input Decode',
  'S02: Buffer Allocation',
  'S03: DC Offset Removal',
  'S04: Peak Normalization',
  'S05: Voice Activity Detection',
  'S06: Time-Domain Noise Gate',
  'S07: Click/Pop Removal',
  'S08: Hum Removal',
  'S09: De-essing',
  'S10: Forward STFT',
  'S11: Adaptive Wiener NR',
  'S12: Residual Wiener Pass',
  'S13: ERB Spectral Gate',
  'S14: Voice-Band Emphasis',
  'S15: Crosstalk Cancel',
  'S16: Temporal Smoothing',
  'S17: Spectral Tilt',
  'S18: Dereverb',
  'S19: Harmonic Reconstruction',
  'S20: Inverse STFT',
  'S21: OfflineAudioContext Setup',
  'S22: HP/LP Filters',
  'S23: 10-Band EQ',
  'S24: Compression',
  'S25: Limiter',
  'S26: Render',
  'S27: Post-Render Cleanup',
  'S28: Dry/Wet Mix',
  'S29: Peak Normalization',
  'S30: Quality Metrics',
  'S31: Waveform Update',
  'S32: Final Export Ready',
];

export const SLIDERS = {
  gate: [
    { id:'gateThresh', label:'Threshold', min:-80, max:-5, val:-42, step:1, unit:' dB', rt:true, desc:'Signal level below which audio is gated' },
    { id:'gateRange', label:'Range', min:-80, max:-5, val:-60, step:1, unit:' dB', rt:true, desc:'Maximum gain reduction applied by the gate' },
    { id:'gateAttack', label:'Attack', min:0, max:500, val:5, step:1, unit:' ms', rt:true, desc:'Time for gate to open on signal detection' },
    { id:'gateRelease', label:'Release', min:50, max:2000, val:200, step:10, unit:' ms', rt:true, desc:'Time for gate to close after signal drops' },
    { id:'gateHold', label:'Hold', min:0, max:500, val:50, step:1, unit:' ms', rt:true, desc:'Hold time before release phase begins' },
    { id:'gateLookahead', label:'Lookahead', min:0, max:50, val:5, step:1, unit:' ms', rt:false, desc:'Lookahead window for predictive gating' },
  ],
  nr: [
    { id:'nrAmount', label:'NR Amount', min:0, max:100, val:78, step:1, unit:'%', rt:false, desc:'Spectral noise reduction strength' },
    { id:'nrSensitivity', label:'Sensitivity', min:0, max:100, val:60, step:1, unit:'%', rt:false, desc:'Noise floor detection sensitivity' },
    { id:'nrSpectralSub', label:'Spectral Sub', min:0, max:100, val:50, step:1, unit:'%', rt:false, desc:'Spectral subtraction strength' },
    { id:'nrFloor', label:'NR Floor', min:-96, max:-30, val:-72, step:1, unit:' dB', rt:false, desc:'Noise reduction floor limit' },
    { id:'nrSmoothing', label:'Smoothing', min:0, max:100, val:70, step:1, unit:'%', rt:false, desc:'Temporal smoothing of spectral noise estimate' },
  ],
  eq: [
    { id:'eqSub', label:'Sub', min:-12, max:12, val:0, step:0.5, unit:' dB', rt:true, desc:'Sub-bass EQ (20-60 Hz)' },
    { id:'eqBass', label:'Bass', min:-12, max:12, val:0, step:0.5, unit:' dB', rt:true, desc:'Bass EQ (60-200 Hz)' },
    { id:'eqWarmth', label:'Warmth', min:-12, max:12, val:0, step:0.5, unit:' dB', rt:true, desc:'Warmth EQ (200-500 Hz)' },
    { id:'eqBody', label:'Body', min:-12, max:12, val:0, step:0.5, unit:' dB', rt:true, desc:'Body EQ (500-1k Hz)' },
    { id:'eqLowMid', label:'Low Mid', min:-12, max:12, val:0, step:0.5, unit:' dB', rt:true, desc:'Low-mid EQ (1-2 kHz)' },
    { id:'eqMid', label:'Mid', min:-12, max:12, val:0, step:0.5, unit:' dB', rt:true, desc:'Mid EQ (2-4 kHz)' },
    { id:'eqPresence', label:'Presence', min:-12, max:12, val:0, step:0.5, unit:' dB', rt:true, desc:'Presence EQ (4-6 kHz)' },
    { id:'eqClarity', label:'Clarity', min:-12, max:12, val:0, step:0.5, unit:' dB', rt:true, desc:'Clarity EQ (6-10 kHz)' },
    { id:'eqAir', label:'Air', min:-12, max:12, val:0, step:0.5, unit:' dB', rt:true, desc:'Air EQ (10-16 kHz)' },
    { id:'eqBrill', label:'Brilliance', min:-12, max:12, val:0, step:0.5, unit:' dB', rt:true, desc:'Brilliance EQ (16-20 kHz)' },
  ],
  dyn: [
    { id:'compThresh', label:'Threshold', min:-60, max:0, val:-24, step:1, unit:' dB', rt:true, desc:'Compressor threshold level' },
    { id:'compRatio', label:'Ratio', min:1, max:20, val:4, step:0.5, unit:':1', rt:true, desc:'Compression ratio' },
    { id:'compAttack', label:'Attack', min:1, max:200, val:10, step:1, unit:' ms', rt:true, desc:'Compressor attack time' },
    { id:'compRelease', label:'Release', min:10, max:1000, val:150, step:10, unit:' ms', rt:true, desc:'Compressor release time' },
    { id:'compKnee', label:'Knee', min:0, max:30, val:6, step:1, unit:' dB', rt:true, desc:'Compressor knee width' },
    { id:'compMakeup', label:'Makeup', min:0, max:30, val:0, step:0.5, unit:' dB', rt:true, desc:'Makeup gain after compression' },
    { id:'limThresh', label:'Lim Thresh', min:-12, max:0, val:-1, step:0.5, unit:' dB', rt:true, desc:'Brickwall limiter threshold' },
    { id:'limRelease', label:'Lim Release', min:10, max:500, val:50, step:5, unit:' ms', rt:true, desc:'Limiter release time' },
  ],
  spec: [
    { id:'hpFreq', label:'HP Freq', min:20, max:2000, val:80, step:1, unit:' Hz', rt:true, desc:'High-pass filter cutoff frequency' },
    { id:'hpQ', label:'HP Q', min:0.1, max:10, val:0.7, step:0.1, unit:'', rt:true, desc:'High-pass filter resonance' },
    { id:'lpFreq', label:'LP Freq', min:4000, max:20000, val:18000, step:100, unit:' Hz', rt:true, desc:'Low-pass filter cutoff frequency' },
    { id:'lpQ', label:'LP Q', min:0.1, max:10, val:0.7, step:0.1, unit:'', rt:true, desc:'Low-pass filter resonance' },
    { id:'deEssFreq', label:'De-ess Freq', min:2000, max:12000, val:6000, step:100, unit:' Hz', rt:true, desc:'De-esser detection frequency' },
    { id:'deEssAmt', label:'De-ess Amt', min:0, max:30, val:0, step:1, unit:' dB', rt:true, desc:'De-esser reduction amount' },
    { id:'specTilt', label:'Spec Tilt', min:-6, max:6, val:0, step:0.5, unit:' dB', rt:true, desc:'Spectral tilt' },
    { id:'formantShift', label:'Formant Shift', min:-6, max:6, val:0, step:0.5, unit:' st', rt:false, desc:'Formant shift in semitones' },
  ],
  adv: [
    { id:'derevAmt', label:'Dereverb', min:0, max:100, val:0, step:1, unit:'%', rt:false, desc:'Dereverberation strength' },
    { id:'derevDecay', label:'Rev Decay', min:0, max:100, val:50, step:1, unit:'%', rt:false, desc:'Estimated reverb decay time reference' },
    { id:'harmRecov', label:'Harm Recovery', min:0, max:100, val:0, step:1, unit:'%', rt:false, desc:'Harmonic recovery via neural vocoder' },
    { id:'harmOrder', label:'Harm Order', min:1, max:10, val:3, step:1, unit:'', rt:false, desc:'Harmonic series order' },
    { id:'stereoWidth', label:'Stereo Width', min:0, max:200, val:100, step:1, unit:'%', rt:true, desc:'Stereo width of output signal' },
    { id:'phaseCorr', label:'Phase Corr', min:0, max:100, val:0, step:1, unit:'%', rt:false, desc:'Phase correlation correction strength' },
  ],
  sep: [
    { id:'voiceIso', label:'Voice Iso', min:0, max:100, val:80, step:1, unit:'%', rt:false, desc:'Voice isolation strength' },
    { id:'bgSuppress', label:'BG Suppress', min:0, max:100, val:50, step:1, unit:'%', rt:false, desc:'Background suppression level' },
    { id:'voiceFocusLo', label:'Focus Lo', min:80, max:500, val:120, step:10, unit:' Hz', rt:false, desc:'Lower bound of voice focus band' },
    { id:'voiceFocusHi', label:'Focus Hi', min:1000, max:8000, val:3400, step:100, unit:' Hz', rt:false, desc:'Upper bound of voice focus band' },
    { id:'crosstalkCancel', label:'Crosstalk', min:0, max:100, val:0, step:1, unit:'%', rt:false, desc:'Crosstalk cancellation between channels' },
  ],
  out: [
    { id:'outGain', label:'Output Gain', min:-24, max:24, val:0, step:0.5, unit:' dB', rt:true, desc:'Final output gain trim' },
    { id:'dryWet', label:'Dry/Wet', min:0, max:100, val:100, step:1, unit:'%', rt:true, desc:'Blend between dry input and processed output' },
    { id:'ditherAmt', label:'Dither', min:0, max:10, val:1, step:0.1, unit:' bits', rt:false, desc:'Dither noise amplitude in bits' },
    { id:'outWidth', label:'Out Width', min:0, max:200, val:100, step:1, unit:'%', rt:true, desc:'Output stereo width' },
  ],
};

export const TAB_PANEL_MAP = {
  gate:'tab-gate', nr:'tab-nr', eq:'tab-eq', dyn:'tab-dyn',
  spec:'tab-spec', adv:'tab-adv', sep:'tab-sep', out:'tab-out',
};

export const SLIDER_TARGETS = {
  gateThresh:'worklet', gateRange:'worklet', gateAttack:'worklet', gateRelease:'worklet', gateHold:'worklet', gateLookahead:'local',
  nrAmount:'both', nrSensitivity:'worker', nrSpectralSub:'worker', nrFloor:'worker', nrSmoothing:'worker',
  eqSub:'worklet', eqBass:'worklet', eqWarmth:'worklet', eqBody:'worklet', eqLowMid:'worklet', eqMid:'worklet', eqPresence:'worklet', eqClarity:'worklet', eqAir:'worklet', eqBrill:'worklet',
  compThresh:'worklet', compRatio:'worklet', compAttack:'worklet', compRelease:'worklet', compKnee:'worklet', compMakeup:'worklet', limThresh:'worklet', limRelease:'worklet',
  hpFreq:'worklet', hpQ:'worklet', lpFreq:'worklet', lpQ:'worklet', deEssFreq:'worklet', deEssAmt:'worklet', specTilt:'worklet', formantShift:'worker',
  derevAmt:'worker', derevDecay:'worker', harmRecov:'worker', harmOrder:'worker', stereoWidth:'worklet', phaseCorr:'worker',
  voiceIso:'worker', bgSuppress:'worker', voiceFocusLo:'worker', voiceFocusHi:'worker', crosstalkCancel:'worker',
  outGain:'worklet', dryWet:'worklet', ditherAmt:'worklet', outWidth:'worklet',
};

export const SLIDER_REGISTRY = [
  { id: 'gateThresh',      key: 'gateThresh',      transform: v => v, target: 'worklet' },
  { id: 'gateRange',       key: 'gateRange',       transform: v => v, target: 'worklet' },
  { id: 'gateAttack',      key: 'gateAttack',      transform: v => v, target: 'worklet' },
  { id: 'gateRelease',     key: 'gateRelease',     transform: v => v, target: 'worklet' },
  { id: 'gateHold',        key: 'gateHold',        transform: v => v, target: 'worklet' },
  { id: 'gateLookahead',   key: 'gateLookahead',   transform: v => v, target: 'worker' },
  { id: 'nrAmount',        key: 'nrAmount',        transform: v => v, target: 'worker' },
  { id: 'nrSensitivity',   key: 'nrSensitivity',   transform: v => v, target: 'worker' },
  { id: 'nrSpectralSub',   key: 'nrSpectralSub',   transform: v => v, target: 'worker' },
  { id: 'nrFloor',         key: 'nrFloor',         transform: v => v, target: 'worker' },
  { id: 'nrSmoothing',     key: 'nrSmoothing',     transform: v => v, target: 'worker' },
  { id: 'eqSub',           key: 'eqSub',           transform: v => v, target: 'worklet' },
  { id: 'eqBass',          key: 'eqBass',          transform: v => v, target: 'worklet' },
  { id: 'eqWarmth',        key: 'eqWarmth',        transform: v => v, target: 'worklet' },
  { id: 'eqBody',          key: 'eqBody',          transform: v => v, target: 'worklet' },
  { id: 'eqLowMid',        key: 'eqLowMid',        transform: v => v, target: 'worklet' },
  { id: 'eqMid',           key: 'eqMid',           transform: v => v, target: 'worklet' },
  { id: 'eqPresence',      key: 'eqPresence',      transform: v => v, target: 'worklet' },
  { id: 'eqClarity',       key: 'eqClarity',       transform: v => v, target: 'worklet' },
  { id: 'eqAir',           key: 'eqAir',           transform: v => v, target: 'worklet' },
  { id: 'eqBrill',         key: 'eqBrill',         transform: v => v, target: 'worklet' },
  { id: 'compThresh',      key: 'compThresh',      transform: v => v, target: 'worklet' },
  { id: 'compRatio',       key: 'compRatio',       transform: v => v, target: 'worklet' },
  { id: 'compAttack',      key: 'compAttack',      transform: v => v, target: 'worklet' },
  { id: 'compRelease',     key: 'compRelease',     transform: v => v, target: 'worklet' },
  { id: 'compKnee',        key: 'compKnee',        transform: v => v, target: 'worklet' },
  { id: 'compMakeup',      key: 'compMakeup',      transform: v => v, target: 'worklet' },
  { id: 'limThresh',       key: 'limThresh',       transform: v => v, target: 'worklet' },
  { id: 'limRelease',      key: 'limRelease',      transform: v => v, target: 'worklet' },
  { id: 'hpFreq',          key: 'hpFreq',          transform: v => v, target: 'worklet' },
  { id: 'hpQ',             key: 'hpQ',             transform: v => v, target: 'worklet' },
  { id: 'lpFreq',          key: 'lpFreq',          transform: v => v, target: 'worklet' },
  { id: 'lpQ',             key: 'lpQ',             transform: v => v, target: 'worklet' },
  { id: 'deEssFreq',       key: 'deEssFreq',       transform: v => v, target: 'worklet' },
  { id: 'deEssAmt',        key: 'deEssAmt',        transform: v => v, target: 'worklet' },
  { id: 'specTilt',        key: 'specTilt',        transform: v => v, target: 'worklet' },
  { id: 'formantShift',    key: 'formantShift',    transform: v => v, target: 'worker' },
  { id: 'derevAmt',        key: 'derevAmt',        transform: v => v, target: 'worker' },
  { id: 'derevDecay',      key: 'derevDecay',      transform: v => v, target: 'worker' },
  { id: 'harmRecov',       key: 'harmRecov',       transform: v => v, target: 'worker' },
  { id: 'harmOrder',       key: 'harmOrder',       transform: v => v, target: 'worker' },
  { id: 'stereoWidth',     key: 'stereoWidth',     transform: v => v, target: 'worklet' },
  { id: 'phaseCorr',       key: 'phaseCorr',       transform: v => v, target: 'worker' },
  { id: 'voiceIso',        key: 'voiceIso',        transform: v => v, target: 'worker' },
  { id: 'bgSuppress',      key: 'bgSuppress',      transform: v => v, target: 'worker' },
  { id: 'voiceFocusLo',    key: 'voiceFocusLo',    transform: v => v, target: 'worker' },
  { id: 'voiceFocusHi',    key: 'voiceFocusHi',    transform: v => v, target: 'worker' },
  { id: 'crosstalkCancel', key: 'crosstalkCancel', transform: v => v, target: 'worker' },
  { id: 'outGain',         key: 'outGain',         transform: v => v, target: 'worklet' },
  { id: 'dryWet',          key: 'dryWet',          transform: v => v, target: 'worklet' },
  { id: 'ditherAmt',       key: 'ditherAmt',       transform: v => v, target: 'worker' },
  { id: 'outWidth',        key: 'outWidth',        transform: v => v, target: 'worklet' },
];

export function dispatchParam(id, rawVal, app = window._vipApp || window.vip || window._vipOrch) {
  const target = SLIDER_TARGETS[id] || 'local';
  const payload = { [id]: rawVal };
  const worklet = app?.workletNode;
  const worker = app?.mlWorker;
  if ((target === 'worklet' || target === 'both') && worklet) {
    try { worklet.port.postMessage({ type: 'params', payload }); } catch (_) {}
  }
  if ((target === 'worker' || target === 'both') && worker) {
    try { worker.postMessage({ type: 'setParams', payload }); } catch (_) {}
  }
}

export function setPct(input, spec) {
  const range = spec.max - spec.min;
  const v = parseFloat(input.value);
  const pct = range > 0 ? ((v - spec.min) / range) * 100 : 50;
  input.style.setProperty('--pct', pct.toFixed(2) + '%');
}

export function buildRow(spec, onChange) {
  const row = document.createElement('div');
  row.className = 'sr-row';

  const label = document.createElement('label');
  label.className = 'sr-label';
  label.htmlFor = 'sl_' + spec.id;
  label.textContent = spec.label;
  label.title = spec.desc || '';
  if (spec.rt) {
    const badge = document.createElement('span');
    badge.className = 'rt-badge';
    badge.textContent = 'RT';
    label.appendChild(badge);
  }
  row.appendChild(label);

  const input = document.createElement('input');
  input.type = 'range';
  input.id = 'sl_' + spec.id;
  input.min = spec.min;
  input.max = spec.max;
  input.step = spec.step;
  input.value = spec.val;
  if (spec.rt) input.classList.add('realtime');
  input.setAttribute('aria-label', spec.label);
  setPct(input, spec);
  row.appendChild(input);

  const valueEl = document.createElement('span');
  valueEl.className = 'sr-val';
  valueEl.id = 'val_' + spec.id;
  valueEl.textContent = spec.val + (spec.unit || '');
  row.appendChild(valueEl);

  input.addEventListener('input', () => {
    const v = parseFloat(input.value);
    setPct(input, spec);
    valueEl.textContent = v + (spec.unit || '');
    window.VIP_PARAMS = window.VIP_PARAMS || {};
    window.VIP_PARAMS[spec.id] = v;
    dispatchParam(spec.id, v);
    if (typeof onChange === 'function') onChange(spec, v, input, valueEl);
  });

  return row;
}

export function buildPanels(root = document, onChange) {
  for (const [tab, specs] of Object.entries(SLIDERS)) {
    const panel = root.getElementById(TAB_PANEL_MAP[tab]);
    if (!panel) continue;
    panel.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'sr';
    for (const spec of specs) wrap.appendChild(buildRow(spec, onChange));
    panel.appendChild(wrap);
  }
  window.VIP_SLIDER_REGISTRY = Object.values(SLIDERS).flat();
  window.VIP_PARAMS = window.VIP_PARAMS || {};
  for (const spec of window.VIP_SLIDER_REGISTRY) {
    if (!(spec.id in window.VIP_PARAMS)) window.VIP_PARAMS[spec.id] = spec.val;
  }
}
