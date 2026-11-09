/**
 * Classic-script 24-D mel voiceprint. Same math as
 * src/core/diarization.js melBands + src/core/TargetSpeaker.js
 * extractLocalVoiceprint (symmetric Hann, sum-normalised mel, then L2).
 * No network. Loaded by ml-worker via importScripts.
 */
'use strict';

var VIP_VOICEPRINT_BANDS = 24;
var VIP_VOICEPRINT_MIN_SEC = 0.4;
var VIP_VOICEPRINT_MAX_SEC = 12;
var VIP_VOICEPRINT_SPEECH_RMS = 0.008;
var VIP_FINGERPRINT_FFT = 8192;

var _vipVpFftCache = Object.create(null);
var _vipVpMelCache = Object.create(null);
var _vipVpHannCache = Object.create(null);

function vipVpNextPow2(n) {
  var p = 1;
  while (p < n) p <<= 1;
  return p;
}

function vipVpFftTables(n) {
  if (_vipVpFftCache[n]) return _vipVpFftCache[n];
  var rev = new Uint32Array(n);
  var bits = Math.log2(n);
  for (var i = 0; i < n; i++) {
    var r = 0;
    for (var b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  var cos = new Float32Array(n / 2);
  var sin = new Float32Array(n / 2);
  for (var k = 0; k < n / 2; k++) {
    cos[k] = Math.cos((-2 * Math.PI * k) / n);
    sin[k] = Math.sin((-2 * Math.PI * k) / n);
  }
  _vipVpFftCache[n] = { rev: rev, cos: cos, sin: sin };
  return _vipVpFftCache[n];
}

function vipVpFftForward(re, im) {
  var n = re.length;
  var tables = vipVpFftTables(n);
  var rev = tables.rev;
  var cos = tables.cos;
  var sin = tables.sin;
  for (var i = 0; i < n; i++) {
    var r = rev[i];
    if (r > i) {
      var t = re[i]; re[i] = re[r]; re[r] = t;
      t = im[i]; im[i] = im[r]; im[r] = t;
    }
  }
  for (var size = 2; size <= n; size <<= 1) {
    var half = size >> 1;
    var step = n / size;
    for (var i0 = 0; i0 < n; i0 += size) {
      for (var j = 0, tw = 0; j < half; j++, tw += step) {
        var wr = cos[tw];
        var wi = sin[tw];
        var a = i0 + j;
        var bIdx = a + half;
        var tr = re[bIdx] * wr - im[bIdx] * wi;
        var ti = re[bIdx] * wi + im[bIdx] * wr;
        re[bIdx] = re[a] - tr; im[bIdx] = im[a] - ti;
        re[a] += tr; im[a] += ti;
      }
    }
  }
}

function vipVpHann(n) {
  if (_vipVpHannCache[n]) return _vipVpHannCache[n];
  var w = new Float32Array(n);
  for (var i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  _vipVpHannCache[n] = w;
  return w;
}

function vipVpMelFilterbank(fftSize, sampleRate, bands) {
  var key = fftSize + ':' + sampleRate + ':' + bands;
  if (_vipVpMelCache[key]) return _vipVpMelCache[key];
  var nBins = fftSize / 2 + 1;
  var hzToMel = function (hz) { return 2595 * Math.log10(1 + hz / 700); };
  var melToHz = function (mel) { return 700 * (Math.pow(10, mel / 2595) - 1); };
  var melMax = hzToMel(sampleRate / 2);
  var points = new Float32Array(bands + 2);
  for (var i = 0; i < points.length; i++) {
    var hz = melToHz((i / (bands + 1)) * melMax);
    points[i] = Math.round((hz / (sampleRate / 2)) * (nBins - 1));
  }
  var filters = [];
  for (var b = 0; b < bands; b++) {
    filters.push({ start: points[b], peak: points[b + 1], end: points[b + 2] });
  }
  _vipVpMelCache[key] = { nBins: nBins, filters: filters };
  return _vipVpMelCache[key];
}

function vipVpMelBands(frame, sampleRate, bands) {
  var out = new Float32Array(bands);
  if (!(frame instanceof Float32Array) || frame.length <= 1 ||
      !Number.isFinite(sampleRate) || sampleRate <= 0) {
    return out;
  }
  var usable = Math.min(frame.length, VIP_FINGERPRINT_FFT);
  var fftSize = vipVpNextPow2(usable);
  var win = vipVpHann(usable);
  var re = new Float32Array(fftSize);
  var im = new Float32Array(fftSize);
  for (var i = 0; i < usable; i++) re[i] = frame[i] * win[i];
  vipVpFftForward(re, im);
  var bank = vipVpMelFilterbank(fftSize, sampleRate, bands);
  var nBins = bank.nBins;
  var filters = bank.filters;
  var power = new Float32Array(nBins);
  for (var k = 0; k < nBins; k++) power[k] = re[k] * re[k] + im[k] * im[k];
  var total = 0;
  for (var b = 0; b < bands; b++) {
    var start = filters[b].start;
    var peak = filters[b].peak;
    var end = filters[b].end;
    var e = 0;
    for (var bin = start; bin <= end; bin++) {
      if (bin < 0 || bin >= nBins) continue;
      var weight = bin <= peak
        ? (peak > start ? (bin - start) / (peak - start) : 1)
        : (end > peak ? (end - bin) / (end - peak) : 1);
      e += power[bin] * weight;
    }
    out[b] = e;
    total += e;
  }
  if (total > 1e-12) {
    for (var b2 = 0; b2 < bands; b2++) out[b2] /= total;
  }
  return out;
}

function vipVpValidate(samples, sampleRate) {
  var dur = samples.length / (sampleRate || 1);
  if (dur < VIP_VOICEPRINT_MIN_SEC) {
    return { ok: false, reason: 'Enrollment too short (' + dur.toFixed(2) + 's). Select ≥ ' + VIP_VOICEPRINT_MIN_SEC + 's of speech.' };
  }
  if (dur > VIP_VOICEPRINT_MAX_SEC) {
    return { ok: false, reason: 'Enrollment too long (' + dur.toFixed(1) + 's). Keep under ' + VIP_VOICEPRINT_MAX_SEC + 's.' };
  }
  var frame = Math.max(64, Math.floor(sampleRate * 0.02));
  var hop = Math.max(32, Math.floor(frame / 2));
  var thr = VIP_VOICEPRINT_SPEECH_RMS;
  var sumSq = 0;
  var speech = 0;
  var frames = 0;
  for (var i = 0; i + frame <= samples.length; i += hop) {
    var e = 0;
    for (var j = 0; j < frame; j++) e += samples[i + j] * samples[i + j];
    var rms = Math.sqrt(e / frame);
    sumSq += e;
    frames++;
    if (rms >= thr) speech++;
  }
  var speechRatio = speech / Math.max(1, frames);
  var rmsAll = Math.sqrt(sumSq / Math.max(1, samples.length));
  if (speechRatio < 0.35 || rmsAll < thr * 0.5) {
    return { ok: false, reason: 'Selected region has little speech. Pick a clearer talking segment.', speechRatio: speechRatio, rms: rmsAll };
  }
  return { ok: true, speechRatio: speechRatio, rms: rmsAll };
}

function vipVpExtract(samples, sampleRate) {
  var bands = VIP_VOICEPRINT_BANDS;
  var win = Math.max(64, Math.floor(sampleRate * 0.2));
  var hop = Math.max(32, Math.floor(sampleRate * 0.1));
  var acc = new Float32Array(bands);
  var count = 0;
  var thr = VIP_VOICEPRINT_SPEECH_RMS;
  for (var i = 0; i + win <= samples.length; i += hop) {
    var frame = samples.subarray(i, i + win);
    var e = 0;
    for (var j = 0; j < frame.length; j++) e += frame[j] * frame[j];
    if (Math.sqrt(e / frame.length) < thr) continue;
    var mel = vipVpMelBands(frame, sampleRate, bands);
    for (var b = 0; b < bands; b++) acc[b] += mel[b];
    count++;
  }
  if (count === 0) return vipVpMelBands(samples, sampleRate, bands);
  for (var b2 = 0; b2 < bands; b2++) acc[b2] /= count;
  var n2 = 0;
  for (var b3 = 0; b3 < bands; b3++) n2 += acc[b3] * acc[b3];
  n2 = Math.sqrt(n2) || 1;
  for (var b4 = 0; b4 < bands; b4++) acc[b4] /= n2;
  return acc;
}

var VIPVoiceprint = {
  BANDS: VIP_VOICEPRINT_BANDS,
  MIN_ENROLL_SEC: VIP_VOICEPRINT_MIN_SEC,
  extractLocalVoiceprint: vipVpExtract,
  validateEnrollment: vipVpValidate,
  melBands: vipVpMelBands,
};

var _root = typeof globalThis !== 'undefined' ? globalThis : self;
_root.VIPVoiceprint = VIPVoiceprint;
