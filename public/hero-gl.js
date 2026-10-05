/**
 * Landing hero: WebGL ridge-line landscape (cyan voice band, violet background).
 * Decorative only. Three.js is the vendored same-origin build (CSP script-src 'self').
 */
export async function mountHero(canvas) {
  const THREE = await import('/lib/three.module.min.js');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
  const uniforms = { uTime: { value: 0 }, uScan: { value: -12 } };

  const H = `
    uniform float uTime;
    float band(float z){ return exp(-pow(z/1.15,2.0)); }
    float hgt(vec2 p){
      float b = band(p.y);
      float env = 0.5 + 0.5*sin(p.x*0.32 - uTime*0.55);
      float edge = smoothstep(11.5, 3.5, abs(p.x));
      float v = (abs(sin(p.x*1.6 + uTime*1.25))*0.55 + abs(sin(p.x*3.3 - uTime*0.85))*0.3 + abs(sin(p.x*6.1 + uTime*2.1))*0.15) * env * edge;
      float g = (sin(p.x*0.85 + p.y*1.3 + uTime*0.45)*0.5+0.5)*0.32 + (sin(p.x*2.2 - p.y*0.8 - uTime*0.7)*0.5+0.5)*0.14;
      return b*v*2.6 + (1.0-b)*g*0.7*edge;
    }`;

  const lineMat = new THREE.ShaderMaterial({
    uniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: H + `
      varying float vB; varying float vH; varying float vX; varying float vZ;
      void main(){
        vec3 p = position; float h = hgt(p.xz); p.y = h;
        vB = band(p.z); vH = h; vX = p.x; vZ = p.z;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p,1.0);
      }`,
    fragmentShader: `
      uniform float uScan;
      varying float vB; varying float vH; varying float vX; varying float vZ;
      void main(){
        vec3 violet = vec3(0.55,0.38,1.0); vec3 cyan = vec3(0.18,0.84,0.9);
        vec3 c = mix(violet, cyan, smoothstep(0.15,0.85,vB));
        float br = 0.28 + vH*0.55 + vB*0.35;
        float s = exp(-pow((vX-uScan)/0.55,2.0));
        c = c*br + s*vec3(0.55,0.95,1.0)*(0.4+vB);
        float a = smoothstep(11.5,6.5,abs(vX)) * smoothstep(7.0,2.0,abs(vZ)+0.6);
        gl_FragColor = vec4(c, a);
      }`,
  });
  const fillMat = new THREE.ShaderMaterial({
    uniforms, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
    vertexShader: H + `
      attribute float aTop;
      void main(){
        vec3 p = position; p.y = aTop > 0.5 ? hgt(p.xz) - 0.015 : -1.2;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p,1.0);
      }`,
    fragmentShader: 'void main(){ gl_FragColor = vec4(0.027,0.043,0.063,1.0); }',
  });

  const ROWS = 52, COLS = 260, W = 24, Z0 = -7, Z1 = 6;
  const group = new THREE.Group();
  for (let r = 0; r < ROWS; r++) {
    const z = Z0 + (Z1 - Z0) * (r / (ROWS - 1));
    const lp = new Float32Array(COLS * 3), fp = new Float32Array(COLS * 6), top = new Float32Array(COLS * 2), idx = [];
    for (let c = 0; c < COLS; c++) {
      const x = -W / 2 + (W * c) / (COLS - 1);
      lp.set([x, 0, z], c * 3);
      fp.set([x, 0, z, x, 0, z], c * 6);
      top[c * 2] = 1; top[c * 2 + 1] = 0;
      if (c < COLS - 1) { const a = c * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    }
    const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.BufferAttribute(lp, 3));
    const fg = new THREE.BufferGeometry(); fg.setAttribute('position', new THREE.BufferAttribute(fp, 3)); fg.setAttribute('aTop', new THREE.BufferAttribute(top, 1)); fg.setIndex(idx);
    const line = new THREE.Line(lg, lineMat); line.frustumCulled = false; line.renderOrder = 2;
    const fill = new THREE.Mesh(fg, fillMat); fill.frustumCulled = false; fill.renderOrder = 1;
    group.add(fill, line);
  }
  scene.add(group);

  const mouse = { x: 0, y: 0, tx: 0, ty: 0 };
  const onMove = (e) => {
    if (e.pointerType !== 'mouse') return;
    const r = canvas.getBoundingClientRect();
    mouse.tx = ((e.clientX - r.left) / r.width - 0.5) * 2;
    mouse.ty = ((e.clientY - r.top) / r.height - 0.5) * 2;
  };
  window.addEventListener('pointermove', onMove, { passive: true });

  const resize = () => {
    const w = canvas.clientWidth || 1, h = canvas.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.fov = w / h < 1.2 ? 48 : 34;
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize); ro.observe(canvas); resize();

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let visible = true, raf = 0;
  const t0 = performance.now();

  function frame(now) {
    const t = (now - t0) / 1000;
    uniforms.uTime.value = t;
    uniforms.uScan.value = ((t * 3.2) % 34) - 17;
    mouse.x += (mouse.tx - mouse.x) * 0.05; mouse.y += (mouse.ty - mouse.y) * 0.05;
    camera.position.set(mouse.x * 1.6, 4.6 - mouse.y * 0.8, 12.5);
    camera.lookAt(0, 0.35, 0);
    group.rotation.y = Math.sin(t * 0.08) * 0.12;
    renderer.render(scene, camera);
  }
  function loop(now) { frame(now); raf = visible ? requestAnimationFrame(loop) : 0; }

  const io = new IntersectionObserver(([e]) => {
    visible = e.isIntersecting;
    if (visible && !raf && !reduce) raf = requestAnimationFrame(loop);
  });
  io.observe(canvas);
  if (reduce) frame(t0 + 4000); else raf = requestAnimationFrame(loop);

  return () => {
    cancelAnimationFrame(raf); ro.disconnect(); io.disconnect();
    window.removeEventListener('pointermove', onMove);
    group.traverse((o) => o.geometry && o.geometry.dispose());
    lineMat.dispose(); fillMat.dispose(); renderer.dispose();
  };
}
