/**
 * VoiceIsolate Pro — Landing hero sculpture, WebGL render (Layer 4: Presentation)
 *
 * Signal Glass L2 in real 3D: the cyan + gold braid and its two ribbons are
 * tube / strip meshes with a custom silk shader (emissive core, fresnel rim,
 * key + rim specular, energy flowing along the strand), the lens is a
 * transmissive MeshPhysicalMaterial disc with the 135 deg cyan-to-gold lit
 * edge, and the dust is a depth-of-field point field. Geometry comes from
 * src/core/HeroSculptureGeometry.js, the same source as the SVG still, so the
 * HTML tags stay on their ribbons.
 *
 * Loaded only when HeroMotionPolicy allows motion and WebGL2 exists. Three.js
 * is the vendored same-origin build (/lib, CSP script-src 'self'). Visual only:
 * nothing here reads or touches audio. No camera movement: the camera is fixed
 * and only the sculpture (2 px) and dust (6 px) groups drift.
 */
'use strict';

import {
  FRAME, LENS, SCULPTURE_COLORS, helixSamples, helixStrand, voiceSamples, bgSamples,
  helixAmp, voiceHalfWidth, bgHalfWidth, sculptureTags, seededRandom, signalGlassEase,
} from '../core/HeroSculptureGeometry.js';
import { HERO_DRIFT, HERO_ENTRANCE, heroDriftOffset, heroPixelRatio } from '../core/HeroMotionPolicy.js';

const WU = 1 / 100; // world units per frame px
const FOV = 20;
const CAMERA_Z = (FRAME.height * WU) / 2 / Math.tan((FOV * Math.PI) / 360);
const toWorld = (x, y, z = 0) => [(x - FRAME.width / 2) * WU, (FRAME.height / 2 - y) * WU, z * WU];

// ── Shaders ────────────────────────────────────────────────────────────────
const SILK_VERT = /* glsl */`
  attribute float aG;
  varying vec3 vN; varying vec3 vV; varying vec3 vW; varying float vG; varying vec2 vUv;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vW = w.xyz; vG = aG; vUv = uv;
    vN = normalize(mat3(modelMatrix) * normal);
    vV = normalize(cameraPosition - w.xyz);
    gl_Position = projectionMatrix * viewMatrix * w;
  }`;

