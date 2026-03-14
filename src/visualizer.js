// src/visualizer.js — Three.js 3D Spectrogram
// Axes: X = Time (rolling history), Z = Frequency, Y = Amplitude
// Color: cosine similarity score from ECAPA-TDNN drives peak color semantics

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const FFT_BINS  = 512;
const TIME_COLS = 128;  // ~1.4s rolling history at 48kHz/hop-512 @ every 4 blocks
const TOTAL_PTS = FFT_BINS * TIME_COLS;

let scene, camera, renderer, controls, mesh, geometry;
const positions = new Float32Array(TOTAL_PTS * 3);
const colors    = new Float32Array(TOTAL_PTS * 3);
let timeIndex   = 0;
let lastSimilarity = 0.5;

export function initVisualizer(canvas) {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
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
  controls.enableDamping    = true;
  controls.dampingFactor    = 0.07;
  controls.autoRotate       = true;
  controls.autoRotateSpeed  = 0.4;
  controls.minDistance      = 20;
  controls.maxDistance      = 300;

  // ── Point cloud geometry ────────────────────────────────────────────────
  geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color',    new THREE.BufferAttribute(colors, 3));

  // Initialize flat (Y=0)
  for (let t = 0; t < TIME_COLS; t++) {
    for (let k = 0; k < FFT_BINS; k++) {
      const idx = (t * FFT_BINS + k) * 3;
      positions[idx]     = t * 1.5;     // X = time
      positions[idx + 1] = 0;           // Y = amplitude (height)
      positions[idx + 2] = k * 0.25;    // Z = frequency
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

  // ── Axis helper & grid ─────────────────────────────────────────────────
  scene.add(new THREE.AxesHelper(60));
  const grid = new THREE.GridHelper(200, 40, 0x112233, 0x0a1520);
  scene.add(grid);

  // ── Ambient + directional light (for future mesh upgrades) ────────────
  scene.add(new THREE.AmbientLight(0x112244, 1.5));
  const dirLight = new THREE.DirectionalLight(0x4488ff, 2);
  dirLight.position.set(50, 100, 50);
  scene.add(dirLight);

  // ── Resize handler ─────────────────────────────────────────────────────
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  animate();
}

/**
 * Called every ~10ms from main.js with:
 * @param {Float32Array|null} magnitude  - 512 FFT bins (null = similarity-only update)
 * @param {number}            similarity - ECAPA-TDNN cosine similarity score 0..1
 *
 * Color semantics (cosine similarity S):
 *   S > 0.7  → bright cyan  (target voice confirmed)
 *   S < 0.4  → muted red    (background noise / different speaker)
 *   0.4–0.7  → neutral grey (ambiguous)
 */
export function updateVisualizer(magnitude, similarity = lastSimilarity) {
  lastSimilarity = similarity;
  if (!magnitude || !geometry) return;

  const col = timeIndex % TIME_COLS;

  for (let k = 0; k < FFT_BINS; k++) {
    const idx = (col * FFT_BINS + k) * 3;
    const amp = Math.min(magnitude[k] * 80, 60); // clamp Y height

    positions[idx]     = col * 1.5;
    positions[idx + 1] = amp;
    positions[idx + 2] = k * 0.25;

    // ── Semantic color mapping ──────────────────────────────────────────
    if (similarity > 0.7) {
      // Target voice — cyan/blue
      const brightness = 0.5 + 0.5 * (amp / 60);
      colors[idx]     = 0.0;
      colors[idx + 1] = 0.7 * brightness;
      colors[idx + 2] = 1.0 * brightness;
    } else if (similarity < 0.4) {
      // Background / other speaker — muted red-grey
      const dim = 0.2 + 0.3 * (amp / 60);
      colors[idx]     = 0.5 * dim;
      colors[idx + 1] = 0.1 * dim;
      colors[idx + 2] = 0.1 * dim;
    } else {
      // Ambiguous — neutral grey
      const g = 0.15 + 0.35 * (amp / 60);
      colors[idx]     = g;
      colors[idx + 1] = g;
      colors[idx + 2] = g + 0.1;
    }
  }

  geometry.attributes.position.needsUpdate = true;
  geometry.attributes.color.needsUpdate    = true;
  timeIndex++;
}

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
