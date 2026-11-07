/**
 * VoiceIsolate Pro — the only WAV encoder.
 *
 * Classic-script safe (no import/export) so Engineer, the DSP worker, and
 * Node tests can load the same file the ESM facade re-exports. Integer PCM
 * is 16- or 24-bit with triangular dither and error-feedback noise shaping.
 * 32-bit is WAVE_FORMAT_IEEE_FLOAT with a fact chunk. Dither runs here, at
 * the final export, and nowhere earlier in the chain.
 */
'use strict';

var VIP_WAV_TPDF_LSB_16 = 1 / 32768;
// Mode 2/3 feed the quantization error back. They used to high-pass the
// dither itself (d[n] - a*d[n-1]), which does not shape the error spectrum.
var VIP_WAV_FEEDBACK = [0, 0, 0.45, 0.82];

function vipWavMulberry32(seed) {
  var state = (Number(seed) >>> 0) || 1;
  return function rand() {
    state = (state + 0x6d2b79f5) >>> 0;
    var t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function vipWavWriteString(view, offset, str) {
  for (var i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

function vipWavNormalizeOptions(options) {
  var src = options || {};
  var ditherMode = Math.max(0, Math.min(3, Math.round(Number(src.ditherAmt) || 0)));
  var requestedBits = Number(src.bitDepth);
  var bits = 16;
  if (Number.isFinite(requestedBits) && requestedBits >= 28) bits = 32;
  else if (Number.isFinite(requestedBits) && requestedBits >= 20) bits = 24;
  var truePeakDb = Number.isFinite(Number(src.truePeakDb)) ? Number(src.truePeakDb) : null;
  var ditherSeed = null;
  if (ditherMode > 0 && bits !== 32 && Number.isFinite(Number(src.ditherSeed))) {
    ditherSeed = (Number(src.ditherSeed) >>> 0) || 1;
  }
  return { ditherAmt: ditherMode, bitDepth: bits, truePeakDb: truePeakDb, ditherSeed: ditherSeed };
}

function vipWavPlan(numChannels, frames, sampleRate, options) {
  var normalized = options && options.bitDepth ? options : vipWavNormalizeOptions(options);
  var bits = normalized.bitDepth;
  var kind = bits === 32 ? 'float' : 'pcm';
  var bytesPerSample = bits === 32 ? 4 : bits === 24 ? 3 : 2;
  var headerBytes = kind === 'float' ? 58 : 44;
  var safeFrames = frames > 0 ? frames : 0;
  var safeChannels = numChannels > 0 ? numChannels : 1;
  var dataBytes = safeFrames * safeChannels * bytesPerSample;
  var fileBytes = headerBytes + dataBytes;
  var riffSize = fileBytes - 8;
  var tooBig = !Number.isFinite(fileBytes) || riffSize > 0xFFFFFFFF;
  return {
    kind: kind,
    bits: bits === 32 ? 32 : bytesPerSample * 8,
    formatTag: kind === 'float' ? 3 : 1,
    bytesPerSample: bytesPerSample,
    numChannels: safeChannels,
    frames: safeFrames,
    sampleRate: sampleRate >>> 0,
    headerBytes: headerBytes,
    dataBytes: dataBytes,
    byteLength: tooBig ? 0 : fileBytes,
    riffSize: riffSize,
    tooBig: tooBig,
    dataOffset: headerBytes,
    ditherAmt: normalized.ditherAmt,
    ditherSeed: normalized.ditherSeed,
    truePeakDb: normalized.truePeakDb,
  };
}

function vipWavWriteHeader(view, plan) {
  var block = plan.numChannels * plan.bytesPerSample;
  vipWavWriteString(view, 0, 'RIFF');
  view.setUint32(4, plan.riffSize >>> 0, true);
  vipWavWriteString(view, 8, 'WAVE');
  vipWavWriteString(view, 12, 'fmt ');
  if (plan.kind === 'float') {
    view.setUint32(16, 18, true);
    view.setUint16(20, 3, true);
    view.setUint16(22, plan.numChannels, true);
    view.setUint32(24, plan.sampleRate, true);
    view.setUint32(28, plan.sampleRate * block, true);
    view.setUint16(32, block, true);
    view.setUint16(34, 32, true);
    view.setUint16(36, 0, true);
    vipWavWriteString(view, 38, 'fact');
    view.setUint32(42, 4, true);
    view.setUint32(46, plan.frames, true);
    vipWavWriteString(view, 50, 'data');
    view.setUint32(54, plan.dataBytes, true);
    return;
  }
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, plan.numChannels, true);
  view.setUint32(24, plan.sampleRate, true);
  view.setUint32(28, plan.sampleRate * block, true);
  view.setUint16(32, block, true);
  view.setUint16(34, plan.bits, true);
  vipWavWriteString(view, 36, 'data');
  view.setUint32(40, plan.dataBytes, true);
}

function vipWavQuantizePcm(sample, bits) {
  var neg = 1 << (bits - 1);
  var pos = neg - 1;
  var s = sample > 1 ? 1 : sample < -1 ? -1 : sample;
  var scaled = s < 0 ? s * neg : s * pos;
  var q = Math.round(scaled);
  if (q > pos) q = pos;
  else if (q < -neg) q = -neg;
  return { q: q, recon: q < 0 ? q / neg : q / pos };
}

function vipWavCreateState(numChannels, options, plan) {
  var normalized = options && options.bitDepth ? options : vipWavNormalizeOptions(options);
  var mode = plan.kind === 'float' ? 0 : normalized.ditherAmt;
  var rand = Math.random;
  if (mode > 0 && normalized.ditherSeed != null) rand = vipWavMulberry32(normalized.ditherSeed);
  return {
    mode: mode,
    rand: rand,
    feedback: mode > 0 ? VIP_WAV_FEEDBACK[mode] : 0,
    error: new Float64Array(numChannels),
    gain: 1,
    clipped: 0,
    lsb: plan.bits === 24 ? 1 / 8388608 : VIP_WAV_TPDF_LSB_16,
  };
}

function vipWavQuantizeRange(view, channels, from, to, plan, state) {
  var nch = plan.numChannels;
  var bps = plan.bytesPerSample;
  for (var i = from; i < to; i++) {
    for (var ch = 0; ch < nch; ch++) {
      var raw = channels[ch][i];
      var finite = Number.isFinite(raw);
      if (!finite) raw = 0;
      else if (raw > 1 || raw < -1) state.clipped++;
      var y = raw * state.gain;
      if (plan.kind === 'float') {
        view.setFloat32(plan.dataOffset + (i * nch + ch) * 4, y, true);
        continue;
      }
      if (state.mode > 0) {
        var dither = (state.rand() - state.rand()) * state.lsb;
        y += dither - state.feedback * state.error[ch];
      }
      var coded = vipWavQuantizePcm(y, plan.bits);
      if (state.feedback !== 0) state.error[ch] = coded.recon - y;
      var off = plan.dataOffset + (i * nch + ch) * bps;
      if (bps === 2) view.setInt16(off, coded.q, true);
      else {
        view.setUint8(off, coded.q & 0xff);
        view.setUint8(off + 1, (coded.q >> 8) & 0xff);
        view.setUint8(off + 2, (coded.q >> 16) & 0xff);
      }
    }
  }
}

// 4× windowed-sinc interpolator. Phase taps sum to ~1 so a constant measures
// as itself; the other phases are the inter-sample points BS.1770 estimates
// by oversampling. History is a ring so a long export does not shift a buffer
// on every sample.
var VIP_WAV_PHASES = (function designPhases() {
  // Integer-centered Nyquist sinc: one phase is an impulse, so every input
  // sample appears in the 4× stream and the measured peak cannot hide under
  // the sample peak. Other phases are the inter-sample points.
  var factor = 4;
  var tapsPerPhase = 32;
  var taps = factor * tapsPerPhase;
  var center = taps / 2;
  var h = new Float64Array(taps);
  for (var i = 0; i < taps; i++) {
    var x = i - center;
    var sinc = x === 0 ? 1 : Math.sin(Math.PI * x / factor) / (Math.PI * x / factor);
    var window = 0.5 + 0.5 * Math.cos((2 * Math.PI * x) / taps);
    h[i] = sinc * window;
  }
  var phases = [];
  for (var p = 0; p < factor; p++) {
    var phase = new Float64Array(tapsPerPhase);
    var sum = 0;
    for (var k = 0; k < tapsPerPhase; k++) {
      phase[k] = h[p + k * factor];
      sum += phase[k];
    }
    // Constant in → constant out. The impulse phase already sums to 1.
    if (sum !== 0) {
      for (var k2 = 0; k2 < tapsPerPhase; k2++) phase[k2] /= sum;
    }
    phases.push(phase);
  }
  return phases;
})();

function vipWavCreateMeter() {
  var depth = VIP_WAV_PHASES[0].length;
  var hist = [];
  var heads = [];
  var last = [];
  var primed = [];
  var peak = 0;
  function ensure(n) {
    while (hist.length < n) {
      hist.push(new Float64Array(depth));
      heads.push(0);
      last.push(0);
      primed.push(false);
    }
  }
  function fill(ch, x) {
    var ring = hist[ch];
    for (var k = 0; k < depth; k++) ring[k] = x;
    heads[ch] = 0;
    last[ch] = x;
    primed[ch] = true;
  }
  function step(ch, x) {
    var ring = hist[ch];
    var head = heads[ch];
    ring[head] = x;
    last[ch] = x;
    for (var p = 0; p < 4; p++) {
      var coeff = VIP_WAV_PHASES[p];
      var acc = 0;
      var idx = head;
      for (var k = 0; k < depth; k++) {
        acc += ring[idx] * coeff[k];
        idx = idx === 0 ? depth - 1 : idx - 1;
      }
      var mag = acc < 0 ? -acc : acc;
      if (mag > peak) peak = mag;
    }
    heads[ch] = head + 1 === depth ? 0 : head + 1;
  }
  function sampleAt(chArrays, c, i) {
    var s = chArrays[c][i];
    return Number.isFinite(s) ? s : 0;
  }
  return {
    push: function push(chArrays, from, to) {
      var n = chArrays.length;
      ensure(n);
      for (var c = 0; c < n; c++) {
        if (!primed[c] && to > from) fill(c, sampleAt(chArrays, c, from));
      }
      for (var i = from; i < to; i++) {
        for (var ch = 0; ch < n; ch++) step(ch, sampleAt(chArrays, ch, i));
      }
    },
    pushMono: function pushMono(samples) {
      ensure(1);
      if (!primed[0] && samples.length) {
        var s0 = samples[0];
        fill(0, Number.isFinite(s0) ? s0 : 0);
      }
      for (var i = 0; i < samples.length; i++) {
        var s = samples[i];
        step(0, Number.isFinite(s) ? s : 0);
      }
    },
    // Hold the last sample through the filter delay. Flushing zeros would
    // invent a step at the file edge and report a fake inter-sample peak.
    finish: function finish() {
      var n = hist.length;
      for (var i = 0; i < depth; i++) {
        for (var c = 0; c < n; c++) step(c, last[c]);
      }
    },
    get peak() { return peak; },
  };
}

function vipWavLinearCeiling(ceilingDb) {
  var db = Number.isFinite(ceilingDb) ? Math.min(ceilingDb, 0) : -1;
  return Math.pow(10, db / 20);
}

function vipWavGainForPeak(peak, ceilingDb) {
  if (!Number.isFinite(ceilingDb)) return 1;
  var ceiling = vipWavLinearCeiling(ceilingDb);
  if (!(peak > ceiling) || !(peak > 0)) return 1;
  // 1e-5 keeps float32 round-trip of the same meter from poking back over.
  return (ceiling / peak) * (1 - 1e-5);
}

function vipWavMeasureChannels(channels) {
  var meter = vipWavCreateMeter();
  var frames = channels[0] ? channels[0].length : 0;
  if (frames > 0) meter.push(channels, 0, frames);
  meter.finish();
  return meter.peak;
}

function vipWavLimitInPlace(data, ceilingDb) {
  var ceiling = vipWavLinearCeiling(ceilingDb);
  for (var pass = 0; pass < 3; pass++) {
    var meter = vipWavCreateMeter();
    meter.pushMono(data);
    meter.finish();
    if (!(meter.peak > ceiling) || !(meter.peak > 0)) return data;
    var gain = vipWavGainForPeak(meter.peak, ceilingDb);
    for (var i = 0; i < data.length; i++) data[i] *= gain;
  }
  return data;
}

function vipWavEncodeArrayBuffer(channels, sampleRate, options) {
  var normalized = vipWavNormalizeOptions(options);
  var frames = channels[0] ? channels[0].length : 0;
  var plan = vipWavPlan(channels.length || 1, frames, sampleRate, normalized);
  if (plan.tooBig) {
    throw new RangeError('This export exceeds the 4 GB WAV limit. Trim the region and export again.');
  }
  var buffer = new ArrayBuffer(plan.byteLength);
  var view = new DataView(buffer);
  vipWavWriteHeader(view, plan);
  var state = vipWavCreateState(plan.numChannels, normalized, plan);
  if (normalized.truePeakDb != null && frames > 0) {
    var meter = vipWavCreateMeter();
    meter.push(channels, 0, frames);
    meter.finish();
    state.gain = vipWavGainForPeak(meter.peak, normalized.truePeakDb);
  }
  if (frames > 0) vipWavQuantizeRange(view, channels, 0, frames, plan, state);
  return { buffer: buffer, clippedSamples: state.clipped, plan: plan };
}

function vipWavHeaderBytes(numChannels, sampleRate, frames, bitDepth) {
  var plan = vipWavPlan(numChannels, frames, sampleRate, vipWavNormalizeOptions({ bitDepth: bitDepth, ditherAmt: 0 }));
  if (plan.tooBig) {
    throw new RangeError('This export exceeds the 4 GB WAV limit. Trim the region and export again.');
  }
  var buffer = new ArrayBuffer(plan.headerBytes);
  vipWavWriteHeader(new DataView(buffer), plan);
  return new Uint8Array(buffer);
}

function vipWavInterleaveFloat32(channels) {
  var n = channels[0].length;
  var nch = channels.length;
  var bytes = new Uint8Array(n * nch * 4);
  var view = new DataView(bytes.buffer);
  var o = 0;
  for (var i = 0; i < n; i++) {
    for (var c = 0; c < nch; c++) {
      var s = channels[c][i];
      view.setFloat32(o, Number.isFinite(s) ? s : 0, true);
      o += 4;
    }
  }
  return bytes;
}

var VIPWavEncoderApi = {
  normalizeOptions: vipWavNormalizeOptions,
  planWav: function planWav(numChannels, frames, sampleRate, options) {
    return vipWavPlan(numChannels, frames, sampleRate, vipWavNormalizeOptions(options));
  },
  writeWavHeader: vipWavWriteHeader,
  createQuantizeState: function createQuantizeState(numChannels, options, plan) {
    return vipWavCreateState(numChannels, vipWavNormalizeOptions(options), plan);
  },
  quantizeRange: vipWavQuantizeRange,
  createTruePeakMeter: vipWavCreateMeter,
  gainForTruePeak: vipWavGainForPeak,
  measureTruePeak: vipWavMeasureChannels,
  limitTruePeakInPlace: vipWavLimitInPlace,
  encodeWavArrayBuffer: vipWavEncodeArrayBuffer,
  wavHeaderBytes: vipWavHeaderBytes,
  interleaveFloat32: vipWavInterleaveFloat32,
  linearCeiling: vipWavLinearCeiling,
};

globalThis.VIPWavEncoder = VIPWavEncoderApi;