const SILK_FRAG = /* glsl */`
  uniform vec3 uColor; uniform vec3 uKey; uniform vec3 uRim;
  uniform vec3 uKeyDir; uniform vec3 uRimDir;
  uniform float uTime; uniform float uProgress; uniform float uOpacity; uniform float uFlow; uniform float uGlow;
  varying vec3 vN; varying vec3 vV; varying vec3 vW; varying float vG; varying vec2 vUv;
  void main() {
    float reveal = 1.0 - smoothstep(uProgress - 0.035, uProgress, vG);
    if (reveal < 0.002) discard;
    vec3 N = normalize(vN); if (!gl_FrontFacing) N = -N;
    vec3 V = normalize(vV);
    float ndv = abs(dot(N, V));
    float fres = pow(1.0 - ndv, 2.4);
    float depth = smoothstep(-0.5, 0.5, vW.z);            // back of the braid sits in shadow
    float key = max(dot(N, uKeyDir), 0.0);
    float spec = pow(max(dot(reflect(-uKeyDir, N), V), 0.0), 36.0);
    float rim = pow(max(dot(N, uRimDir), 0.0), 1.5) * fres;
    float ph = fract(vG * 7.0 - uTime * 0.085);           // energy flowing toward the ribbons
    float pulse = smoothstep(0.0, 0.06, ph) * (1.0 - smoothstep(0.06, 0.32, ph));
    float front = smoothstep(0.05, 0.0, abs(vG - uProgress)) * step(vG, 1.0) * (1.0 - step(1.02, uProgress));
    float edge = smoothstep(-9.9, -8.6, vW.x) * (1.0 - 0.35 * smoothstep(8.8, 9.8, vW.x));
    vec3 col = uColor * (0.32 + 0.5 * key) * mix(0.42, 1.0, depth)
      + uColor * (pulse * uFlow + front * 1.4)
      + uKey * spec * 0.55 + uRim * rim * 0.65 + uColor * fres * 0.35;
    float a = uOpacity * reveal * edge;
    if (uGlow > 0.5) { a *= pow(ndv, 2.2); col = uColor * (0.9 + pulse * uFlow); }
    gl_FragColor = vec4(col * edge, a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

const EDGE_FRAG = /* glsl */`
  uniform vec3 uVoice; uniform vec3 uGold; uniform vec2 uCenter; uniform float uProgress; uniform float uAt;
  varying vec3 vW;
  void main() {
    // 135 deg glass edge: cyan 36 % at top left to gold 30 % at bottom right.
    float k = clamp(dot(normalize(vec2(1.0, -1.0)), vW.xy - uCenter) / 4.2 + 0.5, 0.0, 1.0);
    float on = smoothstep(uAt - 0.06, uAt + 0.06, uProgress);
    gl_FragColor = vec4(mix(uVoice, uGold, k), mix(0.62, 0.5, k) * on);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

const DUST_VERT = /* glsl */`
  attribute float aSize; attribute vec3 aColor; attribute float aSeed;
  uniform float uTime; uniform float uScale; uniform float uFocus;
  varying vec3 vColor; varying float vBlur; varying float vAlpha;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float blur = clamp(abs(-mv.z - uFocus) / 3.2, 0.0, 1.0);          // depth-of-field
    vBlur = blur; vColor = aColor;
    vAlpha = (0.55 - 0.42 * blur) * (0.75 + 0.25 * sin(uTime * 0.6 + aSeed * 6.283));
    gl_PointSize = aSize * (1.0 + blur * 5.0) * uScale / -mv.z;
    gl_Position = projectionMatrix * mv;
  }`;

const DUST_FRAG = /* glsl */`
  varying vec3 vColor; varying float vBlur; varying float vAlpha;
  uniform float uOpacity;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    float a = (1.0 - smoothstep(mix(0.55, 0.0, vBlur), 1.0, d)) * vAlpha * uOpacity;
    if (a < 0.004) discard;
    gl_FragColor = vec4(vColor * a, a);
    #include <colorspace_fragment>
  }`;

// ── Geometry builders ─────────────────────────────────────────────────────
/** Variable-radius tube with parallel-transport frames. `g` is the reveal parameter per point. */
function tube(THREE, pts, radius, g, radial = 10) {
  const n = pts.length, ring = radial + 1;
  const pos = new Float32Array(n * ring * 3), nor = new Float32Array(n * ring * 3);
  const uv = new Float32Array(n * ring * 2), ag = new Float32Array(n * ring);
  const t = new THREE.Vector3(), nrm = new THREE.Vector3(0, 0, 1), b = new THREE.Vector3(), dir = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    t.subVectors(pts[Math.min(n - 1, i + 1)], pts[Math.max(0, i - 1)]).normalize();
    if (i === 0 && Math.abs(t.dot(nrm)) > 0.9) nrm.set(0, 1, 0);
    nrm.addScaledVector(t, -nrm.dot(t)).normalize();
    b.crossVectors(t, nrm);
    for (let j = 0; j < ring; j++) {
      const a = (j / radial) * Math.PI * 2;
      dir.copy(nrm).multiplyScalar(Math.cos(a)).addScaledVector(b, Math.sin(a));
      const k = i * ring + j;
      pos.set([pts[i].x + dir.x * radius[i], pts[i].y + dir.y * radius[i], pts[i].z + dir.z * radius[i]], k * 3);
      nor.set([dir.x, dir.y, dir.z], k * 3);
      uv.set([i / (n - 1), j / radial], k * 2);
      ag[k] = g[i];
    }
  }
  const idx = [];
  for (let i = 0; i < n - 1; i++) for (let j = 0; j < radial; j++) {
    const a = i * ring + j, c = a + ring;
    idx.push(a, c, a + 1, c, c + 1, a + 1);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('aG', new THREE.BufferAttribute(ag, 1));
  geo.setIndex(idx);
  return geo;
}

/** Twisting silk sheet: width vector turns around the tangent so its projection matches the still. */
function sheet(THREE, samples, halfWidth, g) {
  const n = samples.length;
  const pos = new Float32Array(n * 6), nor = new Float32Array(n * 6), uv = new Float32Array(n * 4), ag = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const c = samples[i];
    const th = Math.PI * (1.15 * c.t + 0.18);
    const w = (1.5 + 15 * Math.pow(c.t, 0.85)) * WU;
    const wx = c.n[0] * Math.cos(th) * w, wy = -c.n[1] * Math.cos(th) * w, wz = Math.sin(th) * w;
    const [x, y] = toWorld(c.p[0], c.p[1]);
    pos.set([x + wx, y + wy, wz, x - wx, y - wy, -wz], i * 6);
    // normal = tangent x width
    const tx = i < n - 1 ? samples[i + 1].p[0] - c.p[0] : c.p[0] - samples[i - 1].p[0];
    const ty = -(i < n - 1 ? samples[i + 1].p[1] - c.p[1] : c.p[1] - samples[i - 1].p[1]);
    const tl = Math.hypot(tx, ty) || 1;
    const nx = (ty / tl) * wz, ny = (-tx / tl) * wz, nz = (tx / tl) * wy - (ty / tl) * wx;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nor.set([nx / nl, ny / nl, nz / nl, nx / nl, ny / nl, nz / nl], i * 6);
    uv.set([c.t, 0, c.t, 1], i * 4);
    ag[i * 2] = ag[i * 2 + 1] = g(c);
    void halfWidth;
  }
  const idx = [];
  for (let i = 0; i < n - 1; i++) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 2, a + 3, a + 1); }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('aG', new THREE.BufferAttribute(ag, 1));
  geo.setIndex(idx);
  return geo;
}

