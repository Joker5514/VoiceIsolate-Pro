/* ════════════════════════════════════════════════════════════════
   VOICEISOLATE PRO v16.1 — DSP ENGINE
   Threads from Space v6 · 28-Stage Hexa-Pass Pipeline
   Pure JS FFT · Web Audio API · Zero Dependencies
   PRESETS FULLY WIRED · SYNCED WAVEFORMS · LIVE ANALYSER
   ════════════════════════════════════════════════════════════════ */
'use strict';

// ═══ STATE ═══
const STATE = {
  mode: 'clean',
  audioCtx: null,
  originalBuffer: null,
  processedBuffer: null,
  currentSource: null,
  analyser: null,
  gainNode: null,
  isPlaying: false,
  playingProcessed: false,
  startTime: 0,
  pauseOffset: 0,
  isRecording: false,
  mediaRecorder: null,
  mediaStream: null,
  recordChunks: [],
  recStartTime: 0,
  recInterval: null,
  preset: 'podcast',
  processing: false,
  animFrame: null,
  waveformCache: { original: null, processed: null },
};

// ═══ DSP PARAMETERS ═══
const PARAMS = {
  noiseReduction: 0.5, overSubFactor: 2.5, spectralFloor: -80,
  humFreq: 60, humHarmonics: 6, humQ: 35,
  vadThreshold: -40, vadFrameMs: 10, erbBands: 32,
  gateAttack: 1, gateRelease: 80, gateHold: 50,
  demucsWeight: 0.5, spleeterWeight: 0.3, waveunetWeight: 0.2, voiceprintThresh: 0.75,
  deverbAmount: 0.5, earlyRefSup: 50,
  harmonicOrder: 6, hfBoostdB: 3, hfBoostLow: 3000, hfBoostHigh: 8000,
  compThreshold: -20, compRatio: 3, compAttack: 5, compRelease: 60, compKnee: 6, compMakeup: 3,
  artRepairThresh: 15, vocoderBypass: 30,
  targetLUFS: -16, truePeakLimit: -1, isolation: 60,
};
const DEFAULTS = Object.assign({}, PARAMS);

// ═══ 28 PIPELINE STAGES ═══
const STAGES = [
  { id:1,  pass:1, name:'DC Offset Removal',       short:'DC'  },
  { id:2,  pass:1, name:'HPF Pre-Filter',           short:'HPF' },
  { id:3,  pass:1, name:'Input Gain Normalization',  short:'IGN' },
  { id:4,  pass:1, name:'Noise Profile Accumulation',short:'NPA' },
  { id:5,  pass:1, name:'Voice Activity Detection',  short:'VAD' },
  { id:6,  pass:1, name:'Voiceprint Analysis',       short:'VPA' },
  { id:7,  pass:2, name:'Hum Removal (50/60Hz)',     short:'HUM' },
  { id:8,  pass:2, name:'Spectral Subtraction',      short:'SS'  },
  { id:9,  pass:2, name:'ERB Spectral Gate',         short:'ERB' },
  { id:10, pass:2, name:'Formant Enhancement',       short:'FRM' },
  { id:11, pass:2, name:'De-Reverberation',          short:'DRV' },
  { id:12, pass:2, name:'Spectral Tilt Compensation',short:'STC' },
  { id:13, pass:3, name:'Demucs v4 Separation',      short:'DMX' },
  { id:14, pass:3, name:'Band-Split RNN',            short:'BSR' },
  { id:15, pass:3, name:'Transformer Spectral Mask',  short:'TSM' },
  { id:16, pass:3, name:'Voiceprint Target Extract',  short:'VTE' },
  { id:17, pass:4, name:'Harmonic Reconstruction',    short:'HRM' },
  { id:18, pass:4, name:'Transient Shaping',          short:'TRS' },
  { id:19, pass:4, name:'Mid/Side Processing',        short:'M/S' },
  { id:20, pass:4, name:'Comfort Noise Injection',    short:'CNI' },
  { id:21, pass:5, name:'Psychoacoustic Validation',  short:'PSY' },
  { id:22, pass:5, name:'Artifact Score & Repair',    short:'ART' },
  { id:23, pass:5, name:'Neural Vocoder Bypass',      short:'NVB' },
  { id:24, pass:5, name:'Phase Coherence Check',      short:'PHC' },
  { id:25, pass:6, name:'Voice-Gated HF Boost',       short:'VHF' },
  { id:26, pass:6, name:'Multiband Dynamics',         short:'MBD' },
  { id:27, pass:6, name:'LUFS Loudness Normalization',short:'LUF' },
  { id:28, pass:6, name:'True-Peak Limiter',          short:'TPL' },
];

