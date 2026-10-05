/**
 * Landing v3 presentation layer: hero 3D scene, scroll-in tilt, section nav state.
 * Decorative only. Never touches audio, the mixer or the ML pipeline.
 */
const $ = (id) => document.getElementById(id);
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function hasWebGL2() {
  try { return !!document.createElement('canvas').getContext('webgl2'); } catch { return false; }
}

/** CSS 3D bar field used when WebGL2 or the module load is unavailable. */
function mountFallback(host, stage) {
  const ROWS = 11, COLS = 44, W = 860, D = 380;
  const field = document.createElement('div');
  field.className = 'v3-sculpt';
  const drift = document.createElement('div');
  drift.className = 'v3-sculpt__drift';
  drift.innerHTML = '<div class="v3-sculpt__grid"></div><div class="v3-sculpt__scan"></div>';
  const frag = document.createDocumentFragment();
  for (let r = 0; r < ROWS; r++) {
    const voice = r >= 4 && r <= 6;
    for (let c = 0; c < COLS; c++) {
      const env = Math.abs(Math.sin(c / 5.5 + r * 0.6)) * (0.55 + 0.45 * Math.sin(c / 13));
      const cell = document.createElement('div');
      cell.className = 'v3-sculpt__cell';
      cell.style.left = `${(c / (COLS - 1)) * (W - 8)}px`;
      cell.style.top = `${(r / (ROWS - 1)) * D}px`;
      const bar = document.createElement('div');
      bar.className = voice ? 'v3-sculpt__bar v3-sculpt__bar--voice' : 'v3-sculpt__bar';
      bar.style.height = `${voice ? 70 + 120 * env : 18 + 46 * env}px`;
      bar.style.animationDelay = `${-(c * 0.07 + r * 0.18).toFixed(2)}s`;
      cell.appendChild(bar);
      frag.appendChild(cell);
    }
  }
  drift.appendChild(frag);
  field.appendChild(drift);
  host.appendChild(field);
  host.hidden = false;

  let tx = 0, ty = 0, raf = 0;
  const apply = () => {
    const scale = Math.min(1.25, Math.max(0.45, stage.clientWidth / 900));
    field.style.transform = `translate(-50%,-50%) scale(${scale}) rotateX(${(62 - ty * 10).toFixed(2)}deg) rotateY(${(tx * 8).toFixed(2)}deg)`;
  };
  const hero = $('home');
  hero?.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    const r = hero.getBoundingClientRect();
    tx = (e.clientX - r.left) / r.width - 0.5;
    ty = (e.clientY - r.top) / r.height - 0.5;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(apply);
  });
  hero?.addEventListener('pointerleave', () => { tx = 0; ty = 0; apply(); });
  window.addEventListener('resize', apply);
  apply();

  // Pause the 484 bar animations when the hero is offscreen or the tab is hidden.
  let onScreen = true;
  const syncPaused = () => field.classList.toggle('v3-sculpt--paused', !onScreen || document.hidden);
  new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; syncPaused(); }).observe(stage);
  document.addEventListener('visibilitychange', syncPaused);
}

async function mountHeroStage() {
  const stage = $('heroStage');
  const canvas = $('heroGl');
  const fallback = $('heroFallback');
  if (!stage || !canvas || !fallback) return;
  try {
    if (!hasWebGL2()) throw new Error('WebGL2 unavailable');
    const mod = await import('/hero-gl.js');
    await mod.mountHero(canvas);
  } catch (err) {
    console.warn('[VIP][v3] hero WebGL fallback', err);
    canvas.remove();
    mountFallback(fallback, stage);
  }
}

/** Panels start tilted back and flatten as they scroll into view. */
function wireScrollTilt() {
  const items = [
    { el: $('stemsTilt'), deg: 22, min: 0.92 },
    { el: $('engineerTilt'), deg: 26, min: 0.9 },
  ].filter((i) => i.el);
  if (!items.length || reduceMotion) return;
  let raf = 0;
  const update = () => {
    raf = 0;
    const vh = window.innerHeight;
    for (const { el, deg, min } of items) {
      const r = el.getBoundingClientRect();
      const p = Math.max(0, Math.min(1, (vh - r.top) / (vh * 0.75)));
      el.style.transform = p >= 1 ? 'none' : `rotateX(${((1 - p) * deg).toFixed(2)}deg) scale(${(min + (1 - min) * p).toFixed(3)})`;
    }
  };
  const schedule = () => { if (!raf) raf = requestAnimationFrame(update); };
  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule);
  update();
}

/** Highlight the header link for the section currently in view. */
function wireSectionNav() {
  const links = [...document.querySelectorAll('.v3-nav a[href^="#"]')];
  const sections = links.map((a) => document.querySelector(a.getAttribute('href'))).filter(Boolean);
  if (!sections.length) return;
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const id = `#${e.target.id}`;
      for (const a of links) {
        if (a.getAttribute('href') === id) a.setAttribute('aria-current', 'location');
        else a.removeAttribute('aria-current');
      }
    }
  }, { rootMargin: '-45% 0px -50% 0px' });
  sections.forEach((s) => io.observe(s));
}

function init() {
  void mountHeroStage();
  wireScrollTilt();
  wireSectionNav();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
else init();
