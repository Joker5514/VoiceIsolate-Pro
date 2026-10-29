/**
 * Landing v3 presentation layer: hero sculpture drift, scroll-in tilt, section nav state.
 * Decorative only. Never touches audio, the mixer or the ML pipeline.
 */
const $ = (id) => document.getElementById(id);

/**
 * The hero sculpture (Signal Glass L2) is static SVG in index.html, which is
 * also the still for reduced motion, Save-Data, 2G, offline and CONSTRAINED
 * devices. HeroSculpture.js adds the 12 s drift and may lazy-load the 3D render;
 * if it cannot load, the still stays and the rest of this file still runs.
 */
async function mountHeroStage() {
  const stage = $('heroStage');
  if (!stage || !stage.classList.contains('v3-sculpture')) return;
  try {
    const { mountHeroSculpture } = await import('/src/presentation/HeroSculpture.js');
    mountHeroSculpture(stage);
  } catch (err) {
    console.warn('[VIP][v3] hero sculpture stays still', err);
  }
}

/** Panels stay flat. The only tilt is the lens drawn inside the hero picture. */
function wireScrollTilt() {
  // Intentionally no scroll rotateX. A tilted panel is not part of this shell.
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