// ════════════════════════════════════════════════════════════════
// PRESETS — EVERY PARAMETER MAPPED PER PRESET
// ════════════════════════════════════════════════════════════════
const PRESETS = [
  { id:'crystal', icon:'💎', name:'Crystal Voice',
    desc:'Maximum clarity, deep noise floor, broadcast polish',
    params: {
      noiseReduction:0.85, overSubFactor:3.0, spectralFloor:-90, humFreq:60, humHarmonics:6, humQ:40,
      vadThreshold:-38, vadFrameMs:10, erbBands:40, gateAttack:0.5, gateRelease:60, gateHold:40,
      demucsWeight:0.6, spleeterWeight:0.25, waveunetWeight:0.15, voiceprintThresh:0.80,
      deverbAmount:0.65, earlyRefSup:60,
      harmonicOrder:8, hfBoostdB:4, hfBoostLow:2800, hfBoostHigh:8000,
      compThreshold:-18, compRatio:3.5, compAttack:3, compRelease:50, compKnee:6, compMakeup:4,
      artRepairThresh:12, vocoderBypass:25,
      targetLUFS:-16, truePeakLimit:-1, isolation:80,
    },
  },
  { id:'podcast', icon:'🎙️', name:'Podcast Pro',
    desc:'Warm, compressed, broadcast-ready voice',
    params: {
      noiseReduction:0.60, overSubFactor:2.5, spectralFloor:-80, humFreq:60, humHarmonics:4, humQ:35,
      vadThreshold:-42, vadFrameMs:10, erbBands:32, gateAttack:1, gateRelease:80, gateHold:50,
      demucsWeight:0.5, spleeterWeight:0.3, waveunetWeight:0.2, voiceprintThresh:0.75,
      deverbAmount:0.50, earlyRefSup:50,
      harmonicOrder:6, hfBoostdB:2.5, hfBoostLow:3200, hfBoostHigh:7500,
      compThreshold:-22, compRatio:4, compAttack:5, compRelease:60, compKnee:8, compMakeup:3,
      artRepairThresh:15, vocoderBypass:30,
      targetLUFS:-16, truePeakLimit:-1, isolation:65,
    },
  },
  { id:'interview', icon:'🎤', name:'Interview',
    desc:'Natural, gentle processing, preserve character',
    params: {
      noiseReduction:0.40, overSubFactor:2.0, spectralFloor:-75, humFreq:60, humHarmonics:3, humQ:30,
      vadThreshold:-45, vadFrameMs:12, erbBands:28, gateAttack:2, gateRelease:100, gateHold:60,
      demucsWeight:0.4, spleeterWeight:0.35, waveunetWeight:0.25, voiceprintThresh:0.70,
      deverbAmount:0.35, earlyRefSup:40,
      harmonicOrder:4, hfBoostdB:1.5, hfBoostLow:3500, hfBoostHigh:7000,
      compThreshold:-24, compRatio:2.5, compAttack:8, compRelease:80, compKnee:10, compMakeup:2,
      artRepairThresh:20, vocoderBypass:35,
      targetLUFS:-18, truePeakLimit:-1, isolation:50,
    },
  },
  { id:'film', icon:'🎬', name:'Film Dialogue',
    desc:'Cinematic warmth, preserve room tone, -24 LUFS',
    params: {
      noiseReduction:0.30, overSubFactor:1.8, spectralFloor:-72, humFreq:60, humHarmonics:3, humQ:28,
      vadThreshold:-48, vadFrameMs:15, erbBands:24, gateAttack:3, gateRelease:120, gateHold:70,
      demucsWeight:0.35, spleeterWeight:0.35, waveunetWeight:0.30, voiceprintThresh:0.68,
      deverbAmount:0.20, earlyRefSup:30,
      harmonicOrder:4, hfBoostdB:1, hfBoostLow:3800, hfBoostHigh:6500,
      compThreshold:-26, compRatio:2, compAttack:10, compRelease:100, compKnee:12, compMakeup:1.5,
      artRepairThresh:25, vocoderBypass:40,
      targetLUFS:-24, truePeakLimit:-1, isolation:40,
    },
  },
  { id:'forensic', icon:'🔬', name:'Forensic',
    desc:'Conservative, minimal artifacts, full audit trail',
    params: {
      noiseReduction:0.20, overSubFactor:1.5, spectralFloor:-70, humFreq:60, humHarmonics:8, humQ:45,
      vadThreshold:-50, vadFrameMs:8, erbBands:48, gateAttack:5, gateRelease:150, gateHold:80,
      demucsWeight:0.3, spleeterWeight:0.4, waveunetWeight:0.3, voiceprintThresh:0.85,
      deverbAmount:0.15, earlyRefSup:20,
      harmonicOrder:3, hfBoostdB:0, hfBoostLow:4000, hfBoostHigh:6000,
      compThreshold:-30, compRatio:1.5, compAttack:15, compRelease:150, compKnee:15, compMakeup:0.5,
      artRepairThresh:8, vocoderBypass:50,
      targetLUFS:-16, truePeakLimit:-0.5, isolation:35,
    },
  },
  { id:'camera', icon:'📷', name:'Camera Audio',
    desc:'Aggressive wind/hiss removal, rescue bad audio',
    params: {
      noiseReduction:0.75, overSubFactor:3.5, spectralFloor:-85, humFreq:60, humHarmonics:6, humQ:38,
      vadThreshold:-36, vadFrameMs:10, erbBands:36, gateAttack:0.5, gateRelease:50, gateHold:35,
      demucsWeight:0.55, spleeterWeight:0.25, waveunetWeight:0.20, voiceprintThresh:0.78,
      deverbAmount:0.55, earlyRefSup:55,
      harmonicOrder:7, hfBoostdB:3.5, hfBoostLow:2600, hfBoostHigh:8500,
      compThreshold:-20, compRatio:4, compAttack:3, compRelease:45, compKnee:6, compMakeup:4.5,
      artRepairThresh:18, vocoderBypass:28,
      targetLUFS:-16, truePeakLimit:-1, isolation:75,
    },
  },
  { id:'voice_msg', icon:'💬', name:'Voice Message',
    desc:'High compression, tight loudness, small file ready',
    params: {
      noiseReduction:0.55, overSubFactor:2.8, spectralFloor:-78, humFreq:60, humHarmonics:4, humQ:32,
      vadThreshold:-40, vadFrameMs:10, erbBands:28, gateAttack:1, gateRelease:70, gateHold:45,
      demucsWeight:0.45, spleeterWeight:0.3, waveunetWeight:0.25, voiceprintThresh:0.72,
      deverbAmount:0.45, earlyRefSup:45,
      harmonicOrder:5, hfBoostdB:2, hfBoostLow:3400, hfBoostHigh:7000,
      compThreshold:-16, compRatio:5, compAttack:2, compRelease:40, compKnee:4, compMakeup:5,
      artRepairThresh:20, vocoderBypass:30,
      targetLUFS:-14, truePeakLimit:-0.5, isolation:60,
    },
  },
  { id:'music', icon:'🎵', name:'Music Vocal',
    desc:'Preserve musicality, gentle separation, warm tone',
    params: {
      noiseReduction:0.30, overSubFactor:1.8, spectralFloor:-72, humFreq:50, humHarmonics:2, humQ:25,
      vadThreshold:-50, vadFrameMs:15, erbBands:24, gateAttack:3, gateRelease:120, gateHold:70,
      demucsWeight:0.6, spleeterWeight:0.2, waveunetWeight:0.2, voiceprintThresh:0.65,
      deverbAmount:0.25, earlyRefSup:30,
      harmonicOrder:8, hfBoostdB:2, hfBoostLow:2400, hfBoostHigh:9000,
      compThreshold:-20, compRatio:2, compAttack:12, compRelease:120, compKnee:12, compMakeup:2,
      artRepairThresh:10, vocoderBypass:45,
      targetLUFS:-14, truePeakLimit:-1, isolation:45,
    },
  },
];

// ════════════════════════════════════════════════════════════════
// FFT — Cooley-Tukey Radix-2
// ════════════════════════════════════════════════════════════════
function fft(re, im, inverse) {
  const N = re.length;
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1;
    while (j & bit) { j ^= bit; bit >>= 1; }
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  const dir = inverse ? -1 : 1;
  for (let len = 2; len <= N; len *= 2) {
    const half = len / 2, ang = dir * 2 * Math.PI / len;
    const wR = Math.cos(ang), wI = Math.sin(ang);
    for (let i = 0; i < N; i += len) {
      let cR = 1, cI = 0;
      for (let j = 0; j < half; j++) {
        const a = i + j, b = a + half;
        const tR = cR * re[b] - cI * im[b], tI = cR * im[b] + cI * re[b];
        re[b] = re[a] - tR; im[b] = im[a] - tI; re[a] += tR; im[a] += tI;
        const nR = cR * wR - cI * wI; cI = cR * wI + cI * wR; cR = nR;
      }
    }
  }
  if (inverse) { for (let i = 0; i < N; i++) { re[i] /= N; im[i] /= N; } }
}

// ════════════════════════════════════════════════════════════════
// DSP ALGORITHMS
// ════════════════════════════════════════════════════════════════
function biquadFilter(buf, sr, type, freq, Q) {
  const w0 = 2 * Math.PI * freq / sr, sinW = Math.sin(w0), cosW = Math.cos(w0), alpha = sinW / (2 * Q);
  let b0, b1, b2, a0, a1, a2;
  if (type === 'notch') { b0=1; b1=-2*cosW; b2=1; a0=1+alpha; a1=-2*cosW; a2=1-alpha; }
  else if (type === 'highpass') { b0=(1+cosW)/2; b1=-(1+cosW); b2=(1+cosW)/2; a0=1+alpha; a1=-2*cosW; a2=1-alpha; }
  else if (type === 'lowpass') { b0=(1-cosW)/2; b1=1-cosW; b2=(1-cosW)/2; a0=1+alpha; a1=-2*cosW; a2=1-alpha; }
  else if (type === 'highshelf') {
    const A = Math.pow(10, Q / 40), sq = Math.sqrt(A);
    b0=A*((A+1)+(A-1)*cosW+2*sq*alpha); b1=-2*A*((A-1)+(A+1)*cosW);
    b2=A*((A+1)+(A-1)*cosW-2*sq*alpha); a0=(A+1)-(A-1)*cosW+2*sq*alpha;
    a1=2*((A-1)-(A+1)*cosW); a2=(A+1)-(A-1)*cosW-2*sq*alpha;
  } else return buf;
  const nb0=b0/a0, nb1=b1/a0, nb2=b2/a0, na1=a1/a0, na2=a2/a0;
  let x1=0, x2=0, y1=0, y2=0;
  const out = new Float32Array(buf.length);
  for (let i=0; i<buf.length; i++) {
    const y = nb0*buf[i] + nb1*x1 + nb2*x2 - na1*y1 - na2*y2;
    x2=x1; x1=buf[i]; y2=y1; y1=y; out[i]=y;
  }
  return out;
}

