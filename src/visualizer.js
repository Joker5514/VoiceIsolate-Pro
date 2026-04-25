// src/visualizer.js — Three.js 3D Spectrogram v2
// Axes: X = Time (rolling history), Z = Frequency, Y = Amplitude
// Color: cosine similarity score from ECAPA-TDNN drives peak color semantics
//
// v2 additions:
//   • Dual mode: 2D scrolling waterfall + 3D point cloud (V key / button)
//   • Mel-scale frequency axis with labeled markers (M key / button)
//   • Per-speaker color lanes when fingerprinting is active
//   • Zoom & pan: scroll wheel, click+drag, pinch, double-click reset
//   • Freeze frame (F key / button) — pauses rendering, audio continues
//   • Snapshot export as PNG with timestamp filename
//   • 60fps target: delta-time capping, pre-allocated typed arrays

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// ── Constants ──────────────────────────────────────────────────────────────────
const FFT_BINS  = 512;
const MEL_BINS  = 128;   // Mel-spaced bins remapped from FFT
const TIME_COLS = 128;   // ~1.4s rolling history at 48kHz/hop-512 @ every 4 blocks
const TOTAL_PTS = FFT_BINS * TIME_COLS;
const SAMPLE_RATE = 48000;
const NYQUIST     = SAMPLE_RATE / 2;
const MEL_MIN_HZ  = 80;
const MEL_MAX_HZ  = 20000;

// ── Per-speaker color palette (hue degrees) ────────────────────────────────────
const SPEAKER_COLORS = {
  speaker_1: { hue: 185, label: 'Speaker 1' },  // cyan
  speaker_2: { hue: 280, label: 'Speaker 2' },  // violet
  speaker_3: { hue: 45,  label: 'Speaker 3' },  // amber
  speaker_4: { hue: 120, label: 'Speaker 4' },  // green
};

// ── Mel-scale helpers ──────────────────────────────────────────────────────────
const hzToMel = hz => 2595 * Math.log10(1 + hz / 700);
const melToHz = mel => 700 * (Math.pow(10, mel / 2595) - 1);

/** Pre-computed lookup: melBinToFftBin[i] = nearest FFT bin index for mel bin i */
const melBinToFftBin = new Int16Array(MEL_BINS);
(function buildMelLookup() {
  const melMin = hzToMel(MEL_MIN_HZ);
  const melMax = hzToMel(MEL_MAX_HZ);
  for (let i = 0; i < MEL_BINS; i++) {
    const mel = melMin + (melMax - melMin) * (i / (MEL_BINS - 1));
    const hz  = melToHz(mel);
    melBinToFftBin[i] = Math.round((hz / NYQUIST) * (FFT_BINS - 1));
  }
}());

/** Y-axis labels in mel mode (frequency in Hz) */
const MEL_LABEL_HZ = [100, 500, 1000, 2000, 4000, 8000, 16000];

// ── Module-level state ─────────────────────────────────────────────────────────
let scene, camera, renderer, controls, mesh, geometry;

// Pre-allocated typed arrays (zero allocation in hot path)
const positions    = new Float32Array(TOTAL_PTS * 3);
const colors       = new Float32Array(TOTAL_PTS * 3);
const melMagnitude = new Float32Array(MEL_BINS);    // remapped per frame

let timeIndex      = 0;
let lastSimilarity = 0.5;
let activeSpeaker  = null;   // e.g. 'speaker_1' | null

// ── Mode flags ─────────────────────────────────────────────────────────────────
let mode2D       = false;   // false = 3D, true = 2D waterfall
let melMode      = false;   // false = linear freq axis, true = mel-scale
let frozen       = false;   // freeze frame

// ── 2D canvas state ────────────────────────────────────────────────────────────
let canvas2D      = null;   // overlay canvas for 2D mode
let ctx2D         = null;
let canvas3D      = null;   // WebGL canvas (hidden in 2D mode)

// ── Zoom / pan state ───────────────────────────────────────────────────────────
let zoomWindowSec = 10;          // visible time window in seconds (range 1–60)
const HOP_SEC     = 512 / 48000; // seconds per FFT frame
let panOffsetCols = 0;            // pan offset in columns (0 = latest)

