/* ── VoiceIsolate Pro · Cinematic marketing layer ───────────────────────────
   Shared behavior for /, /stems/, /engineer/.
   Standalone: NO app capabilities (no models, workers, worklets, app.js).
   Strict-CSP safe: external file only, no inline handlers. */
(function () {
  'use strict';

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* Fixed nav scroll state */
  var nav = document.querySelector('.cine-nav');
  function onScrollNav() {
    if (!nav) return;
    nav.classList.toggle('is-scrolled', window.scrollY > 40);
  }
  window.addEventListener('scroll', onScrollNav, { passive: true });
  onScrollNav();

  /* Scroll reveals */
  var revealEls = document.querySelectorAll('.cine-reveal');
  if ('IntersectionObserver' in window && !reduceMotion) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target); }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });
    revealEls.forEach(function (el) { io.observe(el); });
  } else {
    revealEls.forEach(function (el) { el.classList.add('is-in'); });
  }

  /* Animated counters: <b data-count="48" data-suffix=" kHz"> */
  var counters = document.querySelectorAll('[data-count]');
  function animateCount(el) {
    var target = parseFloat(el.getAttribute('data-count'));
    var decimals = parseInt(el.getAttribute('data-decimals') || '0', 10);
    var suffix = el.getAttribute('data-suffix') || '';
    if (reduceMotion) { el.innerHTML = target.toFixed(decimals) + '<span class="u">' + suffix + '</span>'; return; }
    var start = null, dur = 1400;
    function frame(t) {
      if (!start) start = t;
      var p = Math.min((t - start) / dur, 1);
      var eased = 1 - Math.pow(1 - p, 3);
      el.innerHTML = (target * eased).toFixed(decimals) + '<span class="u">' + suffix + '</span>';
      if (p < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }
  if ('IntersectionObserver' in window) {
    var cio = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { animateCount(e.target); cio.unobserve(e.target); }
      });
    }, { threshold: 0.4 });
    counters.forEach(function (el) { cio.observe(el); });
  } else {
    counters.forEach(animateCount);
  }

  /* Hero particle drift — lightweight canvas 2D, pauses offscreen */
  function initParticles() {
    var canvas = document.querySelector('.cine-hero__particles');
    if (!canvas || reduceMotion) return;
    var ctx = canvas.getContext('2d');
    var w, h, parts = [], running = true;
    function size() {
      var r = canvas.parentElement.getBoundingClientRect();
      w = canvas.width = Math.floor(r.width);
      h = canvas.height = Math.floor(r.height);
    }
    function seed() {
      parts = [];
      var n = Math.min(90, Math.floor(w / 14));
      for (var i = 0; i < n; i++) {
        parts.push({
          x: Math.random() * w, y: Math.random() * h,
          r: 0.6 + Math.random() * 1.8,
          vx: (Math.random() - 0.5) * 0.25, vy: -0.08 - Math.random() * 0.3,
          a: 0.15 + Math.random() * 0.5,
          hue: Math.random() < 0.7 ? '58,226,255' : '139,92,246'
        });
      }
    }
    function tick() {
      if (!running) return;
      ctx.clearRect(0, 0, w, h);
      for (var i = 0; i < parts.length; i++) {
        var p = parts[i];
        p.x += p.vx; p.y += p.vy;
        if (p.y < -8) { p.y = h + 8; p.x = Math.random() * w; }
        if (p.x < -8) p.x = w + 8; if (p.x > w + 8) p.x = -8;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, 6.2832);
        ctx.fillStyle = 'rgba(' + p.hue + ',' + p.a.toFixed(2) + ')';
        ctx.fill();
      }
      requestAnimationFrame(tick);
    }
    size(); seed(); tick();
    window.addEventListener('resize', function () { size(); seed(); });
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) {
        running = entries[0].isIntersecting;
        if (running) tick();
      }).observe(canvas);
    }
    document.addEventListener('visibilitychange', function () {
      running = !document.hidden;
      if (running) tick();
    });
  }
  initParticles();

  /* Smooth anchor scroll (same-page) */
  document.addEventListener('click', function (ev) {
    var a = ev.target.closest('a[href^="#"]');
    if (!a) return;
    var id = a.getAttribute('href').slice(1);
    if (!id) return;
    var t = document.getElementById(id);
    if (!t) return;
    ev.preventDefault();
    t.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
    try { history.replaceState(null, '', '#' + id); } catch (e) { /* noop */ }
  });

  /* Decorative stem waveforms: <canvas data-wave="voice|bg"> — no audio capability */
  function initWaveforms() {
    var canvases = document.querySelectorAll('canvas[data-wave]');
    if (!canvases.length || reduceMotion) return;
    var colors = { voice: '#3ae2ff', bg: '#ff3d81' };
    canvases.forEach(function (canvas) {
      var ctx = canvas.getContext('2d'), t = Math.random() * 100;
      var color = colors[canvas.getAttribute('data-wave')] || '#3ae2ff';
      function size() {
        var r = canvas.parentElement.getBoundingClientRect();
        canvas.width = Math.max(2, Math.floor(r.width * 2));
        canvas.height = Math.max(2, Math.floor(r.height * 2));
      }
      size();
      window.addEventListener('resize', size);
      (function tick() {
        t += 0.03;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.beginPath();
        var mid = canvas.height / 2;
        for (var x = 0; x <= canvas.width; x += 6) {
          var env = Math.sin((x / canvas.width) * Math.PI);
          var y = mid + Math.sin(x * 0.02 + t) * Math.cos(x * 0.008 - t * 0.7) * mid * 0.75 * env;
          if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = color; ctx.lineWidth = 3; ctx.stroke();
        requestAnimationFrame(tick);
      })();
    });
  }
  initWaveforms();

  /* Footer year */
  document.querySelectorAll('[data-year]').forEach(function (el) {
    el.textContent = String(new Date().getFullYear());
  });
})();