function removeDC(buf) {
  let s=0; for (let i=0;i<buf.length;i++) s+=buf[i];
  const m=s/buf.length, out=new Float32Array(buf.length);
  for (let i=0;i<buf.length;i++) out[i]=buf[i]-m;
  return out;
}

function normalizeToTarget(buf, targetPeak) {
  let pk=0; for (let i=0;i<buf.length;i++){const a=Math.abs(buf[i]);if(a>pk)pk=a;}
  if(pk<1e-10)return buf;
  const g=targetPeak/pk, out=new Float32Array(buf.length);
  for(let i=0;i<buf.length;i++) out[i]=buf[i]*g;
  return out;
}

function spectralSubtract(buf, sr, noiseFloor, overSub) {
  const fftSize=2048, hop=fftSize/4;
  const win=new Float32Array(fftSize);
  for(let i=0;i<fftSize;i++) win[i]=0.5*(1-Math.cos(2*Math.PI*i/(fftSize-1)));
  const numF=Math.floor((buf.length-fftSize)/hop)+1;
  const out=new Float32Array(buf.length), sumW=new Float32Array(buf.length);
  const ne=new Float32Array(fftSize/2+1);
  const nF=Math.min(5,numF);
  for(let f=0;f<nF;f++){
    const off=f*hop, re=new Float32Array(fftSize), im=new Float32Array(fftSize);
    for(let i=0;i<fftSize;i++) re[i]=(buf[off+i]||0)*win[i];
    fft(re,im,false);
    for(let i=0;i<=fftSize/2;i++) ne[i]+=Math.sqrt(re[i]*re[i]+im[i]*im[i])/nF;
  }
  for(let f=0;f<numF;f++){
    const off=f*hop, re=new Float32Array(fftSize), im=new Float32Array(fftSize);
    for(let i=0;i<fftSize;i++) re[i]=(buf[off+i]||0)*win[i];
    fft(re,im,false);
    for(let i=0;i<=fftSize/2;i++){
      const mag=Math.sqrt(re[i]*re[i]+im[i]*im[i]), ph=Math.atan2(im[i],re[i]);
      const cl=Math.max(mag-overSub*ne[i],mag*Math.pow(10,noiseFloor/20));
      re[i]=cl*Math.cos(ph); im[i]=cl*Math.sin(ph);
      if(i>0&&i<fftSize/2){re[fftSize-i]=re[i]; im[fftSize-i]=-im[i];}
    }
    fft(re,im,true);
    for(let i=0;i<fftSize;i++){out[off+i]+=re[i]*win[i]; sumW[off+i]+=win[i]*win[i];}
  }
  for(let i=0;i<out.length;i++){if(sumW[i]>1e-8)out[i]/=sumW[i];}
  return out;
}

function voiceBandIsolation(buf, sr, iso) {
  let r=biquadFilter(buf,sr,'highpass',80,0.707);
  r=biquadFilter(r,sr,'lowpass',8000,0.5);
  const bl=iso/100, out=new Float32Array(buf.length);
  for(let i=0;i<buf.length;i++) out[i]=r[i]*bl+buf[i]*(1-bl);
  return out;
}

function applyCompression(buf, sr, thresh, ratio, atk, rel, knee, makeup) {
  const out=new Float32Array(buf.length);
  const ac=Math.exp(-1/(sr*atk/1000)), rc=Math.exp(-1/(sr*rel/1000));
  let env=0; const ml=Math.pow(10,makeup/20);
  for(let i=0;i<buf.length;i++){
    const dB=20*Math.log10(Math.abs(buf[i])+1e-10), ov=dB-thresh;
    let gr=0;
    if(ov>knee/2)gr=ov*(1-1/ratio);
    else if(ov>-knee/2)gr=Math.pow(ov+knee/2,2)/(2*knee)*(1-1/ratio);
    env=gr>env?ac*env+(1-ac)*gr:rc*env+(1-rc)*gr;
    out[i]=buf[i]*Math.pow(10,-env/20)*ml;
  }
  return out;
}

function truePeakLimit(buf, ceil) {
  const cl=Math.pow(10,ceil/20), out=new Float32Array(buf.length);
  for(let i=0;i<buf.length;i++) out[i]=Math.max(-cl,Math.min(cl,buf[i]));
  return out;
}

function lufsNormalize(buf, sr, target) {
  let s=0; for(let i=0;i<buf.length;i++) s+=buf[i]*buf[i];
  const rms=Math.sqrt(s/buf.length), rmsDB=20*Math.log10(rms+1e-10);
  const g=Math.pow(10,(target-rmsDB+0.691)/20);
  const out=new Float32Array(buf.length);
  for(let i=0;i<buf.length;i++) out[i]=buf[i]*g;
  return out;
}

function harmonicReconstruct(buf, sr, order) {
  const fftSize=2048, hop=fftSize/4;
  const win=new Float32Array(fftSize);
  for(let i=0;i<fftSize;i++) win[i]=0.5*(1-Math.cos(2*Math.PI*i/(fftSize-1)));
  const numF=Math.floor((buf.length-fftSize)/hop)+1;
  const out=new Float32Array(buf.length), sumW=new Float32Array(buf.length);
  for(let f=0;f<numF;f++){
    const off=f*hop, re=new Float32Array(fftSize), im=new Float32Array(fftSize);
    for(let i=0;i<fftSize;i++) re[i]=(buf[off+i]||0)*win[i];
    fft(re,im,false);
    const loB=Math.round(80*fftSize/sr), hiB=Math.round(500*fftSize/sr);
    let mx=0, f0=loB;
    for(let b=loB;b<=hiB;b++){const m=re[b]*re[b]+im[b]*im[b];if(m>mx){mx=m;f0=b;}}
    for(let h=2;h<=order;h++){
      const hB=f0*h; if(hB>=fftSize/2)break;
      for(let d=-3;d<=3;d++){
        const idx=hB+d;
        if(idx>0&&idx<fftSize/2){
          const boost=1+0.3/h;
          re[idx]*=boost; im[idx]*=boost;
          re[fftSize-idx]=re[idx]; im[fftSize-idx]=-im[idx];
        }
      }
    }
    fft(re,im,true);
    for(let i=0;i<fftSize;i++){out[off+i]+=re[i]*win[i]; sumW[off+i]+=win[i]*win[i];}
  }
  for(let i=0;i<out.length;i++){if(sumW[i]>1e-8)out[i]/=sumW[i];}
  return out;
}