// ── Overlay element references ─────────────────────────────────────────────────
let elFrozenBadge     = null;
let elZoomBadge       = null;
let elSpeakerLegend   = null;
let elModeBtn         = null;
let elMelBtn          = null;
let elFreezeBtn       = null;
let elSnapshotBtn     = null;

// ── Animation ─────────────────────────────────────────────────────────────────
let lastFrameTime = 0;

// ── HSL → RGB helper (pre-allocated, no object creation in hot path) ──────────
const _rgb = new Float32Array(3);
function hslToRgb(h, s, l) {
  h /= 360; s /= 100; l /= 100;
  if (s === 0) { _rgb[0] = _rgb[1] = _rgb[2] = l; return _rgb; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1/6) return p + (q - p) * 6 * t;
    if (t < 1/2) return q;
    if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
    return p;
  };
  _rgb[0] = hue2rgb(p, q, h + 1/3);
  _rgb[1] = hue2rgb(p, q, h);
  _rgb[2] = hue2rgb(p, q, h - 1/3);
  return _rgb;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Initialise the visualiser.
 * @param {HTMLCanvasElement} canvas  - WebGL canvas (3D mode)
 * @param {object}            opts
 * @param {HTMLElement}       [opts.container]       - wrapper element for overlay creation
 * @param {HTMLButtonElement} [opts.modeBtn]         - 2D/3D toggle button
 * @param {HTMLButtonElement} [opts.melBtn]          - Mel/Linear toggle button
 * @param {HTMLButtonElement} [opts.freezeBtn]       - Freeze button
 * @param {HTMLButtonElement} [opts.snapshotBtn]     - Snapshot button
 * @param {HTMLElement}       [opts.frozenBadge]     - "FROZEN" badge element
 * @param {HTMLElement}       [opts.zoomBadge]       - zoom-level badge element
 * @param {HTMLElement}       [opts.speakerLegend]   - speaker legend container
 */
export function initVisualizer(canvas, opts = {}) {
  canvas3D = canvas;

  // ── Wire overlay element references ──────────────────────────────────────
  elFrozenBadge   = opts.frozenBadge   || document.getElementById('spectroFrozenBadge');
  elZoomBadge     = opts.zoomBadge     || document.getElementById('spectroZoomBadge');
  elSpeakerLegend = opts.speakerLegend || document.getElementById('spectroSpeakerLegend');
  elModeBtn       = opts.modeBtn       || document.getElementById('spectroModeBtn');
  elMelBtn        = opts.melBtn        || document.getElementById('spectroMelBtn');
  elFreezeBtn     = opts.freezeBtn     || document.getElementById('spectroFreezeBtn');
  elSnapshotBtn   = opts.snapshotBtn   || document.getElementById('spectroSnapshotBtn');

  // ── Create 2D overlay canvas (sibling of WebGL canvas) ───────────────────
  const container = opts.container || canvas.parentElement;
  canvas2D = document.createElement('canvas');
  canvas2D.style.cssText = [
    'position:absolute', 'inset:0', 'width:100%', 'height:100%',
    'display:none', 'image-rendering:pixelated',
  ].join(';');
  canvas2D.setAttribute('aria-label', '2D spectrogram waterfall');
  canvas2D.setAttribute('role', 'img');
  container.appendChild(canvas2D);
  ctx2D = canvas2D.getContext('2d');

  // ── Three.js renderer ────────────────────────────────────────────────────
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(canvas.clientWidth || window.innerWidth,
                   canvas.clientHeight || window.innerHeight);

  scene  = new THREE.Scene();
  scene.background = new THREE.Color(0x040410);
  scene.fog        = new THREE.FogExp2(0x040410, 0.008);

  camera = new THREE.PerspectiveCamera(
    60,
    (canvas.clientWidth || window.innerWidth) / (canvas.clientHeight || window.innerHeight),
    0.1, 500
  );
  camera.position.set(40, 50, 100);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping   = true;
  controls.dampingFactor   = 0.07;
  controls.autoRotate      = true;
  controls.autoRotateSpeed = 0.4;
  controls.minDistance     = 20;
  controls.maxDistance     = 300;

  // ── Point cloud geometry ──────────────────────────────────────────────────
  geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color',    new THREE.BufferAttribute(colors, 3));

  for (let t = 0; t < TIME_COLS; t++) {
    for (let k = 0; k < FFT_BINS; k++) {
      const idx = (t * FFT_BINS + k) * 3;
      positions[idx]     = t * 1.5;
      positions[idx + 1] = 0;
      positions[idx + 2] = k * 0.25;
      colors[idx]     = 0.1;
      colors[idx + 1] = 0.3;
      colors[idx + 2] = 0.5;
    }
  }

  const mat = new THREE.PointsMaterial({
    size: 0.35,
    vertexColors: true,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.88,
  });
  mesh = new THREE.Points(geometry, mat);
  scene.add(mesh);

  scene.add(new THREE.AxesHelper(60));
  const grid = new THREE.GridHelper(200, 40, 0x112233, 0x0a1520);
  scene.add(grid);

  scene.add(new THREE.AmbientLight(0x112244, 1.5));
  const dirLight = new THREE.DirectionalLight(0x4488ff, 2);
  dirLight.position.set(50, 100, 50);
  scene.add(dirLight);

  // ── Zoom / pan event listeners (on WebGL canvas) ──────────────────────────
  _bindZoomPan(canvas);

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  window.addEventListener('keydown', _onKey);

  // ── Button event listeners ────────────────────────────────────────────────
  if (elModeBtn)     elModeBtn.addEventListener('click',     toggleMode);
  if (elMelBtn)      elMelBtn.addEventListener('click',      toggleMelScale);
  if (elFreezeBtn)   elFreezeBtn.addEventListener('click',   toggleFreeze);
  if (elSnapshotBtn) elSnapshotBtn.addEventListener('click', snapshot);

  // ── Resize handler ────────────────────────────────────────────────────────
  window.addEventListener('resize', _onResize);
  _onResize();

  // ── Initial badge state ───────────────────────────────────────────────────
  _updateZoomBadge();

  animate(0);
}

