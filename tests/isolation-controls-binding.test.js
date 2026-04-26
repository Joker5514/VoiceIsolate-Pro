/**
 * VoiceIsolate Pro — Speaker Isolation card UI binding tests.
 *
 * @jest-environment jsdom
 *
 * Covers the regression where the Confidence / Bg Level / Mask Refine
 * controls did nothing because their listeners were only attached inside
 * _doInit() (gated on AudioContext + ML worker init). The fix binds them
 * eagerly on DOMContentLoaded so user input flows into _isolationParams
 * regardless of orchestrator init state.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const ISOLATION_HTML = `
  <div id="isolationCard">
    <select id="isolationMethodSelect">
      <option value="hybrid" selected>Hybrid</option>
      <option value="ml">ML</option>
      <option value="classical">Classical</option>
    </select>
    <input type="range" id="isolationConfidenceSlider" min="40" max="95" value="65" step="1" />
    <span id="isolationConfidenceReadout">65%</span>
    <input type="range" id="isolationBgVolumeSlider" min="0" max="100" value="0" step="1" />
    <span id="isolationBgReadout">0%</span>
    <input type="checkbox" id="isolationMaskRefine" checked />
    <button id="enrollVoiceprintBtn"></button>
    <button id="clearVoiceprintBtn"></button>
    <span id="voiceprintStatus">Not enrolled</span>
  </div>
`;

class MockWorker {
  constructor() {
    this._messages = [];
    this.onmessage = null;
    this.onerror   = null;
  }
  postMessage(msg) { this._messages.push(msg); }
  terminate()      {}
}

class MockAudioContext {
  constructor() {
    this.state       = 'suspended';
    this.destination = {};
    this.audioWorklet = { addModule: () => Promise.resolve() };
  }
  resume()  { this.state = 'running'; return Promise.resolve(); }
  suspend() { this.state = 'suspended'; return Promise.resolve(); }
  close()   { this.state = 'closed'; return Promise.resolve(); }
}

function loadOrchestrator() {
  // Reset DOM and globals for each test
  document.body.innerHTML = ISOLATION_HTML;
  window.AudioContext       = MockAudioContext;
  window.webkitAudioContext = MockAudioContext;
  window.AudioWorkletNode   = class { constructor() { this.port = { postMessage: () => {} }; } connect(){} disconnect(){} };
  window.Worker             = MockWorker;
  window.SharedArrayBuffer  = SharedArrayBuffer;

  // Suppress the bootstrap polling timer
  const realSetInterval = window.setInterval;
  window.setInterval = () => 0;

  const src = fs.readFileSync(
    path.join(__dirname, '../public/app/pipeline-orchestrator.js'),
    'utf8',
  );
  // Append: expose the class to test scope via window
  const harnessSrc = src + '\n;window.PipelineOrchestrator = PipelineOrchestrator;';
  // eslint-disable-next-line no-new-func
  new window.Function(harnessSrc).call(window);
  window.setInterval = realSetInterval;

  return window.PipelineOrchestrator;
}

describe('Speaker Isolation card — eager UI binding', () => {
  let PipelineOrchestrator;

  beforeEach(() => {
    PipelineOrchestrator = loadOrchestrator();
  });

  test('Confidence slider updates _isolationParams.ecapaSimilarityThreshold on input', () => {
    const orch = new PipelineOrchestrator();
    orch._bindIsolationControls();

    const slider = document.getElementById('isolationConfidenceSlider');
    slider.value = '80';
    slider.dispatchEvent(new window.Event('input', { bubbles: true }));

    expect(orch._isolationParams.ecapaSimilarityThreshold).toBeCloseTo(0.8, 5);
    expect(document.getElementById('isolationConfidenceReadout').textContent).toBe('80%');
  });

  test('Bg Level slider updates _isolationParams.backgroundVolume on input', () => {
    const orch = new PipelineOrchestrator();
    orch._bindIsolationControls();

    const slider = document.getElementById('isolationBgVolumeSlider');
    slider.value = '40';
    slider.dispatchEvent(new window.Event('input', { bubbles: true }));

    expect(orch._isolationParams.backgroundVolume).toBeCloseTo(0.4, 5);
    expect(document.getElementById('isolationBgReadout').textContent).toBe('40%');
  });

  test('Mask Refine checkbox toggles _isolationParams.maskRefinement', () => {
    const orch = new PipelineOrchestrator();
    orch._bindIsolationControls();

    const checkbox = document.getElementById('isolationMaskRefine');
    checkbox.checked = false;
    checkbox.dispatchEvent(new window.Event('change', { bubbles: true }));

    expect(orch._isolationParams.maskRefinement).toBe(false);
  });

  test('Method dropdown updates _isolationParams.isolationMethod', () => {
    const orch = new PipelineOrchestrator();
    orch._bindIsolationControls();

    const sel = document.getElementById('isolationMethodSelect');
    sel.value = 'classical';
    sel.dispatchEvent(new window.Event('change', { bubbles: true }));

    expect(orch._isolationParams.isolationMethod).toBe('classical');
  });

  test('binding before mlWorker exists still updates params (so values are not lost)', () => {
    const orch = new PipelineOrchestrator();
    expect(orch.mlWorker).toBeNull();
    orch._bindIsolationControls();

    const slider = document.getElementById('isolationBgVolumeSlider');
    slider.value = '70';
    slider.dispatchEvent(new window.Event('input', { bubbles: true }));

    expect(orch._isolationParams.backgroundVolume).toBeCloseTo(0.7, 5);
  });

  test('once mlWorker is set, slider input posts setIsolationConfig to it', () => {
    const orch = new PipelineOrchestrator();
    orch._bindIsolationControls();
    orch.mlWorker = new MockWorker();

    const slider = document.getElementById('isolationConfidenceSlider');
    slider.value = '50';
    slider.dispatchEvent(new window.Event('input', { bubbles: true }));

    const cfgMsgs = orch.mlWorker._messages.filter((m) => m.type === 'setIsolationConfig');
    expect(cfgMsgs.length).toBeGreaterThan(0);
    expect(cfgMsgs.at(-1).payload.ecapaSimilarityThreshold).toBeCloseTo(0.5, 5);
  });
});
