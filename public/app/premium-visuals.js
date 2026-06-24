/**
 * VoiceIsolate Pro — premium-visuals.js
 * 
 * 4 Top-Tier Visualizers with a Premium Red / Dark Aesthetic
 * 1. Circular / Radial Pulsing Aura
 * 2. 3D Topographic Surface Plot (Three.js)
 * 3. Ember Particle Swarm (Three.js)
 * 4. Multi-Layered Liquid Voice Waves
 */

(function (global) {
  'use strict';

  // --- 1. Circular / Radial Pulsing Aura ---
  function initPulsingAura(analyser, canvas) {
    if (!canvas || !analyser) return { stop: () => {} };
    const ctx = canvas.getContext('2d');
    if (!ctx) return { stop: () => {} };

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    let rafId = 0;
    let running = true;

    function draw() {
      if (!running) return;
      rafId = requestAnimationFrame(draw);
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

      // Inner glow
      ctx.beginPath();
      ctx.arc(cx, cy, radius * 0.9, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 17, 17, 0.1)';
      ctx.fill();
    }
    draw();
    return { stop: () => { running = false; cancelAnimationFrame(rafId); } };
  }

  // --- 2. 3D Topographic Surface Plot ---
  function initTopographic3D(analyser, container) {
    if (!container || !analyser || !global.THREE) return { stop: () => {} };
    
    const THREE = global.THREE;
    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x060609, 0.03);

    const camera = new THREE.PerspectiveCamera(60, container.clientWidth / container.clientHeight, 0.1, 1000);
    camera.position.set(0, 15, 30);
    camera.lookAt(0, 0, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(container.clientWidth, container.clientHeight);
    container.innerHTML = '';
    container.appendChild(renderer.domElement);

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    
    // Create grid geometry
    const width = 60, depth = 40;
    const segW = Math.min(bufferLength - 1, 64);
    const segD = 40;
    const geometry = new THREE.PlaneGeometry(width, depth, segW, segD);
    geometry.rotateX(-Math.PI / 2);
    
    const material = new THREE.MeshBasicMaterial({ 
      color: 0xff1111, 
      wireframe: true, 
      transparent: true,
      opacity: 0.6
    });
    
    const plane = new THREE.Mesh(geometry, material);
    scene.add(plane);

    let rafId = 0;
    let running = true;

    function draw() {
      if (!running) return;
      rafId = requestAnimationFrame(draw);
      analyser.getByteFrequencyData(dataArray);

      const positions = geometry.attributes.position.array;
      const ptsPerRow = segW + 1;
      
      // Shift rows back
      for (let z = segD; z > 0; z--) {
        for (let x = 0; x < ptsPerRow; x++) {
          const idx = (z * ptsPerRow + x) * 3 + 1;
          const prevIdx = ((z - 1) * ptsPerRow + x) * 3 + 1;
          positions[idx] = positions[prevIdx];
        }
      }
      
      // Update front row
      const step = Math.floor(bufferLength / ptsPerRow);
      for (let x = 0; x < ptsPerRow; x++) {
        const val = dataArray[x * step] || 0;
        const idx = x * 3 + 1;
        positions[idx] = (val / 255) * 10;
      }
      
      geometry.attributes.position.needsUpdate = true;
      renderer.render(scene, camera);
    }
    draw();

    const resize = () => {
      camera.aspect = container.clientWidth / container.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(container.clientWidth, container.clientHeight);
    };
    window.addEventListener('resize', resize);

    return { stop: () => { 
      running = false; 
      cancelAnimationFrame(rafId); 
      window.removeEventListener('resize', resize);
      renderer.dispose();
    }};
  }

  // --- 3. Ember Particle Swarm ---
  function initParticleSwarm(analyser, container) {
    if (!container || !analyser || !global.THREE) return { stop: () => {} };
    
    const THREE = global.THREE;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, container.clientWidth / container.clientHeight, 0.1, 1000);
    camera.position.z = 50;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(container.clientWidth, container.clientHeight);
    container.innerHTML = '';
    container.appendChild(renderer.domElement);

    const particleCount = 1500;
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(particleCount * 3);
    const velocities = [];

    for (let i = 0; i < particleCount; i++) {
      const r = 15 + Math.random() * 10;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(Math.random() * 2 - 1);
      
      positions[i*3] = r * Math.sin(phi) * Math.cos(theta);
      positions[i*3+1] = r * Math.sin(phi) * Math.sin(theta);
      positions[i*3+2] = r * Math.cos(phi);
      
      velocities.push({
        x: (Math.random() - 0.5) * 0.1,
        y: (Math.random() - 0.5) * 0.1,
        z: (Math.random() - 0.5) * 0.1
      });
    }

    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    
    // Create a circular particle texture procedurally
    const canvas = document.createElement('canvas');
    canvas.width = 32; canvas.height = 32;
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.2, 'rgba(255,42,42,1)');
    gradient.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0,0,32,32);
    const texture = new THREE.CanvasTexture(canvas);

    const material = new THREE.PointsMaterial({
      size: 1.5,
      map: texture,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
      color: 0xff4444
    });

    const particles = new THREE.Points(geometry, material);
    scene.add(particles);

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    let rafId = 0;
    let running = true;

    function draw() {
      if (!running) return;
      rafId = requestAnimationFrame(draw);
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
    draw();

    const resize = () => {
      camera.aspect = container.clientWidth / container.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(container.clientWidth, container.clientHeight);
    };
    window.addEventListener('resize', resize);

    return { stop: () => { 
      running = false; cancelAnimationFrame(rafId); 
      window.removeEventListener('resize', resize);
      renderer.dispose();
    }};
  }

  // --- 4. Multi-Layered Liquid Voice Waves ---
  function initLiquidWaves(analyser, canvas) {
    if (!canvas || !analyser) return { stop: () => {} };
    const ctx = canvas.getContext('2d');
    if (!ctx) return { stop: () => {} };

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    let rafId = 0;
    let running = true;
    let phase = 0;

    function draw() {
      if (!running) return;
      rafId = requestAnimationFrame(draw);
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
    draw();
    return { stop: () => { running = false; cancelAnimationFrame(rafId); } };
  }

  global.VIP_initPulsingAura = initPulsingAura;
  global.VIP_initTopographic3D = initTopographic3D;
  global.VIP_initParticleSwarm = initParticleSwarm;
  global.VIP_initLiquidWaves = initLiquidWaves;

})(typeof window !== 'undefined' ? window : this);
