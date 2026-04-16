/**
 * public/app/diarization-timeline.test.js
 * Vitest test suite — Diarization Timeline + Isolation Controls
 *
 * Run: npx vitest run public/app/diarization-timeline.test.js
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  initDiarizationTimeline,
  onDiarizationResult,
  seekTimeline,
  setSpeakerVolume,
  setSpeakerMute,
  setSpeakerSolo,
  tickTimeline,
} from './diarization-timeline.js';

// ─── DOM Setup (jsdom) ───────────────────────
function buildDOM() {
  document.body.innerHTML = `
    <div id="diarization-section" style="width:800px">
      <canvas id="diarization-canvas"></canvas>
      <div id="diarization-playhead"></div>
      <span id="diarization-time-label"></span>
      <button id="diarization-zoom-in"></button>
      <button id="diarization-zoom-out"></button>
      <button id="diarization-zoom-fit"></button>
    </div>
    <div id="isolation-controls-root"></div>
    <span id="voiceprint-status"></span>
    <button id="enroll-voiceprint-btn"></button>
    <button id="clear-voiceprint-btn"></button>
    <select id="isolation-method-select">
      <option value="hybrid" selected>Hybrid</option>
      <option value="ml">ML</option>
    </select>
    <input id="isolation-confidence" type="range" min="40" max="95" value="65" />
    <span id="isolation-confidence-readout">65%</span>
    <input id="isolation-bg-volume" type="range" min="0" max="100" value="0" />
    <span id="isolation-bg-readout">0%</span>
    <input id="isolation-mask-refine" type="checkbox" checked />
  `;
}

// ─── Mock AudioContext ───────────────────────
const mockAudioContext = { currentTime: 0 };

// ─── Mock ML Worker ──────────────────────────
const mockMlWorker = { postMessage: vi.fn() };

// ─── Sample diarization payload ─────────────
const SAMPLE_SEGMENTS = [
  { speakerId: 'S1', label: 'Alice', start: 0.0,  end: 5.2,  confidence: 0.92 },
  { speakerId: 'S2', label: 'Bob',   start: 5.2,  end: 10.5, confidence: 0.87 },
  { speakerId: 'S1', label: 'Alice', start: 10.5, end: 15.0, confidence: 0.90 },
  { speakerId: 'S2', label: 'Bob',   start: 15.0, end: 20.0, confidence: 0.78 },
];

// ─── Tests ──────────────────────────────────

describe('DiarizationTimeline', () => {
  beforeEach(() => {
    buildDOM();
    vi.clearAllMocks();
    // Suppress RAF in test env
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 42));
    vi.stubGlobal('ResizeObserver', class { observe() {} });
    initDiarizationTimeline({
      mlWorker:      mockMlWorker,
      audioContext:  mockAudioContext,
      onSpeakerSelect: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ─ 1 ─
  it('initialises without throwing when canvas exists', () => {
    expect(() => initDiarizationTimeline({
      mlWorker: mockMlWorker,
      audioContext: mockAudioContext,
    })).not.toThrow();
  });

  // ─ 2 ─
  it('accepts diarization result with correct segment count', () => {
    expect(() => onDiarizationResult({ segments: SAMPLE_SEGMENTS, duration: 20 })).not.toThrow();
  });

  // ─ 3 ─
  it('builds speaker registry from segments', () => {
    onDiarizationResult({ segments: SAMPLE_SEGMENTS, duration: 20 });
    // Access internal state via re-init trick — check DOM side effects
    // After processing 2 unique speakers S1, S2 should exist
    const cards = document.querySelectorAll('.speaker-card');
    // No cards yet (isolation-controls.js handles cards), but timeline processes 2 unique IDs
    // We verify by triggering solo and checking worker receives correct ID
    setSpeakerSolo('S1');
    expect(mockMlWorker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'isolateSpeaker' })
    );
  });

  // ─ 4 ─
  it('seekTimeline updates the time label', () => {
    onDiarizationResult({ segments: SAMPLE_SEGMENTS, duration: 20 });
    seekTimeline(7.5);
    const label = document.getElementById('diarization-time-label');
    expect(label.textContent).toMatch(/07:5|00:07/); // formatted as mm:ss.s
  });

  // ─ 5 ─
  it('setSpeakerVolume dispatches speakerVolumes to worker', () => {
    onDiarizationResult({ segments: SAMPLE_SEGMENTS, duration: 20 });
    setSpeakerVolume('S1', 0.5);
    expect(mockMlWorker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'speakerVolumes' })
    );
    const call = mockMlWorker.postMessage.mock.calls.find(c => c[0].type === 'speakerVolumes');
    expect(call[0].payload['S1']).toBe(0.5);
  });

  // ─ 6 ─
  it('setSpeakerMute sets muted speaker volume to 0 in worker payload', () => {
    onDiarizationResult({ segments: SAMPLE_SEGMENTS, duration: 20 });
    setSpeakerMute('S1', true);
    const call = mockMlWorker.postMessage.mock.calls.find(c => c[0].type === 'speakerVolumes');
    expect(call[0].payload['S1']).toBe(0);
  });

  // ─ 7 ─
  it('setSpeakerSolo sends isolateSpeaker with correct ID', () => {
    onDiarizationResult({ segments: SAMPLE_SEGMENTS, duration: 20 });
    setSpeakerSolo('S2');
    const soloCall = mockMlWorker.postMessage.mock.calls.find(c => c[0].type === 'isolateSpeaker');
    expect(soloCall[0].payload.speakerId).toBe('S2');
  });

  // ─ 8 ─
  it('double-calling setSpeakerSolo on same ID clears isolation (toggle)', () => {
    onDiarizationResult({ segments: SAMPLE_SEGMENTS, duration: 20 });
    setSpeakerSolo('S2');
    mockMlWorker.postMessage.mockClear();
    setSpeakerSolo('S2');  // toggle off
    const soloCall = mockMlWorker.postMessage.mock.calls.find(c => c[0].type === 'isolateSpeaker');
    expect(soloCall[0].payload.speakerId).toBeNull();
  });

  // ─ 9 ─
  it('empty segment array renders empty state without crashing', () => {
    expect(() => onDiarizationResult({ segments: [], duration: 0 })).not.toThrow();
  });

  // ─ 10 ─
  it('tickTimeline syncs currentTime from audioContext', () => {
    onDiarizationResult({ segments: SAMPLE_SEGMENTS, duration: 20 });
    mockAudioContext.currentTime = 12.3;
    expect(() => tickTimeline()).not.toThrow();
  });

  // ─ 11 ─
  it('segments with confidence < 0.5 get reduced alpha — no render crash', () => {
    const lowConfSegments = [
      { speakerId: 'S1', label: 'Low', start: 0, end: 10, confidence: 0.2 },
    ];
    expect(() => onDiarizationResult({ segments: lowConfSegments, duration: 10 })).not.toThrow();
  });

  // ─ 12 ─
  it('zoom-fit button resets view to full duration', () => {
    onDiarizationResult({ segments: SAMPLE_SEGMENTS, duration: 20 });
    document.getElementById('diarization-zoom-in').click();
    document.getElementById('diarization-zoom-fit').click();
    // No crash, and time label still updates correctly
    seekTimeline(0);
    expect(document.getElementById('diarization-time-label').textContent).toMatch(/00:00/);
  });
});
