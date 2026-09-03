/**
 * VoiceIsolate Pro — premium-visuals.js
 *
 * Premium visualizers driven by a single coordinator RAF (visuals-bootstrap.js).
 * Each init* returns { tick, resize, stop } — no internal animation loops.
 */

(function (global) {
  'use strict';

  function initPulsingAura(analyser, canvas) {
    if (!canvas || !analyser) return { tick: () => {}, resize: () => {}, stop: () => {} };
    const ctx = canvas.getContext('2d');
    if (!ctx) return { tick: () => {}, resize: () => {}, stop: () => {} };

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    let running = true;

    function tick() {
      if (!running) return;
      analyser.getByteFrequencyData(dataArray);

      const w = canvas.width;
      const h = canvas.height;
      const cx = w / 2;
      const cy = h / 2;
      const radius = Math.min(w, h) * 0.25;

      ctx.fillStyle = 'rgba(6, 6, 9, 0.4)';
      ctx.fillRect(0, 0, w, h);

      ctx.beginPath();
      for (let i = 0; i < bufferLength; i++) {
        const val = dataArray[i];
        const angle = (i / bufferLength) * Math.PI * 2;
        const r = radius + (val / 255) * radius * 1.5;
        const x = cx + Math.cos(angle) * r;
        const y = cy + Math.sin(angle) * r;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();

      ctx.lineWidth = 3;
      ctx.strokeStyle = '#ff2a2a';
      ctx.shadowBlur = 15;
      ctx.shadowColor = '#ff2a2a';
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(cx, cy, radius * 0.9, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 17, 17, 0.1)';
      ctx.fill();
    }

    return {
      tick,
      resize: () => {},
      stop: () => { running = false; },
    };
  }

  function initTopographic3D(analyser, container) {
    if (!container || !analyser || !global.THREE) {
      return { tick: () => {}, resize: () => {}, stop: () => {} };
    }

    const THREE = global.THREE;
    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x060609, 0.03);

    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
    camera.position.set(0, 15, 30);
    camera.lookAt(0, 0, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(dpr);
    container.innerHTML = '';
    container.appendChild(renderer.domElement);

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const width = 60;
    const depth = 40;
    const segW = Math.min(bufferLength - 1, 64);
    const segD = 40;
    const geometry = new THREE.PlaneGeometry(width, depth, segW, segD);
    geometry.rotateX(-Math.PI / 2);

    const material = new THREE.MeshBasicMaterial({
      color: 0xff1111,
      wireframe: true,
      transparent: true,
      opacity: 0.6,
    });

    const plane = new THREE.Mesh(geometry, material);
    scene.add(plane);

    let running = true;

    function resize() {
      const cw = Math.max(1, container.clientWidth);
      const ch = Math.max(1, container.clientHeight);
      camera.aspect = cw / ch;
      camera.updateProjectionMatrix();
      renderer.setSize(cw, ch, false);
    }

    function tick() {
      if (!running) return;
      analyser.getByteFrequencyData(dataArray);

      const positions = geometry.attributes.position.array;
      const ptsPerRow = segW + 1;

      for (let z = segD; z > 0; z--) {
        for (let x = 0; x < ptsPerRow; x++) {
          const idx = (z * ptsPerRow + x) * 3 + 1;
          const prevIdx = ((z - 1) * ptsPerRow + x) * 3 + 1;
          positions[idx] = positions[prevIdx];
        }
      }

      const step = Math.floor(bufferLength / ptsPerRow);
      for (let x = 0; x < ptsPerRow; x++) {
        const val = dataArray[x * step] || 0;
        const idx = x * 3 + 1;
        positions[idx] = (val / 255) * 10;
      }

      geometry.attributes.position.needsUpdate = true;
      renderer.render(scene, camera);
    }

    resize();

    return {
      tick,
      resize,
      stop: () => {
        running = false;
        renderer.dispose();
      },
    };
  }

  function initParticleSwarm(analyser, container) {
    if (!container || !analyser || !global.THREE) {
      return { tick: () => {}, resize: () => {}, stop: () => {} };
    }

    const THREE = global.THREE;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
    camera.position.z = 50;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(dpr);
    container.innerHTML = '';
    container.appendChild(renderer.domElement);

    const particleCount = 1500;
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(particleCount * 3);

    for (let i = 0; i < particleCount; i++) {
      const r = 15 + Math.random() * 10;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(Math.random() * 2 - 1);

      positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      positions[i * 3 + 2] = r * Math.cos(phi);
    }

    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.2, 'rgba(255,42,42,1)');
    gradient.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 32, 32);
    const texture = new THREE.CanvasTexture(canvas);

    const material = new THREE.PointsMaterial({
      size: 1.5,
      map: texture,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
      color: 0xff4444,
    });

    const particles = new THREE.Points(geometry, material);
    scene.add(particles);

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    let running = true;

    function resize() {
      const cw = Math.max(1, container.clientWidth);
      const ch = Math.max(1, container.clientHeight);
      camera.aspect = cw / ch;
      camera.updateProjectionMatrix();
      renderer.setSize(cw, ch, false);
    }

    function tick() {
      if (!running) return;
      analyser.getByteFrequencyData(dataArray);

      let sum = 0;
      for (let i = 0; i < 20; i++) sum += dataArray[i];
      const bass = sum / 20;
      const scale = 1 + (bass / 255) * 0.5;

      particles.scale.set(scale, scale, scale);
      particles.rotation.y += 0.005;
      particles.rotation.x += 0.002;

      renderer.render(scene, camera);
    }

    resize();

    return {
      tick,
      resize,
      stop: () => {
        running = false;
        renderer.dispose();
      },
    };
  }

  function initLiquidWaves(analyser, canvas) {
    if (!canvas || !analyser) return { tick: () => {}, resize: () => {}, stop: () => {} };
    const ctx = canvas.getContext('2d');
    if (!ctx) return { tick: () => {}, resize: () => {}, stop: () => {} };

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    let running = true;
    let phase = 0;

    function tick() {
      if (!running) return;
      analyser.getByteTimeDomainData(dataArray);

      let sum = 0;
      for (let i = 0; i < bufferLength; i++) {
        sum += Math.abs(dataArray[i] - 128);
      }
      const amplitude = sum / bufferLength;

      ctx.fillStyle = '#060609';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.globalCompositeOperation = 'screen';
      const colors = ['rgba(255, 42, 42, 0.5)', 'rgba(220, 20, 60, 0.5)', 'rgba(139, 0, 0, 0.5)'];

      phase += 0.05 + amplitude * 0.005;

      for (let j = 0; j < 3; j++) {
        ctx.beginPath();
        ctx.moveTo(0, canvas.height / 2);

        for (let x = 0; x <= canvas.width; x += 10) {
          const normX = x / canvas.width;
          const yOff = Math.sin(normX * Math.PI * 2 * (j + 1) + phase + j) * (amplitude * 1.5 + 5);
          ctx.lineTo(x, canvas.height / 2 + yOff);
        }

        ctx.lineWidth = 3;
        ctx.strokeStyle = colors[j];
        ctx.stroke();
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    return {
      tick,
      resize: () => {},
      stop: () => { running = false; },
    };
  }

  // visuals.js is intentionally maintenance-frozen, but it exposes a legacy
  // synchronous static-spectrogram helper. This file loads immediately after
  // visuals.js, so replace only that presentation helper with a cooperative
  // implementation. No audio-processing output is changed.
  let staticSpectrogramGeneration = 0;

  function yieldVisualWork() {
    if (global.scheduler && typeof global.scheduler.yield === 'function') {
      return global.scheduler.yield();
    }
    return new Promise((resolve) => {
      const finish = () => global.setTimeout(resolve, 0);
      if (typeof global.requestAnimationFrame === 'function') global.requestAnimationFrame(finish);
      else finish();
    });
  }

  async function drawStaticSpectrogramCooperative(canvas, audioBuf) {
    if (!canvas || !audioBuf || typeof audioBuf.getChannelData !== 'function') return false;
    const dsp = global.DSP || global.DSPCore;
    if (!dsp || (typeof dsp.forwardSTFTAsync !== 'function' && typeof dsp.forwardSTFT !== 'function')) {
      return false;
    }

    const generation = ++staticSpectrogramGeneration;
    const isCurrent = () => generation === staticSpectrogramGeneration;
    const data = audioBuf.getChannelData(0);
    const fftSize = 1024;
    const hopSize = 256;
    let spec;

    try {
      spec = typeof dsp.forwardSTFTAsync === 'function'
        ? await dsp.forwardSTFTAsync(data, fftSize, hopSize, { yieldEvery: 8 })
        : dsp.forwardSTFT(data, fftSize, hopSize);
    } catch (_) {
      return false;
    }
    if (!isCurrent() || !spec?.mag?.length) return false;

    const ctx = canvas.getContext('2d');
    if (!ctx) return false;
    const rect = canvas.getBoundingClientRect();
    const cssH = parseInt(global.getComputedStyle(canvas).height, 10) || 0;
    const w = Math.floor(rect.width > 0 ? rect.width : (canvas.offsetWidth || 800));
    const h = Math.floor(rect.height > 0 ? rect.height : (cssH || canvas.offsetHeight || 240));
    if (w < 2 || h < 2) return false;
    canvas.width = w;
    canvas.height = h;

    const frames = spec.mag.length;
    const bins = spec.mag[0].length;
    const img = ctx.createImageData(w, h);
    const lut = global.VIP_INFERNO_LUT;
    if (!lut) return false;

    let maxMag = 1e-9;
    for (let f = 0; f < frames; f++) {
      const frame = spec.mag[f];
      for (let b = 0; b < bins; b++) {
        if (frame[b] > maxMag) maxMag = frame[b];
      }
      if ((f & 15) === 15) {
        if (!isCurrent()) return false;
        await yieldVisualWork();
      }
    }

    for (let x = 0; x < w; x++) {
      const frameIndex = Math.min(frames - 1, Math.floor((x / w) * frames));
      const frame = spec.mag[frameIndex];
      for (let y = 0; y < h; y++) {
        const t = 1 - (y / h);
        const bin = Math.min(bins - 1, Math.floor(Math.pow(t, 2.0) * (bins - 1)));
        const v = Math.min(1, frame[bin] / maxMag);
        const li = Math.min(255, Math.floor(v * 255)) * 3;
        const px = (y * w + x) * 4;
        img.data[px] = lut[li];
        img.data[px + 1] = lut[li + 1];
        img.data[px + 2] = lut[li + 2];
        img.data[px + 3] = 255;
      }
      if ((x & 15) === 15) {
        if (!isCurrent()) return false;
        await yieldVisualWork();
      }
    }

    if (!isCurrent()) return false;
    ctx.putImageData(img, 0, 0);

    // visuals-bootstrap historically mirrors 2D → 3D immediately. Because the
    // cooperative path is async, mirror again after the final frame is ready.
    const mirror = global.document?.getElementById?.('spectroCanvas');
    if (mirror && mirror !== canvas && mirror.width > 0 && mirror.height > 0) {
      const mirrorCtx = mirror.getContext('2d');
      if (mirrorCtx) mirrorCtx.drawImage(canvas, 0, 0, mirror.width, mirror.height);
    }
    return true;
  }

  global.VIP_initPulsingAura = initPulsingAura;
  global.VIP_initTopographic3D = initTopographic3D;
  global.VIP_initParticleSwarm = initParticleSwarm;
  global.VIP_initLiquidWaves = initLiquidWaves;
  global.VIP_drawStaticSpectrogram = drawStaticSpectrogramCooperative;

})(typeof window !== 'undefined' ? window : this);