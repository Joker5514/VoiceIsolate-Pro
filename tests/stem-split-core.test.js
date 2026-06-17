/**
 * VoiceIsolate Pro — Stem-Split & Live-Mix Core Tests
 *
 * Covers the Layer 1 primitives (audio-config, BufferPool, ModelManifest)
 * and the PlaybackMixer control surface against a mock AudioContext.
 * Modules are ESM (src/), loaded via dynamic import under
 * --experimental-vm-modules (same pattern as server.test.js).
 */

'use strict';

let audioConfig;
let BufferPool;
let manifest;
let PlaybackMixer;

beforeAll(async () => {
  audioConfig = await import('../src/core/audio-config.js');
  ({ BufferPool } = await import('../src/core/BufferPool.js'));
  manifest = await import('../src/core/ModelManifest.js');
  ({ PlaybackMixer } = await import('../src/pipeline/PlaybackMixer.js'));
});

// ── audio-config ──────────────────────────────────────────────────────────────
describe('audio-config (Layer 1)', () => {
  test('canonical sample rate is 48000', () => {
    expect(audioConfig.SAMPLE_RATE).toBe(48000);
  });

  test('resampledLength converts 44.1k lengths to 48k', () => {
    expect(audioConfig.resampledLength(44100, 44100)).toBe(48000);
    expect(() => audioConfig.resampledLength(10, 0)).toThrow(RangeError);
  });

  test('verifyContextSampleRate warns on mismatch and passes on match', () => {
    const warnings = [];
    const warn = (m) => warnings.push(m);
    expect(audioConfig.verifyContextSampleRate({ sampleRate: 48000 }, warn)).toBe(true);
    expect(warnings).toHaveLength(0);
    expect(audioConfig.verifyContextSampleRate({ sampleRate: 44100 }, warn)).toBe(false);
    expect(warnings[0]).toContain('44100');
  });
});

// ── BufferPool ────────────────────────────────────────────────────────────────
describe('BufferPool (Layer 1)', () => {
  test('acquires pre-allocated buffers without allocation misses', () => {
    const pool = new BufferPool({ sizes: [128, 2048, 4096], preallocate: 2 });
    const a = pool.acquire(2048);
    expect(a).toBeInstanceOf(Float32Array);
    expect(a.length).toBe(2048);
    expect(pool.stats().misses).toBe(0);
  });

  test('release zero-fills and recycles the same buffer', () => {
    const pool = new BufferPool({ sizes: [128], preallocate: 1 });
    const a = pool.acquire(128);
    a[0] = 42;
    pool.release(a);
    const b = pool.acquire(128);
    expect(b).toBe(a);
    expect(b[0]).toBe(0);
  });

  test('double-release and foreign buffers are ignored safely', () => {
    const pool = new BufferPool({ sizes: [128], preallocate: 1 });
    const a = pool.acquire(128);
    pool.release(a);
    pool.release(a);                       // double release
    pool.release(new Float32Array(128));   // never acquired
    expect(pool.stats().released).toBe(1);
  });

  test('unmanaged sizes are adopted (counted as misses)', () => {
    const pool = new BufferPool({ sizes: [128], preallocate: 1 });
    const odd = pool.acquire(777);
    expect(odd.length).toBe(777);
    expect(pool.stats().misses).toBe(1);
    pool.release(odd);
    expect(pool.acquire(777)).toBe(odd);
  });

  test('rejects invalid configuration and sizes', () => {
    expect(() => new BufferPool({ sizes: [] })).toThrow(RangeError);
    const pool = new BufferPool({ sizes: [128] });
    expect(() => pool.acquire(0)).toThrow(RangeError);
    expect(() => pool.acquire(1.5)).toThrow(RangeError);
  });
});