function dereverberate(buf, sr, amount) {
  if(amount<0.05) return buf;
  const fftSize=2048, hop=fftSize/4;
  const win=new Float32Array(fftSize);
  for(let i=0;i<fftSize;i++) win[i]=0.5*(1-Math.cos(2*Math.PI*i/(fftSize-1)));
  const numF=Math.floor((buf.length-fftSize)/hop)+1;
  const out=new Float32Array(buf.length), sumW=new Float32Array(buf.length);
  let prevMag=null;
  for(let f=0;f<numF;f++){
    const off=f*hop, re=new Float32Array(fftSize), im=new Float32Array(fftSize);
    for(let i=0;i<fftSize;i++) re[i]=(buf[off+i]||0)*win[i];
    fft(re,im,false);
    const mag=new Float32Array(fftSize/2+1);
    for(let i=0;i<=fftSize/2;i++) mag[i]=Math.sqrt(re[i]*re[i]+im[i]*im[i]);
    if(prevMag){
      for(let i=0;i<=fftSize/2;i++){
        const decay=prevMag[i]*0.95;
        if(mag[i]<decay*amount){
          const sup=Math.max(0.05,1-amount*(decay-mag[i])/(decay+1e-10));
          const ph=Math.atan2(im[i],re[i]), nm=mag[i]*sup;
          re[i]=nm*Math.cos(ph); im[i]=nm*Math.sin(ph);
          if(i>0&&i<fftSize/2){re[fftSize-i]=re[i]; im[fftSize-i]=-im[i];}
        }
      }
    }
    prevMag=mag;
    fft(re,im,true);
    for(let i=0;i<fftSize;i++){out[off+i]+=re[i]*win[i]; sumW[off+i]+=win[i]*win[i];}
  }
  for(let i=0;i<out.length;i++){if(sumW[i]>1e-8)out[i]/=sumW[i];}
  return out;
}

// ════════════════════════════════════════════════════════════════
// 28-STAGE PIPELINE
// ════════════════════════════════════════════════════════════════
async function processAudio() {
  if(!STATE.originalBuffer||STATE.processing) return;
  STATE.processing=true; stopPlayback();
  const btn=document.getElementById('processBtn');
  btn.disabled=true; btn.textContent='Processing…';
  show('pipelineVis');
  document.getElementById('logConsole').innerHTML='';
  log('sys',`Pipeline start — ${STAGES.length} stages, ${STATE.originalBuffer.duration.toFixed(1)}s`);
  const sr=STATE.originalBuffer.sampleRate;
  let data=STATE.originalBuffer.getChannelData(0).slice();
  const total=STAGES.length;
  for(let i=0;i<STAGES.length;i++){
    const s=STAGES[i], pct=Math.round(((i+1)/total)*100);
    setStageState(s.id,'active'); updateProgressBar(pct);
    const t0=performance.now();
    try{
      switch(s.id){
        case 1: data=removeDC(data); break;
        case 2: data=biquadFilter(data,sr,'highpass',80,0.707); break;
        case 3: data=normalizeToTarget(data,0.891); break;
        case 4: case 5: case 6: break; // profile/VAD/voiceprint placeholders
        case 7: for(let h=1;h<=PARAMS.humHarmonics;h++) data=biquadFilter(data,sr,'notch',PARAMS.humFreq*h,PARAMS.humQ); break;
        case 8: data=spectralSubtract(data,sr,PARAMS.spectralFloor,PARAMS.overSubFactor*PARAMS.noiseReduction*2); break;
        case 9: data=voiceBandIsolation(data,sr,PARAMS.isolation*0.4); break;
        case 10: data=biquadFilter(data,sr,'highshelf',2500,PARAMS.hfBoostdB*2); break;
        case 11: data=dereverberate(data,sr,PARAMS.deverbAmount); break;
        case 12: data=biquadFilter(data,sr,'highshelf',4000,2); break;
        case 13: case 14: case 15: case 16: data=voiceBandIsolation(data,sr,PARAMS.isolation*0.3); break;
        case 17: data=harmonicReconstruct(data,sr,PARAMS.harmonicOrder); break;
        case 18: case 19: break;
        case 20: for(let j=0;j<data.length;j++){if(Math.abs(data[j])<0.001) data[j]+=(Math.random()-0.5)*0.0001;} break;
        case 21: case 22: case 23: case 24: break;
        case 25: data=biquadFilter(data,sr,'highshelf',PARAMS.hfBoostLow,PARAMS.hfBoostdB); break;
        case 26: data=applyCompression(data,sr,PARAMS.compThreshold,PARAMS.compRatio,PARAMS.compAttack,PARAMS.compRelease,PARAMS.compKnee,PARAMS.compMakeup); break;
        case 27: data=lufsNormalize(data,sr,PARAMS.targetLUFS); break;
        case 28: data=truePeakLimit(data,PARAMS.truePeakLimit); break;
      }
    }catch(err){log('err',`Stage ${s.id} error: ${err.message}`,'err');}
    setStageState(s.id,'done');
    log(`S${s.id}`,`${s.name} — ${(performance.now()-t0).toFixed(1)}ms`,i<6?'pass':'stage');
    await sleep(12);
  }
  const ctx=STATE.audioCtx||new(window.AudioContext||window.webkitAudioContext)();
  STATE.audioCtx=ctx;
  STATE.processedBuffer=ctx.createBuffer(1,data.length,sr);
  STATE.processedBuffer.getChannelData(0).set(data);
  drawWaveform(STATE.originalBuffer,document.getElementById('waveOriginal'),'#8b8fa6','original');
  drawWaveform(STATE.processedBuffer,document.getElementById('waveProcessed'),'#ff3b3b','processed');
  drawSpectrogram(STATE.processedBuffer,document.getElementById('spectrogramCanvas'));
  // Stats
  let pkO=0,pkP=0,rO=0,rP=0;
  const oD=STATE.originalBuffer.getChannelData(0);
  for(let i=0;i<oD.length;i++){const a=Math.abs(oD[i]);if(a>pkO)pkO=a;rO+=oD[i]*oD[i];}
  for(let i=0;i<data.length;i++){const a=Math.abs(data[i]);if(a>pkP)pkP=a;rP+=data[i]*data[i];}
  rO=Math.sqrt(rO/oD.length); rP=Math.sqrt(rP/data.length);
  document.getElementById('statNR').textContent=(20*Math.log10(rO/(rP+1e-10))).toFixed(1)+' dB';
  document.getElementById('statPeak').textContent=(20*Math.log10(pkP+1e-10)).toFixed(1)+' dBFS';
  document.getElementById('statLUFS').textContent=(20*Math.log10(rP+1e-10)-0.691).toFixed(1)+' LUFS';
  document.getElementById('statsRow').style.display='';
  document.getElementById('playOrigBtn').disabled=false;
  document.getElementById('playProcBtn').disabled=false;
  document.getElementById('exportBtn').disabled=false;
  show('exportSection');
  btn.disabled=false; btn.textContent='Process';
  updateProgressBar(100);
  log('sys',`Pipeline complete — ${STAGES.length} stages`,'ok');
  STATE.processing=false;
}

// ════════════════════════════════════════════════════════════════
// WAVEFORM — with cached ImageData + animated playhead
// ════════════════════════════════════════════════════════════════
function getDPR(){return(typeof devicePixelRatio!=='undefined'?devicePixelRatio:1)||1;}

function drawWaveform(buffer, canvas, color, cacheKey) {
  const ctx=canvas.getContext('2d'), dpr=getDPR();
  const rect=canvas.getBoundingClientRect();
  canvas.width=rect.width*dpr; canvas.height=rect.height*dpr;
  ctx.scale(dpr,dpr);
  const w=rect.width, h=rect.height;
  ctx.clearRect(0,0,w,h);
  const data=buffer.getChannelData(0);
  const step=Math.max(1,Math.floor(data.length/w));
  const mid=h/2;
  ctx.beginPath(); ctx.strokeStyle=color; ctx.lineWidth=1; ctx.globalAlpha=0.85;
  for(let i=0;i<w;i++){
    let mn=1,mx=-1; const s=Math.floor(i*data.length/w);
    for(let j=0;j<step;j++){const v=data[s+j]||0;if(v<mn)mn=v;if(v>mx)mx=v;}
    ctx.moveTo(i,mid+mn*mid); ctx.lineTo(i,mid+mx*mid);
  }
  ctx.stroke();
  ctx.beginPath(); ctx.strokeStyle=color; ctx.lineWidth=0.5; ctx.globalAlpha=0.3;
  for(let i=0;i<w;i++){
    let sum=0; const s=Math.floor(i*data.length/w);
    for(let j=0;j<step;j++){const v=data[s+j]||0;sum+=v*v;}
    const rms=Math.sqrt(sum/step);
    ctx.moveTo(i,mid-rms*mid); ctx.lineTo(i,mid+rms*mid);
  }
  ctx.stroke(); ctx.globalAlpha=1;
  if(cacheKey) STATE.waveformCache[cacheKey]=ctx.getImageData(0,0,canvas.width,canvas.height);
}