/**
 * Called every ~10ms from main.js with:
 * @param {Float32Array|null} magnitude   - 512 FFT bins (null = similarity-only update)
 * @param {number}            similarity  - ECAPA-TDNN cosine similarity score 0..1
 * @param {string|null}       speakerId   - e.g. 'speaker_1' | null (fingerprinting result)
 *
 * Color semantics (cosine similarity S):
 *   S > 0.7  → bright cyan  (target voice confirmed)
 *   S < 0.4  → muted red    (background noise / different speaker)
 *   0.4–0.7  → neutral grey (ambiguous)
 */
export function updateVisualizer(magnitude, similarity = lastSimilarity, speakerId = null) {
  lastSimilarity = similarity;
  if (speakerId !== null) {
    activeSpeaker = speakerId;
    _updateSpeakerLegend(speakerId);
  }
  if (!magnitude || !geometry) return;
  if (frozen) return;   // freeze frame: skip data updates, keep rendering

  const col    = timeIndex % TIME_COLS;

  // Remap to mel bins if needed (in-place into pre-allocated melMagnitude)
  if (melMode) {
    for (let i = 0; i < MEL_BINS; i++) {
      melMagnitude[i] = magnitude[melBinToFftBin[i]];
    }
  }

  // 3D point cloud uses full FFT_BINS for Z-axis resolution;
  // amplitude is sampled from the mel or linear bins.
  for (let k = 0; k < FFT_BINS; k++) {
    const idx = (col * FFT_BINS + k) * 3;

    // When melMode, resample the 128 mel bins back across 512 Z positions
    const srcK = melMode ? Math.round(k * (MEL_BINS - 1) / (FFT_BINS - 1)) : k;
    const amp  = Math.min((melMode ? melMagnitude[srcK] : magnitude[k]) * 80, 60);

    positions[idx]     = col * 1.5;
    positions[idx + 1] = amp;
    positions[idx + 2] = k * 0.25;

    _colorBin(idx, amp, similarity, k, FFT_BINS);
  }

  // ── 2D waterfall row ─────────────────────────────────────────────────────
  if (mode2D && ctx2D) {
    _draw2DRow(col, melMode ? melMagnitude : magnitude,
               melMode ? MEL_BINS : FFT_BINS, similarity);
  }

  geometry.attributes.position.needsUpdate = true;
  geometry.attributes.color.needsUpdate    = true;
  timeIndex++;
}