// ── ModelManifest ─────────────────────────────────────────────────────────────
describe('ModelManifest (Layer 1)', () => {
  test('declares the noise-suppression and vocal-separation models with valid entries', () => {
    expect(manifest.MODEL_IDS).toEqual(
      expect.arrayContaining(['rnnoise', 'bsrnn_vocals'])
    );
    for (const id of manifest.MODEL_IDS) {
      expect(manifest.isValidEntry(manifest.MODEL_MANIFEST[id])).toBe(true);
    }
  });

  test('model URLs are same-origin paths (never CDN)', () => {
    for (const id of manifest.MODEL_IDS) {
      const { url } = manifest.MODEL_MANIFEST[id];
      expect(url.startsWith('/')).toBe(true);
      expect(url).not.toMatch(/^https?:/);
    }
  });

  test('every shipped model has a pinned 64-char lowercase hex sha256', () => {
    for (const id of manifest.MODEL_IDS) {
      const { sha256 } = manifest.MODEL_MANIFEST[id];
      expect(sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test('getModel throws a descriptive error on unknown ids', () => {
    expect(() => manifest.getModel('nope')).toThrow(/Unknown model 'nope'/);
    expect(manifest.getModel('bsrnn_vocals').task).toBe('vocal-separation');
    expect(manifest.getModel('rnnoise').task).toBe('noise-suppression');
  });

  test('manifest is frozen (no runtime mutation)', () => {
    expect(Object.isFrozen(manifest.MODEL_MANIFEST)).toBe(true);
    expect(Object.isFrozen(manifest.MODEL_MANIFEST.bsrnn_vocals)).toBe(true);
  });

  test('committed model binaries match the manifest size and SHA-256 exactly', () => {
    const fs = require('fs');
    const path = require('path');
    const crypto = require('crypto');
    for (const id of manifest.MODEL_IDS) {
      const entry = manifest.MODEL_MANIFEST[id];
      const file = path.join(__dirname, '../public', entry.url);
      expect(fs.existsSync(file)).toBe(true);
      const bytes = fs.readFileSync(file);
      expect(bytes.length).toBe(entry.sizeBytes);
      const digest = crypto.createHash('sha256').update(bytes).digest('hex');
      expect(digest).toBe(entry.sha256);
    }
  });
});

// ── PlaybackMixer (mock AudioContext) ─────────────────────────────────────────
function mockParam() {
  return { value: 0, setTargetAtTime: jest.fn(), cancelScheduledValues: jest.fn() };
}

function mockNode(extra = {}) {
  return { connect: jest.fn(), disconnect: jest.fn(), ...extra };
}

function mockContext() {
  return {
    sampleRate: 48000,
    currentTime: 0,
    state: 'running',
    destination: mockNode(),
    createGain: () => mockNode({ gain: mockParam() }),
    createBiquadFilter: () => mockNode({
      type: '', frequency: mockParam(), gain: mockParam(), Q: mockParam(),
    }),
    createAnalyser: () => mockNode({ fftSize: 0 }),
    createChannelSplitter: () => mockNode(),
    createChannelMerger: () => mockNode(),
    createDynamicsCompressor: () => mockNode({
      threshold: mockParam(), knee: mockParam(), ratio: mockParam(),
      attack: mockParam(), release: mockParam(), reduction: 0,
    }),
    createBuffer: (channels, length, sampleRate) => ({
      numberOfChannels: channels,
      length,
      sampleRate,
      duration: length / sampleRate,
      _data: Array.from({ length: channels }, () => new Float32Array(length)),
      copyToChannel(data, ch) { this._data[ch].set(data); },
    }),
    createBufferSource: () => mockNode({
      buffer: null, start: jest.fn(), stop: jest.fn(), onended: null,
    }),
    resume: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
  };
}

describe('PlaybackMixer (Layer 3) — Live-Mix control surface', () => {
  let mixer;
  const stems = () => [new Float32Array(48000)];

  beforeEach(() => {
    mixer = new PlaybackMixer({ context: mockContext() });
  });

  test('defaults: clean stem at unity, noise stem muted', () => {
    expect(mixer.cleanGain.gain.value).toBe(1);
    expect(mixer.noiseGain.gain.value).toBe(0);
  });

  test('while playing, setNoiseReduction(75) smoothly drives NoiseGain toward 0.25', async () => {
    mixer.loadStems(stems(), stems());
    await mixer.play();
    mixer.setNoiseReduction(75);
    const call = mixer.noiseGain.gain.setTargetAtTime.mock.calls.at(-1);
    expect(call[0]).toBeCloseTo(0.25);
  });

  test('while idle, controls snap exactly (no smoothing toward a frozen clock)', () => {
    mixer.setNoiseReduction(75);
    expect(mixer.noiseGain.gain.setTargetAtTime).not.toHaveBeenCalled();
    expect(mixer.noiseGain.gain.cancelScheduledValues).toHaveBeenCalled();
    expect(mixer.noiseGain.gain.value).toBeCloseTo(0.25);
  });

  test('control inputs are clamped on both paths', async () => {
    mixer.setNoiseReduction(250);
    expect(mixer.noiseGain.gain.value).toBe(0);
    mixer.setVolume(-50);
    expect(mixer.masterGain.gain.value).toBe(0);
    mixer.setLowShelf(99);
    expect(mixer.lowShelf.gain.value).toBe(24);

    mixer.loadStems(stems(), stems());
    await mixer.play();
    mixer.setVoiceLevel(900);
    expect(mixer.cleanGain.gain.setTargetAtTime.mock.calls.at(-1)[0]).toBe(2);
  });

  test('Tier-A console defaults are transparent (unity / filters off)', () => {
    expect(mixer.eqLowMid.gain.value).toBe(0);
    expect(mixer.eqMid.gain.value).toBe(0);
    expect(mixer.eqHighMid.gain.value).toBe(0);
    expect(mixer.highpass.frequency.value).toBe(20);
    expect(mixer.lowpass.frequency.value).toBe(20000);
    expect(mixer.compressor.ratio.value).toBe(1);
    expect(mixer.compressor.threshold.value).toBe(0);
    expect(mixer.makeupGain.gain.value).toBe(1);
    expect(mixer.widthGain.gain.value).toBe(1); // stereo width 100% = transparent
  });

  test('Tier-A setters clamp inputs and convert units (idle snap)', () => {
    mixer.setEqMid(99);
    expect(mixer.eqMid.gain.value).toBe(24);
    mixer.setEqLowMid(-99);
    expect(mixer.eqLowMid.gain.value).toBe(-24);
    mixer.setHighpass(5);                 // below min → 20
    expect(mixer.highpass.frequency.value).toBe(20);
    mixer.setLowpass(99999);              // above max → 20000
    expect(mixer.lowpass.frequency.value).toBe(20000);
    mixer.setCompThreshold(-80);          // → -60
    expect(mixer.compressor.threshold.value).toBe(-60);
    mixer.setCompRatio(50);               // → 20
    expect(mixer.compressor.ratio.value).toBe(20);
    mixer.setCompAttack(200);             // 200 ms → 0.2 s
    expect(mixer.compressor.attack.value).toBeCloseTo(0.2);
    mixer.setCompRelease(1000);           // 1000 ms → 1 s
    expect(mixer.compressor.release.value).toBeCloseTo(1);
    mixer.setCompKnee(99);                // → 40
    expect(mixer.compressor.knee.value).toBe(40);
    mixer.setMakeupGain(6);               // +6 dB → linear ~1.995
    expect(mixer.makeupGain.gain.value).toBeCloseTo(Math.pow(10, 6 / 20));
    mixer.setStereoWidth(0);              // mono
    expect(mixer.widthGain.gain.value).toBe(0);
    mixer.setStereoWidth(500);            // clamps to 200 → 2×
    expect(mixer.widthGain.gain.value).toBe(2);
  });

  test('noise gate: bypassed by default; setters clamp and store params', () => {
    // The mock context has no AudioWorklet, so the gate stays bypassed (null)
    // and gateInput passes through — playback is unaffected.
    expect(mixer.gate).toBe(null);
    expect(mixer.gateInput).toBeDefined();
    expect(mixer._gateParams.range).toBe(0); // 0 dB range = transparent default
    mixer.setGateThreshold(-200);            // clamps to -100
    expect(mixer._gateParams.threshold).toBe(-100);
    mixer.setGateRange(999);                 // clamps to 80
    expect(mixer._gateParams.range).toBe(80);
    mixer.setGateAttack(999);                // clamps to 200
    expect(mixer._gateParams.attack).toBe(200);
    mixer.setGateRelease(-5);                // clamps to 0
    expect(mixer._gateParams.release).toBe(0);
  });

  test('de-esser: transparent by default; setters clamp', () => {
    expect(mixer.deEssAmount.gain.value).toBe(0);     // amount 0 = bypass
    expect(mixer.deEssHP.frequency.value).toBe(6000);
    mixer.setDeEsserAmount(150);                       // clamps to 100 → 1.0
    expect(mixer.deEssAmount.gain.value).toBe(1);
    mixer.setDeEsserAmount(-10);                       // clamps to 0
    expect(mixer.deEssAmount.gain.value).toBe(0);
    mixer.setDeEsserFreq(500);                          // clamps to 2000
    expect(mixer.deEssHP.frequency.value).toBe(2000);
    mixer.setDeEsserFreq(99999);                        // clamps to 12000
    expect(mixer.deEssHP.frequency.value).toBe(12000);
  });

  test('loadStems builds sample-locked buffers; transport round-trips', async () => {
    mixer.loadStems(stems(), stems());
    expect(mixer.duration()).toBeCloseTo(1);
    await mixer.play();
    expect(mixer.isPlaying()).toBe(true);
    mixer.pause();
    expect(mixer.isPlaying()).toBe(false);
    await mixer.seek(0.5);
    expect(mixer.currentTime()).toBeCloseTo(0.5);
    mixer.stop();
    expect(mixer.currentTime()).toBe(0);
  });

  test('play() without stems rejects loudly', async () => {
    await expect(mixer.play()).rejects.toThrow(/No stems loaded/);
  });

  // ── Stem mute lanes ────────────────────────────────────────────────────────

  test('voice/noise mute lanes default open and toggle without touching sliders', () => {
    expect(mixer.voiceMuteGain.gain.value).toBe(1);
    expect(mixer.noiseMuteGain.gain.value).toBe(1);
    expect(mixer.isVoiceMuted()).toBe(false);

    mixer.setVoiceLevel(80); // slider state that mute must preserve
    mixer.setVoiceMuted(true);
    expect(mixer.isVoiceMuted()).toBe(true);
    expect(mixer.voiceMuteGain.gain.value).toBe(0);
    expect(mixer.cleanGain.gain.value).toBeCloseTo(0.8); // untouched

    mixer.setVoiceMuted(false);
    expect(mixer.voiceMuteGain.gain.value).toBe(1);
    expect(mixer.cleanGain.gain.value).toBeCloseTo(0.8);
  });

  test('while playing, mute toggles smooth via setTargetAtTime', async () => {
    mixer.loadStems(stems(), stems());
    await mixer.play();
    mixer.setNoiseMuted(true);
    expect(mixer.isNoiseMuted()).toBe(true);
    expect(mixer.noiseMuteGain.gain.setTargetAtTime.mock.calls.at(-1)[0]).toBe(0);
  });

  // ── Per-speaker lane ───────────────────────────────────────────────────────

  const SEGMENTS = [
    { speakerId: 'S1', label: 'Speaker S1', start: 0.2, end: 0.5, confidence: 0.9 },
    { speakerId: 'S2', label: 'Speaker S2', start: 0.6, end: 0.9, confidence: 0.9 },
  ];

  test('loadSpeakerSegments registers speakers with default state', () => {
    mixer.loadSpeakerSegments(SEGMENTS);
    expect(mixer.speakerIds()).toEqual(['S1', 'S2']);
    // volume reads back as the 0–100 percentage setSpeakerVolume accepts.
    expect(mixer.getSpeakerState('S1')).toEqual({ volume: 100, muted: false, solo: false });
    expect(mixer.getSpeakerState('nope')).toBeNull();
    expect(mixer.getSpeakerSegments()).toHaveLength(2);
  });

  test('malformed segments are dropped, valid ones sorted by start', () => {
    mixer.loadSpeakerSegments([
      { speakerId: 'S2', start: 0.6, end: 0.9 },
      { speakerId: 'S1', start: 0.2, end: 0.5 },
      { speakerId: 'bad', start: 0.5, end: 0.5 },   // zero-length
      { speakerId: 42, start: 0, end: 1 },          // non-string id
      null,
    ]);
    expect(mixer.getSpeakerSegments().map((s) => s.speakerId)).toEqual(['S1', 'S2']);
  });

  test('muting a speaker while playing schedules a zero-gain ramp over its segments', async () => {
    mixer.loadStems(stems(), stems());
    mixer.loadSpeakerSegments(SEGMENTS);
    await mixer.play();

    mixer.setSpeakerMuted('S1', true);
    const calls = mixer.speakerGain.gain.setTargetAtTime.mock.calls;
    // _startedAt = (currentTime + 0.01) − offset 0 → segment times shift by 0.01.
    const mutedRamp = calls.find(([v, t]) => v === 0 && Math.abs(t - 0.21) < 1e-6);
    const restore = calls.find(([v, t]) => v === 1 && Math.abs(t - 0.51) < 1e-6);
    expect(mutedRamp).toBeDefined();
    expect(restore).toBeDefined();
    expect(mixer.speakerGain.gain.cancelScheduledValues).toHaveBeenCalled();
    expect(mixer.getSpeakerState('S1').muted).toBe(true);
  });

  test('solo silences every other speaker; clearing solo restores them', async () => {
    mixer.loadStems(stems(), stems());
    mixer.loadSpeakerSegments(SEGMENTS);
    await mixer.play();

    mixer.setSpeakerSolo('S2');
    expect(mixer.getSoloSpeaker()).toBe('S2');
    expect(mixer.getSpeakerState('S1').solo).toBe(false);
    expect(mixer.getSpeakerState('S2').solo).toBe(true);
    let calls = mixer.speakerGain.gain.setTargetAtTime.mock.calls;
    // S1's segment (0.2–0.5 → 0.21) must ramp to 0, S2's (0.6 → 0.61) stays 1.
    expect(calls.some(([v, t]) => v === 0 && Math.abs(t - 0.21) < 1e-6)).toBe(true);
    expect(calls.some(([v, t]) => v === 1 && Math.abs(t - 0.61) < 1e-6)).toBe(true);

    mixer.speakerGain.gain.setTargetAtTime.mockClear();
    mixer.setSpeakerSolo(null);
    expect(mixer.getSoloSpeaker()).toBeNull();
    calls = mixer.speakerGain.gain.setTargetAtTime.mock.calls;
    expect(calls.some(([v, t]) => v === 1 && Math.abs(t - 0.21) < 1e-6)).toBe(true);
  });

  test('per-speaker volume scales its segments and is clamped', async () => {
    mixer.loadStems(stems(), stems());
    mixer.loadSpeakerSegments(SEGMENTS);
    await mixer.play();
    mixer.setSpeakerVolume('S1', 40);
    const calls = mixer.speakerGain.gain.setTargetAtTime.mock.calls;
    expect(calls.some(([v, t]) => Math.abs(v - 0.4) < 1e-9 && Math.abs(t - 0.21) < 1e-6)).toBe(true);
    // Round-trip: the getter returns the same scale the setter accepts.
    expect(mixer.getSpeakerState('S1').volume).toBe(40);
    // Clamp ceiling is now 200 (per-speaker ENHANCE / boost).
    mixer.setSpeakerVolume('S1', 900);
    expect(mixer.getSpeakerState('S1').volume).toBe(200);
  });

  test('a speaker can be ENHANCED above unity to lift a faint/whisper voice', async () => {
    mixer.loadStems(stems(), stems());
    mixer.loadSpeakerSegments(SEGMENTS);
    await mixer.play();
    mixer.speakerGain.gain.setTargetAtTime.mockClear();
    mixer.setSpeakerVolume('S1', 175); // +~4.9 dB boost
    expect(mixer.getSpeakerState('S1').volume).toBe(175);
    const calls = mixer.speakerGain.gain.setTargetAtTime.mock.calls;
    // S1's segment (0.2–0.5 → ctx 0.21) ramps to the boosted gain 1.75.
    expect(calls.some(([v, t]) => Math.abs(v - 1.75) < 1e-9 && Math.abs(t - 0.21) < 1e-6)).toBe(true);
  });

  test('setSpeakerVolume 200 schedules gain 2.0 (maximum +6 dB ENHANCE)', async () => {
    mixer.loadStems(stems(), stems());
    mixer.loadSpeakerSegments(SEGMENTS);
    await mixer.play();
    mixer.speakerGain.gain.setTargetAtTime.mockClear();
    mixer.setSpeakerVolume('S1', 200);
    expect(mixer.getSpeakerState('S1').volume).toBe(200);
    const calls = mixer.speakerGain.gain.setTargetAtTime.mock.calls;
    expect(calls.some(([v]) => Math.abs(v - 2.0) < 1e-9)).toBe(true);
  });

  test('setSpeakerVolume 0 schedules gain 0.0 (silence via fader, floor clamp)', async () => {
    mixer.loadStems(stems(), stems());
    mixer.loadSpeakerSegments(SEGMENTS);
    await mixer.play();
    mixer.speakerGain.gain.setTargetAtTime.mockClear();
    mixer.setSpeakerVolume('S1', 0);
    expect(mixer.getSpeakerState('S1').volume).toBe(0);
    const calls = mixer.speakerGain.gain.setTargetAtTime.mock.calls;
    expect(calls.some(([v]) => Math.abs(v - 0.0) < 1e-9)).toBe(true);
  });

  test('negative volume is clamped to 0 (floor boundary)', () => {
    mixer.loadStems(stems(), stems());
    mixer.loadSpeakerSegments(SEGMENTS);
    mixer.setSpeakerVolume('S1', -50);
    expect(mixer.getSpeakerState('S1').volume).toBe(0);
  });

  test('volume 100 produces unity gain 1.0 (unchanged from pre-PR behaviour)', async () => {
    mixer.loadStems(stems(), stems());
    mixer.loadSpeakerSegments(SEGMENTS);
    await mixer.play();
    mixer.speakerGain.gain.setTargetAtTime.mockClear();
    mixer.setSpeakerVolume('S2', 100);
    expect(mixer.getSpeakerState('S2').volume).toBe(100);
    const calls = mixer.speakerGain.gain.setTargetAtTime.mock.calls;
    expect(calls.some(([v]) => Math.abs(v - 1.0) < 1e-9)).toBe(true);
  });

  test('setSpeakerVolume on an unknown speaker is a safe no-op', () => {
    mixer.loadStems(stems(), stems());
    mixer.loadSpeakerSegments(SEGMENTS);
    // 'S99' is not registered — must not throw.
    expect(() => mixer.setSpeakerVolume('S99', 150)).not.toThrow();
  });

  test('contiguous segments share one boundary ramp (no AudioParam collision)', async () => {
    mixer.loadStems(stems(), stems());
    mixer.loadSpeakerSegments([

      { speakerId: 'S2', start: 0.5, end: 0.9 }, // starts exactly at S1's end
    ]);
    await mixer.play();
    mixer.speakerGain.gain.setTargetAtTime.mockClear();

    mixer.setSpeakerMuted('S2', true);
    const calls = mixer.speakerGain.gain.setTargetAtTime.mock.calls;
    // S2's mute ramp owns the shared boundary (0.5 → ctx time 0.51)…
    expect(calls.some(([v, t]) => v === 0 && Math.abs(t - 0.51) < 1e-6)).toBe(true);
    // …with no competing restore-to-1 event at the same instant.
    expect(calls.some(([v, t]) => v === 1 && Math.abs(t - 0.51) < 1e-6)).toBe(false);
    // The restore lands only after the contiguous run ends.
    expect(calls.some(([v, t]) => v === 1 && Math.abs(t - 0.91) < 1e-6)).toBe(true);
  });

  test('loading new stems clears stale diarization state', () => {
    mixer.loadSpeakerSegments(SEGMENTS);
    expect(mixer.speakerIds()).toHaveLength(2);
    mixer.loadStems(stems(), stems());
    expect(mixer.speakerIds()).toEqual([]);
    expect(mixer.getSpeakerSegments()).toEqual([]);
  });

  test('idle speaker lane stays transparent (gain pinned to 1)', () => {
    mixer.loadSpeakerSegments(SEGMENTS);
    mixer.setSpeakerMuted('S1', true);
    // Not playing → no smoothing toward a frozen clock, just a clean value.
    expect(mixer.speakerGain.gain.value).toBe(1);
    expect(mixer.speakerGain.gain.setTargetAtTime).not.toHaveBeenCalled();
  });
});