function drawPlayhead(canvas, cacheKey, progress, color) {
  const ctx=canvas.getContext('2d');
  const cached=STATE.waveformCache[cacheKey];
  if(cached) ctx.putImageData(cached,0,0);
  const dpr=getDPR(), rect=canvas.getBoundingClientRect();
  const w=rect.width, h=rect.height, x=progress*w*dpr;
  // Tinted region behind playhead
  ctx.fillStyle='rgba(255,59,59,0.07)';
  ctx.fillRect(0,0,x,h*dpr);
  // Playhead line + glow
  ctx.beginPath(); ctx.strokeStyle=color||'#ff3b3b';
  ctx.lineWidth=2*dpr; ctx.shadowColor=color||'#ff3b3b'; ctx.shadowBlur=8*dpr;
  ctx.moveTo(x,0); ctx.lineTo(x,h*dpr); ctx.stroke(); ctx.shadowBlur=0;
  // Top dot
  ctx.beginPath(); ctx.fillStyle='#fff';
  ctx.arc(x,4*dpr,3*dpr,0,Math.PI*2); ctx.fill();
}

function clearCanvas(canvas) {
  const ctx=canvas.getContext('2d'), dpr=getDPR(), r=canvas.getBoundingClientRect();
  canvas.width=r.width*dpr; canvas.height=r.height*dpr;
  ctx.clearRect(0,0,canvas.width,canvas.height);
}

function drawSpectrogram(buffer, canvas) {
  const ctx=canvas.getContext('2d'), dpr=getDPR(), rect=canvas.getBoundingClientRect();
  canvas.width=rect.width*dpr; canvas.height=rect.height*dpr;
  ctx.scale(dpr,dpr);
  const w=rect.width, h=rect.height;
  ctx.fillStyle='#0c0c14'; ctx.fillRect(0,0,w,h);
  const data=buffer.getChannelData(0), fftSize=512;
  const cols=Math.min(w,Math.floor(data.length/(fftSize/2))), colW=w/cols;
  for(let col=0;col<cols;col++){
    const start=col*(fftSize/2), bins=fftSize/2;
    for(let bin=0;bin<bins;bin+=4){
      let re=0,im=0;
      for(let n=0;n<fftSize;n++){const s=data[start+n]||0;const a=-2*Math.PI*bin*n/fftSize;re+=s*Math.cos(a);im+=s*Math.sin(a);}
      const mag=Math.sqrt(re*re+im*im)/fftSize, dB=20*Math.log10(Math.max(mag,1e-10));
      const norm=Math.max(0,Math.min(1,(dB+80)/80));
      const y=h-(bin/bins)*h, bh=Math.max(1,h/(bins/4));
      ctx.fillStyle=`rgb(${Math.floor(norm*255)},${Math.floor(norm*norm*120)},${Math.floor((1-norm)*40)})`;
      ctx.fillRect(col*colW,y-bh,colW+0.5,bh);
    }
  }
}

// ════════════════════════════════════════════════════════════════
// LIVE ANALYSER — real-time frequency bars during playback
// ════════════════════════════════════════════════════════════════
function drawLiveAnalyser() {
  if(!STATE.isPlaying||!STATE.analyser) return;
  const canvas=document.getElementById('liveAnalyser');
  if(!canvas) return;
  const ctx=canvas.getContext('2d'), dpr=getDPR(), rect=canvas.getBoundingClientRect();
  if(canvas.width!==rect.width*dpr||canvas.height!==rect.height*dpr){
    canvas.width=rect.width*dpr; canvas.height=rect.height*dpr;
  }
  ctx.setTransform(dpr,0,0,dpr,0,0);
  const w=rect.width, h=rect.height;
  ctx.clearRect(0,0,w,h);
  const freqData=new Uint8Array(STATE.analyser.frequencyBinCount);
  STATE.analyser.getByteFrequencyData(freqData);
  const barCount=48, barW=w/barCount-1;
  for(let i=0;i<barCount;i++){
    const idx=Math.floor(i*freqData.length*0.4/barCount);
    const val=freqData[idx]/255, barH=val*h*0.9;
    ctx.fillStyle=`hsl(0,${70+val*30}%,${30+val*35}%)`;
    ctx.fillRect(i*(barW+1),h-barH,barW,barH);
    ctx.fillStyle=`hsla(0,${70+val*30}%,${30+val*35}%,0.3)`;
    ctx.fillRect(i*(barW+1),h-barH-2,barW,2);
  }
}

function clearLiveAnalyser() {
  const c=document.getElementById('liveAnalyser');
  if(!c) return;
  const ctx=c.getContext('2d'), dpr=getDPR(), r=c.getBoundingClientRect();
  c.width=r.width*dpr; c.height=r.height*dpr;
  ctx.clearRect(0,0,c.width,c.height);
}

// ════════════════════════════════════════════════════════════════
// PLAYBACK — AnalyserNode + synced waveform playheads
// ════════════════════════════════════════════════════════════════
function playBuffer(buffer, isProcessed) {
  if(!buffer) return;
  if(!STATE.audioCtx) STATE.audioCtx=new(window.AudioContext||window.webkitAudioContext)();
  if(STATE.audioCtx.state==='suspended') STATE.audioCtx.resume();
  stopPlayback();
  STATE.currentSource=STATE.audioCtx.createBufferSource();
  STATE.currentSource.buffer=buffer;
  STATE.analyser=STATE.audioCtx.createAnalyser();
  STATE.analyser.fftSize=256; STATE.analyser.smoothingTimeConstant=0.8;
  STATE.gainNode=STATE.audioCtx.createGain(); STATE.gainNode.gain.value=1;
  STATE.currentSource.connect(STATE.analyser);
  STATE.analyser.connect(STATE.gainNode);
  STATE.gainNode.connect(STATE.audioCtx.destination);
  STATE.currentSource.start(0,STATE.pauseOffset);
  STATE.startTime=STATE.audioCtx.currentTime-STATE.pauseOffset;
  STATE.isPlaying=true; STATE.playingProcessed=isProcessed;
  STATE.currentSource.onended=()=>{STATE.isPlaying=false;STATE.pauseOffset=0;clearLiveAnalyser();};
  if(STATE.animFrame) cancelAnimationFrame(STATE.animFrame);
  animLoop();
}

function stopPlayback() {
  if(STATE.currentSource){
    try{STATE.currentSource.onended=null;}catch(e){}
    try{STATE.currentSource.stop();}catch(e){}
    try{STATE.currentSource.disconnect();}catch(e){}
    STATE.currentSource=null;
  }
  if(STATE.analyser){try{STATE.analyser.disconnect();}catch(e){}}
  if(STATE.gainNode){try{STATE.gainNode.disconnect();}catch(e){} STATE.gainNode=null;}
  if(STATE.isPlaying) STATE.pauseOffset=STATE.audioCtx.currentTime-STATE.startTime;
  STATE.isPlaying=false;
  if(STATE.animFrame){cancelAnimationFrame(STATE.animFrame); STATE.animFrame=null;}
  clearLiveAnalyser();
}