// ── Public toggle helpers (also called by keyboard shortcuts) ──────────────────

/** Toggle 2D/3D mode with a 500ms CSS morph. */
export function toggleMode() {
  mode2D = !mode2D;
  if (mode2D) {
    canvas2D.style.display = 'block';
    canvas3D.style.opacity = '0';
    canvas3D.style.transition = 'opacity 0.5s';
    setTimeout(() => { canvas3D.style.display = 'none'; }, 500);
    _resize2D();
  } else {
    canvas3D.style.display = 'block';
    canvas3D.style.opacity = '0';
    canvas3D.style.transition = 'opacity 0.5s';
    canvas2D.style.display = 'none';
    requestAnimationFrame(() => { canvas3D.style.opacity = '1'; });
  }
  if (elModeBtn) elModeBtn.textContent = mode2D ? '3D View' : '2D View';
}

/** Toggle linear ↔ mel frequency scale. */
export function toggleMelScale() {
  melMode = !melMode;
  if (elMelBtn) elMelBtn.textContent = melMode ? 'Linear Scale' : 'Mel Scale';
  // Clear 2D canvas so axis redraws correctly
  if (ctx2D && mode2D) ctx2D.clearRect(0, 0, canvas2D.width, canvas2D.height);
}

/** Toggle freeze frame. */
export function toggleFreeze() {
  frozen = !frozen;
  if (elFrozenBadge) elFrozenBadge.style.display = frozen ? 'flex' : 'none';
  if (elFreezeBtn) {
    elFreezeBtn.textContent    = frozen ? '▶ Resume' : '❄ Freeze';
    elFreezeBtn.setAttribute('aria-pressed', frozen ? 'true' : 'false');
  }
}

/** Capture current canvas frame as PNG. */
export function snapshot() {
  const ts   = new Date().toISOString().replace(/[:.]/g, '-');
  const name = `voiceisolate-spectrogram-${ts}.png`;
  const src  = mode2D ? canvas2D : canvas3D;
  if (!src) return;
  // Force a render for the 3D canvas so preserveDrawingBuffer captures it
  if (!mode2D && renderer) renderer.render(scene, camera);
  const url  = src.toDataURL('image/png');
  const a    = document.createElement('a');
  a.href     = url;
  a.download = name;
  a.click();
}

/** Set active speaker from external fingerprinting module. */
export function setActiveSpeaker(speakerId) {
  activeSpeaker = speakerId;
  _updateSpeakerLegend(speakerId);
}

// ── Private helpers ────────────────────────────────────────────────────────────

/** Color a single bin at typed-array index `idx`. */
function _colorBin(idx, amp, similarity, binIndex, totalBins) {
  if (activeSpeaker && SPEAKER_COLORS[activeSpeaker]) {
    // Per-speaker hue; amplitude → lightness
    const { hue } = SPEAKER_COLORS[activeSpeaker];
    const lightness = 30 + 40 * (amp / 60);
    const rgb = hslToRgb(hue, 90, lightness);
    colors[idx]     = rgb[0];
    colors[idx + 1] = rgb[1];
    colors[idx + 2] = rgb[2];
  } else if (similarity > 0.7) {
    const brightness = 0.5 + 0.5 * (amp / 60);
    colors[idx]     = 0.0;
    colors[idx + 1] = 0.7 * brightness;
    colors[idx + 2] = 1.0 * brightness;
  } else if (similarity < 0.4) {
    const dim = 0.2 + 0.3 * (amp / 60);
    colors[idx]     = 0.5 * dim;
    colors[idx + 1] = 0.1 * dim;
    colors[idx + 2] = 0.1 * dim;
  } else {
    const g = 0.15 + 0.35 * (amp / 60);
    colors[idx]     = g;
    colors[idx + 1] = g;
    colors[idx + 2] = g + 0.1;
  }
}