/** Arc-length parameter along a polyline, scaled into [g0, g1]. */
function arcParam(pts, g0 = 0, g1 = 1) {
  const acc = [0];
  for (let i = 1; i < pts.length; i++) acc.push(acc[i - 1] + pts[i].distanceTo(pts[i - 1]));
  const L = acc[acc.length - 1] || 1;
  return acc.map((d) => g0 + (g1 - g0) * (d / L));
}

/**
 * Mount the WebGL render inside `.v3-sculpture__frame`.
 * @param {HTMLElement} stage
 * @param {object} o
 * @param {Window} o.win
 * @param {object} o.budget   selectHeroRenderer() result (renderer '3d')
 * @param {(reason: string, err?: unknown) => void} [o.onFail]  called once if WebGL is lost or throws
 * @param {() => Promise<object>} [o.loadThree]
 * @returns {Promise<{ stop: () => void, stats: () => object }>}
 */
export async function mountHeroSculpture3D(stage, { win = window, budget, onFail = () => {}, loadThree = () => import('/lib/three.module.min.js') } = {}) {
  const THREE = await loadThree();
  const doc = win.document;
  const frame = stage.querySelector('.v3-sculpture__frame');
  const art = stage.querySelector('.v3-sculpture__art');
  const dustSvg = stage.querySelector('.v3-sculpture__dust');
  if (!frame) throw new Error('hero frame missing');

  const canvas = doc.createElement('canvas');
  canvas.className = 'v3-sculpture__gl';
  canvas.setAttribute('aria-hidden', 'true');
  frame.insertBefore(canvas, frame.querySelector('.v3-sculpture__leaders'));

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, premultipliedAlpha: true, powerPreference: 'high-performance' });
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, FRAME.width / FRAME.height, 1, 80);
  camera.position.set(0, 0, CAMERA_Z);
  camera.lookAt(0, 0, 0);

  const disposables = [];
  const keep = (x) => { disposables.push(x); return x; };
  const C = (hex) => new THREE.Color(hex);
  const voiceC = C(SCULPTURE_COLORS.voice), goldC = C(SCULPTURE_COLORS.bgst), refC = C(SCULPTURE_COLORS.ref);
  const keyDir = new THREE.Vector3(-0.62, 0.62, 0.48).normalize();   // cyan key, upper left, ~35 deg
  const rimDir = new THREE.Vector3(0.82, 0.12, -0.56).normalize();   // gold rim, back right, low
  const shared = { uTime: { value: 0 }, uProgress: { value: -0.05 } };

  const silk = (color, { opacity = 1, flow = 0.32, glow = false, transparent = false } = {}) => keep(new THREE.ShaderMaterial({
    vertexShader: SILK_VERT, fragmentShader: SILK_FRAG, transparent, depthWrite: !transparent,
    side: THREE.DoubleSide, blending: glow ? THREE.AdditiveBlending : THREE.NormalBlending,
    uniforms: {
      ...shared, uColor: { value: color }, uKey: { value: voiceC }, uRim: { value: goldC },
      uKeyDir: { value: keyDir }, uRimDir: { value: rimDir },
      uOpacity: { value: opacity }, uFlow: { value: flow }, uGlow: { value: glow ? 1 : 0 },
    },
  }));

  const body = new THREE.Group();
  const dust = new THREE.Group();
  scene.add(body, dust);
  // ── Braid: one continuous tube per strand, helix → its own ribbon core ──
  const helix = helixSamples(260);
  const voice = voiceSamples(90), bg = bgSamples(90);
  const strandPts = (sign, ribbon) => {
    const s = helixStrand(sign, helix).map((v) => new THREE.Vector3(...toWorld(v.xy[0], v.xy[1], v.z)));
    const r = ribbon.slice(1).map((c) => new THREE.Vector3(...toWorld(c.p[0], c.p[1])));
    return { pts: s.concat(r), hubAt: s.length - 1 };
  };
  const meshes = [];
  const add = (geo, mat, order = 0, group = body) => { keep(geo); const m = new THREE.Mesh(geo, mat); m.renderOrder = order; m.frustumCulled = false; group.add(m); meshes.push(m); return m; };
  const strandRadius = (pts, hubAt, r0, r1) => pts.map((_, i) => (i <= hubAt ? r0 + (r1 - r0) * (i / hubAt) : r1) * WU);

  const A = strandPts(1, voice), B = strandPts(-1, bg);
  const gA = arcParam(A.pts), gB = arcParam(B.pts);
  const hubG = (gA[A.hubAt] + gB[B.hubAt]) / 2;
  add(tube(THREE, A.pts, strandRadius(A.pts, A.hubAt, 2.3, 1.9), gA, 12), silk(voiceC), 2);
  add(tube(THREE, B.pts, strandRadius(B.pts, B.hubAt, 2.1, 1.5), gB, 12), silk(goldC), 2);

  // Gold Background ribbon: a finely textured bundle of thin strands either side of the core.
  for (const k of [-0.72, -0.36, 0.36, 0.72]) {
    const pts = bg.slice(2).map((c) => {
      const d = k * bgHalfWidth(c);
      return new THREE.Vector3(...toWorld(c.p[0] + c.n[0] * d, c.p[1] + c.n[1] * d, k * 6 * c.t));
    });
    add(tube(THREE, pts, pts.map(() => 0.65 * WU), arcParam(pts, hubG + 0.01, 1), 6), silk(goldC, { flow: 0.2 }), 2);
  }
  // Clean Voice ribbon: smooth translucent silk sheet around the cyan core.
  add(sheet(THREE, voice.slice(2), voiceHalfWidth, (c) => hubG + (1 - hubG) * c.t), silk(voiceC, { opacity: 0.34, flow: 0.5, transparent: true }), 4);

  // Silver sheath around the braid (fresnel-only glass shell).
  const centre = helix.map((c) => new THREE.Vector3(...toWorld(c.p[0], c.p[1])));
  add(tube(THREE, centre, helix.map((c) => (helixAmp(c) + 11) * WU), arcParam(centre, 0, hubG), 24),
    keep(new THREE.ShaderMaterial({
      vertexShader: SILK_VERT, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      uniforms: { ...shared, uColor: { value: refC } },
      fragmentShader: /* glsl */`
        uniform vec3 uColor; uniform float uProgress; varying vec3 vN; varying vec3 vV; varying vec3 vW; varying float vG;
        void main() {
          float reveal = 1.0 - smoothstep(uProgress - 0.035, uProgress, vG);
          float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 3.0);
          float edge = smoothstep(-9.9, -8.6, vW.x);
          gl_FragColor = vec4(uColor, (0.025 + 0.14 * f) * reveal * edge);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    })), 5);

  // Bloom on HIGH only: additive glow shells (no post-processing pass).
  if (budget.glow) {
    add(tube(THREE, A.pts, strandRadius(A.pts, A.hubAt, 9, 8), gA, 8), silk(voiceC, { glow: true, opacity: 0.16, transparent: true }), 6);
    add(tube(THREE, B.pts, strandRadius(B.pts, B.hubAt, 8, 7), gB, 8), silk(goldC, { glow: true, opacity: 0.13, transparent: true }), 6);
  }

  // ── Lens: transmissive smoked-glass disc, tilted, with the lit 135 deg edge ──
  const lensGroup = new THREE.Group();
  const [lx, ly] = toWorld(LENS.cx, LENS.cy);
  lensGroup.position.set(lx, ly, 0);
  lensGroup.rotation.z = (-LENS.rot * Math.PI) / 180;
  const tilt = new THREE.Group();
  tilt.rotation.y = Math.acos(LENS.rx / LENS.ry);
  lensGroup.add(tilt);
  body.add(lensGroup);
  const R = LENS.ry * WU;
  // Physical transmission needs an opaque scene behind it (this canvas is transparent
  // over the page) and costs a second full render, so the glass is a custom lens
  // shader instead: smoked body, biconvex normals so the cyan key and gold rim make
  // real moving highlights, fresnel edge, and an environment reflection term.
  const glass = keep(new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.FrontSide,
    uniforms: { ...shared, uKeyDir: { value: keyDir }, uRimDir: { value: rimDir }, uKey: { value: voiceC }, uRim: { value: goldC }, uR: { value: R }, uAt: { value: hubG - 0.18 } },
    vertexShader: /* glsl */`
      varying vec3 vL; varying vec3 vWN; varying vec3 vV; varying vec3 vLN;
      void main() {
        vL = position; vLN = normal;
        vec4 w = modelMatrix * vec4(position, 1.0);
        vV = normalize(cameraPosition - w.xyz);
        vWN = mat3(modelMatrix) * normal;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uKeyDir; uniform vec3 uRimDir; uniform vec3 uKey; uniform vec3 uRim;
      uniform float uR; uniform float uProgress; uniform float uAt; uniform mat4 modelMatrix;
      varying vec3 vL; varying vec3 vWN; varying vec3 vV; varying vec3 vLN;
      void main() {
        float on = smoothstep(uAt - 0.08, uAt + 0.08, uProgress);
        if (on < 0.002) discard;
        vec2 r = vL.xz / uR;                       // -1..1 across the face
        float rr = dot(r, r);
        vec3 ln = vLN;
        bool cap = abs(vLN.y) > 0.5;
        if (cap) ln = normalize(vLN + vec3(r.x, 0.0, r.y) * 0.55 * sign(vLN.y));  // biconvex
        vec3 N = normalize(mat3(modelMatrix) * ln);
        vec3 V = normalize(vV);
        float ndv = clamp(abs(dot(N, V)), 0.0, 1.0);
        float fres = 0.04 + 0.96 * pow(1.0 - ndv, 5.0);
        float sk = pow(max(dot(reflect(-uKeyDir, N), V), 0.0), 60.0);
        float sr = pow(max(dot(reflect(-uRimDir, N), V), 0.0), 24.0);
        // Environment: dark room, cyan panel up-left, gold panel back-right.
        vec3 R3 = reflect(-V, N);
        vec3 env = uKey * pow(max(dot(R3, normalize(vec3(-0.7, 0.6, 0.4))), 0.0), 6.0) * 0.5
                 + uRim * pow(max(dot(R3, normalize(vec3(0.8, 0.05, -0.5))), 0.0), 5.0) * 0.45
                 + vec3(0.05, 0.065, 0.08);
        float k = clamp(0.5 + 0.35 * (r.x - r.y), 0.0, 1.0);
        vec3 sheen = mix(uKey, uRim, k) * (cap ? smoothstep(0.55, 1.0, rr) * 0.12 : 0.35);
        vec3 col = vec3(0.045, 0.06, 0.08) + env * (0.35 + fres) + uKey * sk * 1.2 + uRim * sr * 0.7 + sheen;
        float a = (cap ? 0.30 + 0.25 * fres + 0.12 * rr : 0.75) + sk * 0.5 + sr * 0.3;
        gl_FragColor = vec4(col, clamp(a, 0.0, 0.92) * on);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  }));
  const disc = new THREE.Mesh(keep(new THREE.CylinderGeometry(R, R, 0.14, 128, 1)), glass);
  disc.rotation.x = Math.PI / 2;
  disc.renderOrder = 3;
  tilt.add(disc);
  const edgeMat = keep(new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uVoice: { value: voiceC }, uGold: { value: goldC }, uCenter: { value: new THREE.Vector2(lx, ly) }, uProgress: shared.uProgress, uAt: { value: hubG - 0.12 } },
    vertexShader: 'varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
    fragmentShader: EDGE_FRAG,
  }));
  for (const z of [0.072, -0.072]) {
    const ring = new THREE.Mesh(keep(new THREE.TorusGeometry(R, 0.011, 8, 200)), edgeMat);
    ring.position.z = z; ring.renderOrder = 7; tilt.add(ring);
  }

  // ── Dust: depth-of-field point field (sparser on the narrow band) ──
  const rand = seededRandom(1929);
  const N = budget.particles;
  const dp = new Float32Array(N * 3), ds = new Float32Array(N), dc = new Float32Array(N * 3), dseed = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const x = 980 + rand() * 1000, y = 80 + rand() * 980, z = -380 + rand() * 640;
    dp.set(toWorld(x, y, z), i * 3);
    ds[i] = 1.6 + rand() * 2.6;
    const c = y < 460 ? voiceC : y > 620 ? goldC : refC;
    dc.set([c.r, c.g, c.b], i * 3);
    dseed[i] = rand();
  }
  const dustGeo = keep(new THREE.BufferGeometry());
  dustGeo.setAttribute('position', new THREE.BufferAttribute(dp, 3));
  dustGeo.setAttribute('aSize', new THREE.BufferAttribute(ds, 1));
  dustGeo.setAttribute('aColor', new THREE.BufferAttribute(dc, 3));
  dustGeo.setAttribute('aSeed', new THREE.BufferAttribute(dseed, 1));
  const dustMat = keep(new THREE.ShaderMaterial({
    vertexShader: DUST_VERT, fragmentShader: DUST_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uTime: shared.uTime, uScale: { value: 1 }, uFocus: { value: CAMERA_Z }, uOpacity: { value: 0 } },
  }));
  const points = new THREE.Points(dustGeo, dustMat);
  points.frustumCulled = false;
  dust.add(points);

  // ── Leaders: re-anchor to the projected 3D ribbon points ──
  const tags = sculptureTags();
  const leaderSvg = stage.querySelector('.v3-sculpture__leaders');
  const projectTags = () => {
    for (const t of tags) {
      const v = new THREE.Vector3(...toWorld(t.target[0], t.target[1])).project(camera);
      const x = ((v.x + 1) / 2) * FRAME.width, y = ((1 - v.y) / 2) * FRAME.height;
      leaderSvg?.querySelector(`path[data-tag="${t.id}"]`)?.setAttribute('d', `M${Math.round(t.from[0])} ${Math.round(t.from[1])}L${Math.round(x)} ${Math.round(y)}`);
      const dot = leaderSvg?.querySelector(`circle[data-tag="${t.id}"]`);
      dot?.setAttribute('cx', x.toFixed(1)); dot?.setAttribute('cy', y.toFixed(1));
    }
  };

  // Reveal front in frame x (for wiping the SVG still exactly where 3D has drawn).
  const wipeX = (g) => {
    const i = gA.findIndex((v) => v >= g);
    if (i < 0) return FRAME.width + 80;
    return A.pts[i].x / WU + FRAME.width / 2;
  };

  // ── Size, loop, lifecycle ──
  let w = 0, h = 0;
  const resize = () => {
    const r = frame.getBoundingClientRect();
    w = Math.max(1, Math.round(r.width)); h = Math.max(1, Math.round(r.height));
    const pr = heroPixelRatio(budget, w, h, win.devicePixelRatio || 1);
    renderer.setPixelRatio(pr);
    renderer.setSize(w, h, false);
    dustMat.uniforms.uScale.value = (h * pr) / (2 * Math.tan((FOV * Math.PI) / 360)) * WU * 1.0;
  };
  resize();
  projectTags();
  const ro = typeof win.ResizeObserver === 'function' ? new win.ResizeObserver(resize) : null;
  ro?.observe(frame);

  const minFrameMs = budget.fps > 0 ? 1000 / budget.fps - 1 : 0;
  let raf = 0, last = -Infinity, onScreen = true, stopped = false, failed = false;
  let clock = 0, lastNow = null, entranceDone = false, frames = 0, swapped = false;

  const finishEntrance = () => {
    entranceDone = true;
    shared.uProgress.value = 1.06;
    if (art) { art.style.visibility = 'hidden'; art.style.maskImage = art.style.webkitMaskImage = ''; }
    if (dustSvg) dustSvg.style.visibility = 'hidden';
    stage.dataset.entrance = 'done';
  };

  const render = (now) => {
    raf = 0;
    if (stopped || doc.hidden || !onScreen) { lastNow = null; return; }
    raf = win.requestAnimationFrame(render);
    if (now - last < minFrameMs) return;
    clock += lastNow === null ? 0 : Math.min(100, now - lastNow); // paused time never counts
    lastNow = now; last = now;
    shared.uTime.value = clock / 1000;
    if (!entranceDone) {
      const k = Math.min(1, clock / HERO_ENTRANCE.durationMs);
      shared.uProgress.value = -0.05 + 1.11 * signalGlassEase(k);
      dustMat.uniforms.uOpacity.value = Math.min(1, clock / HERO_ENTRANCE.crossfadeMs);
      if (art) {
        const x = (wipeX(shared.uProgress.value) / FRAME.width) * 100;
        const m = `linear-gradient(90deg, transparent ${(x - 3).toFixed(2)}%, #000 ${(x + 3).toFixed(2)}%)`;
        art.style.maskImage = m; art.style.webkitMaskImage = m;
      }
      if (dustSvg) dustSvg.style.opacity = String(1 - dustMat.uniforms.uOpacity.value);
      if (k >= 1) finishEntrance();
    }
    const { x, y } = heroDriftOffset(clock);
    body.position.set(x * HERO_DRIFT.bodyPx * WU, -y * HERO_DRIFT.bodyPx * WU, 0);
    dust.position.set(x * HERO_DRIFT.dustPx * WU, -y * HERO_DRIFT.dustPx * WU, 0);
    try {
      renderer.render(scene, camera);
    } catch (err) {
      fail('render', err);
      return;
    }
    frames++;
    if (!swapped) { swapped = true; stage.dataset.render = '3d'; }
  };

  const sync = () => {
    if (stopped) return;
    if (doc.hidden || !onScreen) { if (raf) { win.cancelAnimationFrame(raf); raf = 0; } lastNow = null; }
    else if (!raf) raf = win.requestAnimationFrame(render);
  };
  const io = typeof win.IntersectionObserver === 'function'
    ? new win.IntersectionObserver(([e]) => { onScreen = e.isIntersecting; sync(); })
    : null;
  io?.observe(stage);
  doc.addEventListener('visibilitychange', sync);

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (raf) win.cancelAnimationFrame(raf);
    raf = 0;
    io?.disconnect(); ro?.disconnect();
    doc.removeEventListener('visibilitychange', sync);
    canvas.removeEventListener('webglcontextlost', onLost);
    for (const d of disposables) d.dispose?.();
    renderer.dispose();
    canvas.remove();
    // Hand the picture back to the SVG still.
    if (art) { art.style.visibility = ''; art.style.maskImage = art.style.webkitMaskImage = ''; }
    if (dustSvg) { dustSvg.style.visibility = ''; dustSvg.style.opacity = ''; }
    const fresh = sculptureTags();
    for (const t of fresh) {
      leaderSvg?.querySelector(`path[data-tag="${t.id}"]`)?.setAttribute('d', `M${Math.round(t.from[0])} ${Math.round(t.from[1])}L${Math.round(t.target[0])} ${Math.round(t.target[1])}`);
    }
    delete stage.dataset.entrance;
  };
  function fail(reason, err) {
    if (failed) return;
    failed = true;
    stop();
    onFail(reason, err);
  }
  function onLost(e) { e.preventDefault(); fail('context-lost'); }
  canvas.addEventListener('webglcontextlost', onLost);

  // Compile before the first visible frame so the entrance starts smoothly.
  renderer.compile(scene, camera);
  sync();

  return {
    stop,
    stats: () => ({ frames, entranceDone, pixelRatio: renderer.getPixelRatio(), size: [w, h], particles: N, glow: budget.glow, calls: renderer.info.render.calls, triangles: renderer.info.render.triangles }),
  };
}