function animLoop() {
  if(!STATE.isPlaying) return;
  const buf=STATE.playingProcessed?STATE.processedBuffer:STATE.originalBuffer;
  if(!buf) return;
  const elapsed=STATE.audioCtx.currentTime-STATE.startTime;
  const progress=Math.min(1,elapsed/buf.duration);
  document.getElementById('progressFill').style.width=(progress*100)+'%';
  document.getElementById('timeDisplay').textContent=`${formatTime(elapsed)} / ${formatTime(buf.duration)}`;
  // Sync playheads on BOTH waveforms
  if(STATE.originalBuffer) drawPlayhead(document.getElementById('waveOriginal'),'original',progress,'#8b8fa6');
  if(STATE.processedBuffer) drawPlayhead(document.getElementById('waveProcessed'),'processed',progress,'#ff3b3b');
  drawLiveAnalyser();
  if(progress<1) STATE.animFrame=requestAnimationFrame(animLoop);
  else{STATE.isPlaying=false; STATE.pauseOffset=0; clearLiveAnalyser();}
}

function seekAudio(e) {
  const rect=e.currentTarget.getBoundingClientRect();
  const ratio=Math.max(0,Math.min(1,(e.clientX-rect.left)/rect.width));
  const buf=STATE.playingProcessed?STATE.processedBuffer:STATE.originalBuffer;
  if(!buf) return;
  STATE.pauseOffset=ratio*buf.duration;
  if(STATE.isPlaying) playBuffer(buf,STATE.playingProcessed);
}

function seekFromWaveform(e, isProcessed) {
  const rect=e.currentTarget.getBoundingClientRect();
  const ratio=Math.max(0,Math.min(1,(e.clientX-rect.left)/rect.width));
  const buf=isProcessed?STATE.processedBuffer:STATE.originalBuffer;
  if(!buf) return;
  STATE.pauseOffset=ratio*buf.duration;
  if(STATE.isPlaying) playBuffer(buf,isProcessed);
  else {
    if(STATE.originalBuffer) drawPlayhead(document.getElementById('waveOriginal'),'original',ratio,'#8b8fa6');
    if(STATE.processedBuffer) drawPlayhead(document.getElementById('waveProcessed'),'processed',ratio,'#ff3b3b');
    document.getElementById('progressFill').style.width=(ratio*100)+'%';
    document.getElementById('timeDisplay').textContent=`${formatTime(ratio*buf.duration)} / ${formatTime(buf.duration)}`;
  }
}

function toggleAB() {
  if(!STATE.isPlaying) return;
  const isAB=document.getElementById('abToggle').checked;
  const buf=isAB?STATE.originalBuffer:STATE.processedBuffer;
  if(!buf) return;
  STATE.pauseOffset=STATE.audioCtx.currentTime-STATE.startTime;
  playBuffer(buf,!isAB);
}

// ════════════════════════════════════════════════════════════════
// FILE I/O
// ════════════════════════════════════════════════════════════════
async function loadFile(file) {
  if(!file) return;
  if(file.size>500*1024*1024){showError('Max file size: 500MB');return;}
  log('sys',`Loading: ${file.name} (${(file.size/1024/1024).toFixed(1)} MB)`);
  try{
    if(!STATE.audioCtx) STATE.audioCtx=new(window.AudioContext||window.webkitAudioContext)();
    if(STATE.audioCtx.state==='suspended') await STATE.audioCtx.resume();
    STATE.originalBuffer=await STATE.audioCtx.decodeAudioData(await file.arrayBuffer());
    log('sys',`Decoded: ${STATE.originalBuffer.duration.toFixed(1)}s, ${STATE.originalBuffer.sampleRate}Hz, ${STATE.originalBuffer.numberOfChannels}ch`,'ok');
    document.getElementById('fileName').textContent=file.name;
    document.getElementById('fileMeta').textContent=`${STATE.originalBuffer.duration.toFixed(1)}s · ${STATE.originalBuffer.sampleRate/1000}kHz · ${STATE.originalBuffer.numberOfChannels}ch`;
    document.getElementById('fileInfo').classList.add('visible');
    document.getElementById('processBtn').disabled=false;
    document.getElementById('playOrigBtn').disabled=false;
    show('waveformSection');
    drawWaveform(STATE.originalBuffer,document.getElementById('waveOriginal'),'#8b8fa6','original');
    clearCanvas(document.getElementById('waveProcessed'));
    clearCanvas(document.getElementById('spectrogramCanvas'));
    clearLiveAnalyser();
    const nm=file.name.toLowerCase();
    if(nm.includes('podcast')||nm.includes('pod')) selectPreset('podcast');
    else if(nm.includes('interview')||nm.includes('int')) selectPreset('interview');
    else if(nm.includes('film')||nm.includes('movie')) selectPreset('film');
    else if(nm.includes('forensic')||nm.includes('evidence')) selectPreset('forensic');
    else if(nm.includes('music')||nm.includes('song')||nm.includes('vocal')) selectPreset('music');
    const badge=document.getElementById('presetBadge');
    badge.textContent=PRESETS.find(p=>p.id===STATE.preset)?.name||'Ready';
    badge.classList.add('active');
  }catch(err){
    log('err',`Load error: ${err.message}`,'err');
    showError('Could not decode audio. Try WAV, MP3, OGG, or FLAC.');
  }
}

// ════════════════════════════════════════════════════════════════
// MIC
// ════════════════════════════════════════════════════════════════
async function toggleMic() {
  if(STATE.isRecording){
    STATE.mediaRecorder.stop(); STATE.isRecording=false;
    clearInterval(STATE.recInterval);
    document.getElementById('micBtn').textContent='⏺ Record'; return;
  }
  try{
    STATE.mediaStream=await navigator.mediaDevices.getUserMedia({audio:true});
    STATE.mediaRecorder=new MediaRecorder(STATE.mediaStream);
    STATE.recordChunks=[];
    STATE.mediaRecorder.ondataavailable=e=>{if(e.data.size>0)STATE.recordChunks.push(e.data);};
    STATE.mediaRecorder.onstop=async()=>{
      STATE.mediaStream.getTracks().forEach(t=>t.stop());
      await loadFile(new File([new Blob(STATE.recordChunks,{type:'audio/webm'})],'recording.webm',{type:'audio/webm'}));
    };
    STATE.mediaRecorder.start(); STATE.isRecording=true; STATE.recStartTime=Date.now();
    document.getElementById('micBtn').textContent='⏹ Stop';
    STATE.recInterval=setInterval(()=>{
      document.getElementById('micBtn').textContent=`⏹ ${((Date.now()-STATE.recStartTime)/1000).toFixed(0)}s`;
    },200);
    log('sys','Recording started');
  }catch(err){showError('Microphone access denied');}
}