/** Draw a single column into the 2D waterfall canvas. */
function _draw2DRow(col, bins, binCount, similarity) {
  const W = canvas2D.width;
  const H = canvas2D.height;
  if (W === 0 || H === 0) return;

  // Compute visible column count based on zoom window
  const visibleCols = Math.min(TIME_COLS, Math.round(zoomWindowSec / HOP_SEC));
  const colW = W / visibleCols;

  // Shift existing image left by one column width
  if (colW >= 1) {
    ctx2D.drawImage(canvas2D, -colW, 0);
  }

  // Draw new column on right edge
  const xStart = W - colW;
  for (let k = 0; k < binCount; k++) {
    const v   = Math.min((bins[k] ?? 0), 1.0);
    const yTop = H - (k + 1) / binCount * H;
    const yH   = H / binCount + 1;  // +1 to avoid hairline gaps

    let cssColor;
    if (activeSpeaker && SPEAKER_COLORS[activeSpeaker]) {
      const { hue } = SPEAKER_COLORS[activeSpeaker];
      const l = Math.round(20 + 60 * v);
      cssColor = `hsl(${hue},90%,${l}%)`;
    } else if (similarity > 0.7) {
      const l = Math.round(20 + 60 * v);
      cssColor = `hsl(185,100%,${l}%)`;
    } else if (similarity < 0.4) {
      const l = Math.round(10 + 30 * v);
      cssColor = `hsl(0,50%,${l}%)`;
    } else {
      const l = Math.round(10 + 50 * v);
      cssColor = `hsl(220,30%,${l}%)`;
    }
    ctx2D.fillStyle = cssColor;
    ctx2D.fillRect(xStart, yTop, colW + 1, yH);
  }

  // Draw mel-scale Y-axis labels on first render (every ~2 seconds)
  if (melMode && (timeIndex % 100 === 0)) {
    _draw2DAxis();
  }
}

/** Draw frequency axis labels on the 2D canvas. */
function _draw2DAxis() {
  const W = canvas2D.width;
  const H = canvas2D.height;
  const labels = melMode ? MEL_LABEL_HZ : [100, 500, 1000, 4000, 8000, 20000];
  ctx2D.font = '10px monospace';
  ctx2D.fillStyle = 'rgba(255,255,255,0.6)';
  for (const hz of labels) {
    let yFrac;
    if (melMode) {
      const melPos = (hzToMel(hz) - hzToMel(MEL_MIN_HZ)) /
                     (hzToMel(MEL_MAX_HZ) - hzToMel(MEL_MIN_HZ));
      yFrac = 1 - melPos;
    } else {
      yFrac = 1 - hz / NYQUIST;
    }
    const y = yFrac * H;
    ctx2D.fillText(hz >= 1000 ? `${hz / 1000}k` : `${hz}`, 4, y - 2);
    ctx2D.fillStyle = 'rgba(255,255,255,0.15)';
    ctx2D.fillRect(0, y, W, 1);
    ctx2D.fillStyle = 'rgba(255,255,255,0.6)';
  }
}

/** Resize the 2D canvas to match its display size. */
function _resize2D() {
  if (!canvas2D) return;
  const w = canvas2D.clientWidth  || canvas2D.parentElement?.clientWidth  || 400;
  const h = canvas2D.clientHeight || canvas2D.parentElement?.clientHeight || 200;
  if (canvas2D.width !== w || canvas2D.height !== h) {
    canvas2D.width  = w;
    canvas2D.height = h;
  }
}

/** Update the zoom-level badge text. */
function _updateZoomBadge() {
  if (elZoomBadge) elZoomBadge.textContent = `${zoomWindowSec}s`;
}