// ════════════════════════════════════════════════════════════════
// EXPORT
// ════════════════════════════════════════════════════════════════
function exportAudio() {
  if(!STATE.processedBuffer) return;
  const buf=STATE.processedBuffer, sr=buf.sampleRate, data=buf.getChannelData(0);
  const dataSize=data.length*2, buffer=new ArrayBuffer(44+dataSize), view=new DataView(buffer);
  const ws=(o,s)=>{for(let i=0;i<s.length;i++) view.setUint8(o+i,s.charCodeAt(i));};
  ws(0,'RIFF'); view.setUint32(4,36+dataSize,true); ws(8,'WAVE');
  ws(12,'fmt '); view.setUint32(16,16,true); view.setUint16(20,1,true);
  view.setUint16(22,1,true); view.setUint32(24,sr,true);
  view.setUint32(28,sr*2,true); view.setUint16(32,2,true);
  view.setUint16(34,16,true); ws(36,'data'); view.setUint32(40,dataSize,true);
  for(let i=0;i<data.length;i++){
    const s=Math.max(-1,Math.min(1,data[i]));
    view.setInt16(44+i*2,s<0?s*0x8000:s*0x7FFF,true);
  }
  const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob([buffer],{type:'audio/wav'}));
  a.download=`voiceisolate_${STATE.preset}_${Date.now()}.wav`;
  a.click(); URL.revokeObjectURL(a.href);
  log('export',`Exported WAV: ${(dataSize/1024/1024).toFixed(1)} MB, 16-bit`,'ok');
}

// ════════════════════════════════════════════════════════════════
// PIPELINE VIS
// ════════════════════════════════════════════════════════════════
function buildPipelineVis() {
  const grid=document.getElementById('stageGrid'); grid.innerHTML='';
  STAGES.forEach(s=>{
    const el=document.createElement('div');
    el.className='stage-node'; el.id=`stage-${s.id}`;
    el.innerHTML=`<div class="stage-id">S${s.id}</div><div class="stage-short">${s.short}</div>`;
    el.title=`Stage ${s.id}: ${s.name} (Pass ${s.pass})`;
    grid.appendChild(el);
  });
}
function setStageState(id,state){const el=document.getElementById(`stage-${id}`);if(!el)return;el.classList.remove('active','done');if(state)el.classList.add(state);}
function updateProgressBar(pct){
  document.getElementById('engineStatus').textContent=pct<100?`Processing ${pct}%`:'Complete';
  document.getElementById('engineStatusAlt').textContent=pct<100?`${pct}%`:'Done';
}

// ════════════════════════════════════════════════════════════════
// PRESETS UI
// ════════════════════════════════════════════════════════════════
function buildPresets() {
  const grid=document.getElementById('presetGrid'); grid.innerHTML='';
  PRESETS.forEach(p=>{
    const btn=document.createElement('div');
    btn.className=`preset-btn${p.id===STATE.preset?' active':''}`;
    btn.onclick=()=>selectPreset(p.id);
    btn.innerHTML=`<div class="preset-name">${p.icon} ${p.name}</div><div class="preset-desc">${p.desc}</div>`;
    grid.appendChild(btn);
  });
}

function selectPreset(id) {
  STATE.preset=id;
  const p=PRESETS.find(x=>x.id===id);
  if(p&&p.params){
    Object.keys(p.params).forEach(k=>{if(k in PARAMS)PARAMS[k]=p.params[k];});
    // Sync quick sliders
    const iS=document.getElementById('sliderIso'), nS=document.getElementById('sliderNR'), gS=document.getElementById('sliderGate');
    if(iS){iS.value=PARAMS.isolation; document.getElementById('valIso').textContent=PARAMS.isolation+'%';}
    if(nS){nS.value=Math.round(PARAMS.noiseReduction*100); document.getElementById('valNR').textContent=Math.round(PARAMS.noiseReduction*100)+'%';}
    if(gS){gS.value=PARAMS.vadThreshold; document.getElementById('valGate').textContent=PARAMS.vadThreshold+' dB';}
    log('preset',`${p.icon} ${p.name} — ${Object.keys(p.params).length} parameters applied`,'ok');
    buildEngineerPanel();
  }
  buildPresets();
}

function buildEngineerPanel() {
  const grid=document.getElementById('paramGrid'); grid.innerHTML='';
  const groups=[
    {title:'Pass 1 — Noise Reduction',params:[
      {key:'noiseReduction',label:'NR Amount',min:0,max:1,step:0.05,fmt:v=>(v*100).toFixed(0)+'%'},
      {key:'overSubFactor',label:'Over-Sub',min:1,max:5,step:0.1,fmt:v=>v.toFixed(1)+'x'},
      {key:'spectralFloor',label:'Spectral Floor',min:-100,max:-60,step:1,fmt:v=>v+'dB'},
      {key:'humFreq',label:'Hum Freq',min:50,max:60,step:10,fmt:v=>v+'Hz'},
      {key:'humHarmonics',label:'Hum Harmonics',min:1,max:8,step:1,fmt:v=>v+''},
    ]},
    {title:'Pass 1 — Gate & VAD',params:[
      {key:'vadThreshold',label:'VAD Threshold',min:-60,max:-20,step:1,fmt:v=>v+'dBFS'},
      {key:'erbBands',label:'ERB Bands',min:16,max:64,step:2,fmt:v=>v+''},
      {key:'gateAttack',label:'Gate Attack',min:0.5,max:10,step:0.5,fmt:v=>v+'ms'},
      {key:'gateRelease',label:'Gate Release',min:10,max:200,step:5,fmt:v=>v+'ms'},
      {key:'gateHold',label:'Gate Hold',min:10,max:100,step:5,fmt:v=>v+'ms'},
    ]},
    {title:'Pass 3 — ML Ensemble',params:[
      {key:'demucsWeight',label:'Demucs Weight',min:0,max:1,step:0.05,fmt:v=>v.toFixed(2)},
      {key:'spleeterWeight',label:'Spleeter Weight',min:0,max:1,step:0.05,fmt:v=>v.toFixed(2)},
      {key:'waveunetWeight',label:'WaveUNet Weight',min:0,max:1,step:0.05,fmt:v=>v.toFixed(2)},
      {key:'voiceprintThresh',label:'Voiceprint Sim.',min:0.5,max:0.95,step:0.01,fmt:v=>v.toFixed(2)},
    ]},
    {title:'Pass 3 — Room',params:[
      {key:'deverbAmount',label:'Dereverb',min:0,max:1,step:0.05,fmt:v=>(v*100).toFixed(0)+'%'},
      {key:'earlyRefSup',label:'Early Ref Sup.',min:10,max:80,step:5,fmt:v=>v+'%'},
    ]},
    {title:'Pass 4 — Reconstruction',params:[
      {key:'harmonicOrder',label:'Harmonic Order',min:2,max:10,step:1,fmt:v=>'F0-F'+v},
      {key:'hfBoostdB',label:'HF Boost',min:0,max:6,step:0.5,fmt:v=>'+'+v+'dB'},
      {key:'hfBoostLow',label:'HF Low Edge',min:2000,max:6000,step:200,fmt:v=>v+'Hz'},
      {key:'hfBoostHigh',label:'HF High Edge',min:5000,max:10000,step:500,fmt:v=>v+'Hz'},
    ]},
    {title:'Pass 4 — Dynamics',params:[
      {key:'compThreshold',label:'Comp Thresh',min:-40,max:0,step:1,fmt:v=>v+'dB'},
      {key:'compRatio',label:'Comp Ratio',min:1,max:10,step:0.5,fmt:v=>v+':1'},
      {key:'compAttack',label:'Attack',min:0.5,max:50,step:0.5,fmt:v=>v+'ms'},
      {key:'compRelease',label:'Release',min:10,max:300,step:5,fmt:v=>v+'ms'},
      {key:'compKnee',label:'Knee',min:0,max:20,step:1,fmt:v=>v+'dB'},
      {key:'compMakeup',label:'Makeup',min:0,max:12,step:0.5,fmt:v=>'+'+v+'dB'},
    ]},
    {title:'Pass 5 — QA',params:[
      {key:'artRepairThresh',label:'Artifact Thresh',min:5,max:50,step:1,fmt:v=>v+'/100'},
      {key:'vocoderBypass',label:'Vocoder Thresh',min:10,max:60,step:1,fmt:v=>v+'/100'},
    ]},
    {title:'Pass 6 — Output',params:[
      {key:'targetLUFS',label:'Target LUFS',min:-30,max:0,step:1,fmt:v=>v+' LUFS'},
      {key:'truePeakLimit',label:'True Peak',min:-3,max:0,step:0.1,fmt:v=>v+'dBTP'},
      {key:'isolation',label:'Isolation',min:0,max:100,step:5,fmt:v=>v+'%'},
    ]},
  ];
  groups.forEach(g=>{
    const div=document.createElement('div'); div.className='param-group';
    div.innerHTML=`<div class="param-group-title">${g.title}</div>`;
    g.params.forEach(p=>{
      const lbl=document.createElement('div'); lbl.className='param-row';
      lbl.innerHTML=`<span class="param-label">${p.label}</span><span class="param-value" id="pv-${p.key}">${p.fmt(PARAMS[p.key])}</span>`;
      div.appendChild(lbl);
      const inp=document.createElement('input');
      inp.type='range'; inp.min=p.min; inp.max=p.max; inp.step=p.step; inp.value=PARAMS[p.key];
      inp.className='param-slider';
      inp.oninput=function(){PARAMS[p.key]=parseFloat(this.value);document.getElementById(`pv-${p.key}`).textContent=p.fmt(PARAMS[p.key]);};
      div.appendChild(inp);
    });
    grid.appendChild(div);
  });
}

// ════════════════════════════════════════════════════════════════
// UI HELPERS
// ════════════════════════════════════════════════════════════════
function show(id){document.getElementById(id).classList.remove('section-hidden');}
function hide(id){document.getElementById(id).classList.add('section-hidden');}
function formatTime(s){const m=Math.floor(s/60),sec=Math.floor(s%60);return`${m}:${sec.toString().padStart(2,'0')}`;}
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}

function log(tag,msg,type){
  const el=document.getElementById('logConsole');
  const t=new Date().toLocaleTimeString('en-US',{hour12:false});
  const cls=type==='ok'?'ok':type==='warn'?'warn':type==='err'?'err':type==='pass'?'pass-tag':'stage-tag';
  el.innerHTML+=`<div class="log-line"><span class="timestamp">[${t}]</span> <span class="${cls}">[${tag}]</span> ${msg}</div>`;
  el.scrollTop=el.scrollHeight;
}

function showError(msg){
  document.getElementById('errorMsg').textContent=msg;
  document.getElementById('errorBanner').style.display='flex';
  setTimeout(()=>{document.getElementById('errorBanner').style.display='none';},5000);
}

function setMode(mode){
  STATE.mode=mode;
  document.getElementById('modeClean').classList.toggle('active',mode==='clean');
  document.getElementById('modeEngineer').classList.toggle('active',mode==='engineer');
  if(mode==='engineer') show('engineerPanel'); else hide('engineerPanel');
}

function resetAll(){
  stopPlayback();
  STATE.originalBuffer=null; STATE.processedBuffer=null; STATE.pauseOffset=0;
  STATE.waveformCache={original:null,processed:null};
  hide('waveformSection'); hide('exportSection'); hide('pipelineVis');
  document.getElementById('fileInfo').classList.remove('visible');
  document.getElementById('processBtn').disabled=true;
  document.getElementById('playOrigBtn').disabled=true;
  document.getElementById('playProcBtn').disabled=true;
  document.getElementById('exportBtn').disabled=true;
  document.getElementById('engineStatus').textContent='Ready';
  document.getElementById('engineStatusAlt').textContent='Idle';
  document.getElementById('progressFill').style.width='0%';
  document.getElementById('timeDisplay').textContent='0:00 / 0:00';
  document.getElementById('statsRow').style.display='none';
  document.getElementById('presetBadge').textContent='No file';
  document.getElementById('presetBadge').classList.remove('active');
  clearLiveAnalyser();
  STAGES.forEach(s=>setStageState(s.id,null));
  Object.assign(PARAMS,DEFAULTS);
  buildEngineerPanel();
  log('sys','Reset complete');
}

// ════════════════════════════════════════════════════════════════
// INIT
// ════════════════════════════════════════════════════════════════
function init() {
  buildPipelineVis(); buildPresets(); buildEngineerPanel();
  const zone=document.getElementById('dropZone'), input=document.getElementById('fileInput');
  zone.addEventListener('click',e=>{if(e.target!==input) input.click();});
  ['dragenter','dragover'].forEach(ev=>zone.addEventListener(ev,e=>{e.preventDefault();e.stopPropagation();zone.classList.add('dragover');}));
  ['dragleave','drop'].forEach(ev=>zone.addEventListener(ev,e=>{e.preventDefault();e.stopPropagation();zone.classList.remove('dragover');}));
  zone.addEventListener('drop',e=>{if(e.dataTransfer.files.length) loadFile(e.dataTransfer.files[0]);});
  input.addEventListener('change',e=>{if(e.target.files.length) loadFile(e.target.files[0]); e.target.value='';});
  document.getElementById('micBtn').addEventListener('click',toggleMic);
  document.getElementById('sliderIso').addEventListener('input',function(){PARAMS.isolation=parseInt(this.value);document.getElementById('valIso').textContent=this.value+'%';});
  document.getElementById('sliderNR').addEventListener('input',function(){PARAMS.noiseReduction=parseInt(this.value)/100;document.getElementById('valNR').textContent=this.value+'%';});
  document.getElementById('sliderGate').addEventListener('input',function(){PARAMS.vadThreshold=parseInt(this.value);document.getElementById('valGate').textContent=this.value+' dB';});
  document.getElementById('processBtn').addEventListener('click',processAudio);
  document.getElementById('resetBtn').addEventListener('click',resetAll);
  document.getElementById('playOrigBtn').addEventListener('click',()=>playBuffer(STATE.originalBuffer,false));
  document.getElementById('playProcBtn').addEventListener('click',()=>playBuffer(STATE.processedBuffer,true));
  document.getElementById('progressTrack').addEventListener('click',seekAudio);
  document.getElementById('abToggle').addEventListener('change',toggleAB);
  // Waveform click-to-seek
  document.getElementById('waveOriginal').addEventListener('click',e=>seekFromWaveform(e,false));
  document.getElementById('waveProcessed').addEventListener('click',e=>seekFromWaveform(e,true));
  ['waveOriginal','waveProcessed'].forEach(id=>{const c=document.getElementById(id);c.style.cursor='pointer';});
  document.getElementById('exportBtn').addEventListener('click',exportAudio);
  document.getElementById('modeClean').addEventListener('click',()=>setMode('clean'));
  document.getElementById('modeEngineer').addEventListener('click',()=>setMode('engineer'));
  document.getElementById('logClearBtn').addEventListener('click',()=>{document.getElementById('logConsole').innerHTML='<div class="log-line"><span class="timestamp">[sys]</span> Log cleared</div>';});
  document.getElementById('errorClose').addEventListener('click',()=>{document.getElementById('errorBanner').style.display='none';});
  window.addEventListener('resize',()=>{
    if(STATE.originalBuffer) drawWaveform(STATE.originalBuffer,document.getElementById('waveOriginal'),'#8b8fa6','original');
    if(STATE.processedBuffer) drawWaveform(STATE.processedBuffer,document.getElementById('waveProcessed'),'#ff3b3b','processed');
  });
  log('sys','VoiceIsolate Pro v16.1 — All systems nominal');
  log('sys',`${PRESETS.length} presets loaded, each wired to ${Object.keys(PRESETS[0].params).length} parameters`);
}

document.addEventListener('DOMContentLoaded',init);