/** Update the speaker legend overlay. */
function _updateSpeakerLegend(speakerId) {
  if (!elSpeakerLegend) return;
  elSpeakerLegend.innerHTML = '';
  if (!speakerId) return;
  for (const [key, { hue, label }] of Object.entries(SPEAKER_COLORS)) {
    const item = document.createElement('span');
    item.className = 'sl-speaker-item';
    const dot = document.createElement('span');
    dot.className = 'sl-speaker-dot';
    dot.style.background = `hsl(${hue},90%,55%)`;
    if (key === speakerId) dot.style.outline = '2px solid #fff';
    item.appendChild(dot);
    item.appendChild(document.createTextNode(label));
    elSpeakerLegend.appendChild(item);
  }
  elSpeakerLegend.style.display = 'flex';
}

/** Bind zoom/pan event listeners to the canvas. */
function _bindZoomPan(canvas) {
  let isDragging   = false;
  let dragStartX   = 0;
  let dragStartPan = 0;

  // Scroll wheel → zoom time axis
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 1 : -1;
    zoomWindowSec = Math.max(1, Math.min(60, zoomWindowSec + delta * 2));
    _updateZoomBadge();
  }, { passive: false });

  // Also bind on 2D canvas when active
  canvas2D?.addEventListener('wheel', e => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 1 : -1;
    zoomWindowSec = Math.max(1, Math.min(60, zoomWindowSec + delta * 2));
    _updateZoomBadge();
  }, { passive: false });

  // Click + drag → pan time axis
  const onMouseDown = e => { isDragging = true; dragStartX = e.clientX; dragStartPan = panOffsetCols; };
  const onMouseMove = e => {
    if (!isDragging) return;
    const dx = e.clientX - dragStartX;
    const colsPerPx = TIME_COLS / (canvas.clientWidth || 400);
    panOffsetCols = Math.max(0, Math.min(TIME_COLS - 1, dragStartPan - Math.round(dx * colsPerPx)));
  };
  const onMouseUp = () => { isDragging = false; };

  canvas.addEventListener('mousedown', onMouseDown);
  canvas2D?.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup',   onMouseUp);

  // Double-click → reset zoom/pan
  const onDblClick = () => {
    zoomWindowSec = 10;
    panOffsetCols = 0;
    _updateZoomBadge();
  };
  canvas.addEventListener('dblclick', onDblClick);
  canvas2D?.addEventListener('dblclick', onDblClick);

  // Touch pinch-to-zoom (mobile)
  let lastPinchDist = null;
  canvas.addEventListener('touchstart', e => {
    if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      lastPinchDist = Math.sqrt(dx * dx + dy * dy);
    }
  }, { passive: true });
  canvas.addEventListener('touchmove', e => {
    if (e.touches.length === 2 && lastPinchDist !== null) {
      e.preventDefault();
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const scale = lastPinchDist / dist;
      zoomWindowSec = Math.max(1, Math.min(60, zoomWindowSec * scale));
      _updateZoomBadge();
      lastPinchDist = dist;
    }
  }, { passive: false });
  canvas.addEventListener('touchend', () => { lastPinchDist = null; }, { passive: true });
}

/** Keyboard shortcut handler. */
function _onKey(e) {
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
  if (e.key === 'v' || e.key === 'V') toggleMode();
  if (e.key === 'm' || e.key === 'M') toggleMelScale();
  if (e.key === 'f' || e.key === 'F') toggleFreeze();
}

/** Resize handler (3D + 2D). */
function _onResize() {
  if (renderer && camera && canvas3D) {
    const w = canvas3D.clientWidth  || window.innerWidth;
    const h = canvas3D.clientHeight || window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  }
  _resize2D();
}

/** Main render loop with delta-time capping (skip frames if lagging > 33ms). */
function animate(now) {
  requestAnimationFrame(animate);
  const dt = now - lastFrameTime;
  // Skip this render tick if the browser is lagging (dt > 33ms ≈ <30fps)
  // to avoid queuing up work; normal 60fps frames have dt ~16ms.
  if (dt > 33) {
    lastFrameTime = now;
    return;                // drop lagging frame to stay responsive
  }
  if (dt > 0) lastFrameTime = now;

  if (!mode2D) {
    controls.update();
    if (renderer && scene && camera) renderer.render(scene, camera);
  } else if (mode2D && ctx2D) {
    _resize2D();
    // In freeze mode, 2D already stopped updating; nothing extra needed here
  }
}
