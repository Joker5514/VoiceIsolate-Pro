/* VoiceIsolate-Pro design mockups: deterministic signal renderer.
   Everything drawn here comes from one scene model (voices, whispers, TV,
   HVAC, hum, transients, room tail) so waveform, spectrogram, lanes and
   FFT agree with each other. Mockup-only: not product code. */
(function () {
  'use strict';
  const VIP = (window.VIP = {});

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  VIP.rng = mulberry32;

  function setup(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const r = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(r.width * dpr));
    canvas.height = Math.max(1, Math.round(r.height * dpr));
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w: r.width, h: r.height, dpr, W: canvas.width, H: canvas.height };
  }
  VIP.setup = setup;

  const VOWELS = [[730, 1090], [270, 2290], [530, 1840], [570, 840], [440, 1020], [660, 1720], [300, 870]];
  const db2p = (db) => Math.pow(10, db / 10);
  const db2a = (db) => Math.pow(10, db / 20);

  function syllables(R, segs, rate) {
    const out = [];
    for (const [s, e] of segs) {
      let t = s + 0.02;
      while (t < e - 0.08) {
        const d = Math.min((0.14 + R() * 0.22) * rate, e - t);
        out.push({ t, d, a: 0.5 + R() * 0.5, f0: 0, slope: (R() - 0.5) * 0.08, fric: R() < 0.3, vw: (R() * VOWELS.length) | 0, r: R() });
        t += d + (R() < 0.13 ? 0.12 + R() * 0.3 : 0.006 + R() * 0.03);
      }
    }
    return out;
  }

  VIP.makeScene = function (def) {
    const R = mulberry32(def.seed || 7);
    const sc = {
      voices: [], whispers: [], tv: def.tv || null, chords: [],
      hvac: def.hvac ?? -60, hum: def.hum ?? -44, floor: def.floor ?? -94,
      transients: def.transients || [], rt60: def.rt60 ?? 0.55,
    };
    for (const v of def.voices || []) {
      const syl = syllables(R, v.segs, v.rate || 1);
      syl.forEach((s) => { s.f0 = v.f0 * (0.97 + s.r * 0.06); });
      sc.voices.push(Object.assign({}, v, { syl, ph1: R() * 6.28, ph2: R() * 6.28 }));
    }
    for (const w of def.whispers || []) {
      sc.whispers.push(Object.assign({ level: -54, amp: 0.1 }, w, { syl: syllables(R, w.segs, 1.2) }));
    }
    if (sc.tv) {
      const notes = [110, 123.5, 146.8, 164.8, 196, 220, 246.9, 293.7, 329.6, 392];
      for (let t = sc.tv.from ?? 0; t < (sc.tv.to ?? 1e4); ) {
        const d = 0.35 + R() * 0.6;
        const n = (R() * 6) | 0;
        sc.chords.push({ t, d, f: [notes[n], notes[n + 2], notes[n + 4]], a: -4 + R() * 4 });
        t += d;
        if (sc.chords.length > 4000) break;
      }
    }
    return sc;
  };

  function sylEnv(s, t) {
    const u = (t - s.t) / s.d;
    if (u <= 0 || u >= 1) return 0;
    return Math.pow(Math.sin(Math.PI * u), 0.75) * s.a;
  }
  function formantDb(f, vw) {
    const F = VOWELS[vw];
    const fs = [F[0], F[1], 2600, 3500];
    const gs = [1, 0.6, 0.18, 0.08];
    const bw = [110, 140, 200, 280];
    let a = 0.004;
    for (let i = 0; i < 4; i++) { const x = (f - fs[i]) / bw[i]; a += gs[i] / (1 + x * x); }
    return 10 * Math.log10(a);
  }
  function tvLevel(tv, t) {
    let l = tv.level;
    for (const [s, e, b] of tv.boost || []) if (t >= s && t <= e) l += b;
    return l;
  }
  function chordAt(sc, t) {
    const c = sc.chords;
    let lo = 0, hi = c.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (c[m].t <= t) lo = m; else hi = m - 1; }
    return c[lo];
  }

  /* Column spectrum in linear power, split into voice (reverb-fed), tonal and noise parts. */
  function columnSpectrum(sc, t, sp, g, out) {
    const { N, freqOf, rowOf, sigma } = sp;
    const Pv = out.Pv, Pt = out.Pt, Pn = out.Pn;
    Pv.fill(0); Pt.fill(0); Pn.fill(0);
    const addLine = (A, f, p, s) => {
      const c = rowOf(f); const ss = s || sigma;
      const r0 = Math.max(0, Math.floor(c - 3 * ss)), r1 = Math.min(N - 1, Math.ceil(c + 3 * ss));
      for (let r = r0; r <= r1; r++) { const x = (r - c) / ss; A[r] += p * Math.exp(-0.5 * x * x); }
    };
    const addBand = (A, f1, f2, fn) => {
      const r0 = Math.max(0, Math.floor(rowOf(f2))), r1 = Math.min(N - 1, Math.ceil(rowOf(f1)));
      for (let r = r0; r <= r1; r++) A[r] += fn(freqOf[r]);
    };
    // noise floor
    for (let r = 0; r < N; r++) Pn[r] += db2p(sc.floor - 2.4 * Math.log2(freqOf[r] / 1000) + (g.floor || 0));
    // hvac
    if (g.hvac > -90) {
      const mod = 1.2 * Math.sin(t * 0.9) + 0.6 * Math.sin(t * 2.3);
      addBand(Pn, 25, 900, (f) => db2p(sc.hvac + mod + g.hvac - 9 * Math.max(0, Math.log2(f / 160)) - (f < 60 ? 6 : 0)));
      addBand(Pn, 600, 7000, (f) => db2p(sc.hvac - 16 + g.hvac - 3 * Math.log2(f / 600)));
    }
    // hum
    if (g.hum > -90) {
      const hl = [0, -5, -13, -18, -24, -30];
      for (let k = 1; k <= 6; k++) addLine(Pt, 60 * k, db2p(sc.hum + hl[k - 1] + g.hum), sigma * 0.55);
    }
    // tv bleed
    if (sc.tv && g.tv > -90 && t >= (sc.tv.from ?? 0) && t <= (sc.tv.to ?? 1e9)) {
      const L = tvLevel(sc.tv, t) + g.tv;
      const ch = chordAt(sc, t);
      for (const f of ch.f) for (let h = 1; h <= 9; h++) addLine(Pt, f * h, db2p(L + ch.a - 5.5 * (h - 1) - (f * h > 3000 ? 10 : 0)), sigma * 0.8);
      addBand(Pn, 220, 4200, (f) => db2p(L - 13 - 4 * Math.abs(Math.log2(f / 900))));
    }
    // voices
    for (const v of sc.voices) {
      const gv = g[v.id] ?? 0;
      if (gv < -90) continue;
      for (const s of v.syl) {
        if (t < s.t || t > s.t + s.d) continue;
        const e = sylEnv(s, t); if (e < 0.003) continue;
        const u = (t - s.t) / s.d;
        const eDb = 20 * Math.log10(e);
        const f0 = s.f0 * (1 + 0.11 * Math.sin(1.7 * t + v.ph1) + 0.05 * Math.sin(4.3 * t + v.ph2)) * (1 + s.slope * (u - 0.5));
        for (let h = 1; h * f0 < 7600; h++) {
          const f = h * f0;
          const db = v.level + eDb + formantDb(f, s.vw) - 6.5 * Math.max(0, Math.log2(f / 220)) + gv;
          addLine(Pv, f, db2p(db));
        }
        if (s.fric && u > 0.58) addBand(Pn, 3000, 11000, (f) => db2p(v.level - 24 + eDb + gv - 2 * Math.abs(Math.log2(f / 5500))));
      }
    }
    // whispers
    for (const w of sc.whispers) {
      const gw = g.whisper ?? 0;
      if (gw < -90) continue;
      for (const s of w.syl) {
        if (t < s.t || t > s.t + s.d) continue;
        const e = sylEnv(s, t); if (e < 0.003) continue;
        const eDb = 20 * Math.log10(e);
        addBand(Pn, 500, 8500, (f) => db2p(w.level + eDb + gw + formantDb(f, s.vw) - 3 * Math.max(0, Math.log2(f / 1200))));
      }
    }
    // transients
    for (const tt of sc.transients) {
      const dt = t - tt.t;
      if (dt < -0.004 || dt > 0.18) continue;
      const L = (tt.level ?? -34) - Math.max(0, dt) / 0.18 * 34 + (g.transient ?? 0);
      addBand(Pn, 70, 16000, (f) => db2p(L - 2 * Math.abs(Math.log2(f / 2500))));
    }
  }

  function makeLUT(stops) {
    const lut = new Uint8ClampedArray(256 * 3);
    const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
    const st = stops.map(([p, c]) => [p, hex(c)]);
    for (let i = 0; i < 256; i++) {
      const p = i / 255;
      let k = 0; while (k < st.length - 2 && p > st[k + 1][0]) k++;
      const [p0, c0] = st[k], [p1, c1] = st[k + 1];
      const u = Math.min(1, Math.max(0, (p - p0) / (p1 - p0)));
      for (let j = 0; j < 3; j++) lut[i * 3 + j] = c0[j] + (c1[j] - c0[j]) * u;
    }
    return lut;
  }
  VIP.CMAP_CYAN = [[0, '#04070b'], [0.2, '#06111c'], [0.38, '#0a2438'], [0.53, '#0d4a64'], [0.66, '#11829a'], [0.78, '#2ccbdc'], [0.9, '#b4f3f8'], [1, '#ffffff']];
  VIP.CMAP_THERMAL = [[0, '#030509'], [0.22, '#0d0b25'], [0.4, '#3a0f4d'], [0.55, '#7a1d55'], [0.68, '#c23848'], [0.8, '#f2744a'], [0.91, '#fdc27a'], [1, '#fff7e6']];

  function gainsAt(o, t) {
    if (o.split != null && o.gainsAfter) {
      const k = Math.min(1, Math.max(0, (t - o.split) / (o.splitFade || 0.6)));
      if (k <= 0) return o.gains || {};
      const a = o.gains || {}, b = o.gainsAfter, m = {};
      const keys = new Set(Object.keys(a).concat(Object.keys(b)));
      for (const key of keys) m[key] = (a[key] || 0) * (1 - k) + (b[key] || 0) * k;
      return m;
    }
    return o.gains || {};
  }
  const G0 = { floor: 0, hvac: 0, hum: 0, tv: 0, whisper: 0, transient: 0, reverb: 0 };

  VIP.drawSpectrogram = function (canvas, sc, o) {
    const { ctx, W, H, dpr } = setup(canvas);
    const fmin = o.fmin || 40, fmax = o.fmax || 20000, L = Math.log(fmax / fmin);
    const freqOf = new Float32Array(H);
    for (let r = 0; r < H; r++) freqOf[r] = fmin * Math.exp(L * (1 - (r + 0.5) / H));
    const sp = { N: H, freqOf, rowOf: (f) => H * (1 - Math.log(f / fmin) / L), sigma: 0.75 * dpr };
    const buf = { Pv: new Float32Array(H), Pt: new Float32Array(H), Pn: new Float32Array(H) };
    const tail = new Float32Array(H).fill(-200);
    const R = mulberry32(o.seed || 11);
    const lut = makeLUT(o.cmap || VIP.CMAP_CYAN);
    const dbMin = o.dbMin ?? -98, dbMax = o.dbMax ?? -24, span = dbMax - dbMin;
    const dt = (o.t1 - o.t0) / W;
    const img = ctx.createImageData(W, H), d = img.data;
    for (let x = 0; x < W; x++) {
      const t = o.t0 + (x + 0.5) * dt;
      const g = Object.assign({}, G0, gainsAt(o, t));
      columnSpectrum(sc, t, sp, g, buf);
      const rt = sc.rt60 * db2a((g.reverb || 0) * 0.5);
      const decay = (60 / Math.max(0.05, rt)) * dt;
      for (let r = 0; r < H; r++) {
        const n = buf.Pn[r] * 0.5 * (-Math.log(R() + 1e-9) - Math.log(R() + 1e-9));
        const v = buf.Pv[r] * (0.75 + 0.5 * R());
        const vDb = 10 * Math.log10(v + 1e-14);
        tail[r] = Math.max(tail[r] - decay, vDb);
        const rv = (g.reverb || 0) < -40 ? 0 : db2p(tail[r] - 9 + (g.reverb || 0) * 0.4);
        const p = v + buf.Pt[r] * (0.85 + 0.3 * R()) + n + rv;
        let q = (10 * Math.log10(p + 1e-14) - dbMin) / span;
        q = q < 0 ? 0 : q > 1 ? 1 : q;
        const li = ((q * 255) | 0) * 3, i = (r * W + x) * 4;
        d[i] = lut[li]; d[i + 1] = lut[li + 1]; d[i + 2] = lut[li + 2]; d[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return { fmin, fmax, freqToY: (f) => canvas.getBoundingClientRect().height * (1 - Math.log(f / fmin) / L) };
  };

  /* Linear amplitude of one source (or 'mix') at time t. */
  function srcAmp(sc, id, t, g) {
    let a2 = 0;
    const want = (k) => id === 'mix' || id === k;
    for (const v of sc.voices) {
      if (!want(v.id)) continue;
      let e = 0; for (const s of v.syl) { const x = sylEnv(s, t); if (x > e) e = x; }
      const a = v.amp * e * db2a(g[v.id] || 0); a2 += a * a;
    }
    if (want('whisper')) for (const w of sc.whispers) {
      let e = 0; for (const s of w.syl) { const x = sylEnv(s, t); if (x > e) e = x; }
      const a = w.amp * e * db2a(g.whisper || 0); a2 += a * a;
    }
    if (sc.tv && want('tv') && t >= (sc.tv.from ?? 0) && t <= (sc.tv.to ?? 1e9)) {
      const a = (sc.tv.amp || 0.05) * db2a(tvLevel(sc.tv, t) - sc.tv.level + (g.tv || 0)) * (0.7 + 0.18 * Math.sin(t * 11) + 0.12 * Math.sin(t * 2.7)); a2 += a * a;
    }
    if (want('hvac')) { const a = 0.028 * (1 + 0.25 * Math.sin(t * 0.9) + 0.12 * Math.sin(t * 2.3)) * db2a(g.hvac || 0); a2 += a * a; }
    if (want('hum')) { const a = 0.018 * db2a(g.hum || 0); a2 += a * a; }
    if (want('transient')) for (const tt of sc.transients) {
      const dt = t - tt.t; if (dt < 0 || dt > 0.2) continue;
      const a = (tt.amp || 0.6) * Math.exp(-dt / 0.035) * db2a(g.transient || 0); a2 += a * a;
    }
    return Math.sqrt(a2);
  }
  VIP.srcAmp = (sc, id, t, g) => srcAmp(sc, id, t, Object.assign({}, G0, g || {}));

  VIP.drawWaveform = function (canvas, sc, o) {
    const { ctx, W, H, dpr } = setup(canvas);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const R = mulberry32(o.seed || 5);
    const dt = (o.t1 - o.t0) / W;
    const mid = H * (o.center ?? 0.5), scale = H * (o.scale ?? 0.46);
    if (o.centerLine !== false) { ctx.fillStyle = o.centerLine || 'rgba(255,255,255,0.08)'; ctx.fillRect(0, Math.round(mid), W, Math.max(1, dpr * 0.5)); }
    let prev = 0;
    for (let x = 0; x < W; x++) {
      const t = o.t0 + (x + 0.5) * dt;
      const g = gainsAt(o, t);
      const after = o.split != null && t > o.split;
      let a = srcAmp(sc, o.source || 'mix', t, Object.assign({}, G0, g));
      a = Math.min(0.98, a * (o.gain || 1));
      let pk = a * (0.62 + 0.38 * R()) + 0.004 * R();
      pk = 0.55 * pk + 0.45 * prev; prev = pk;
      const up = pk * (0.9 + 0.2 * R()), dn = pk * (0.9 + 0.2 * R());
      ctx.fillStyle = after && o.colorAfter ? o.colorAfter : o.color || 'rgba(170,220,255,0.55)';
      ctx.fillRect(x, mid - up * scale, 1, (up + dn) * scale + 1);
      if (o.rms !== false) {
        const rm = pk * 0.52;
        ctx.fillStyle = after && o.rmsAfter ? o.rmsAfter : o.rmsColor || 'rgba(230,248,255,0.85)';
        ctx.fillRect(x, mid - rm * scale, 1, rm * 2 * scale + 1);
      }
    }
  };

  /* Activity lane: energy of one source over time. */
  VIP.drawLane = function (canvas, sc, id, color, o) {
    const { ctx, W, H } = setup(canvas);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const dt = (o.t1 - o.t0) / W, mid = H / 2;
    const ref = o.ref || 0.6;
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    ctx.fillRect(0, mid, W, 1);
    let prev = 0;
    for (let x = 0; x < W; x++) {
      const t = o.t0 + (x + 0.5) * dt;
      let a = srcAmp(sc, id, t, Object.assign({}, G0, o.gains || {}));
      if (o.floor) a = Math.max(0, a - o.floor);
      let v = Math.min(1, Math.sqrt(a / ref));
      v = 0.5 * v + 0.5 * prev; prev = v;
      if (v < 0.02) continue;
      ctx.globalAlpha = 0.25 + 0.75 * v;
      ctx.fillStyle = color;
      const hh = v * (H * 0.44);
      ctx.fillRect(x, mid - hh, 1, hh * 2);
    }
    ctx.globalAlpha = 1;
  };

  /* Averaged spectrum for FFT panels. Returns {f:[], db:[]} at N log-spaced points. */
  VIP.spectrumAt = function (sc, t, o) {
    const N = o.N || 400, fmin = o.fmin || 20, fmax = o.fmax || 20000, L = Math.log(fmax / fmin);
    const freqOf = new Float32Array(N);
    for (let r = 0; r < N; r++) freqOf[r] = fmin * Math.exp(L * (1 - (r + 0.5) / N));
    const sp = { N, freqOf, rowOf: (f) => N * (1 - Math.log(f / fmin) / L), sigma: 0.9 };
    const buf = { Pv: new Float32Array(N), Pt: new Float32Array(N), Pn: new Float32Array(N) };
    const acc = new Float32Array(N);
    const g = Object.assign({}, G0, o.gains || {});
    const K = o.avg || 24;
    for (let k = 0; k < K; k++) {
      columnSpectrum(sc, t - 0.25 + (0.5 * k) / K, sp, g, buf);
      for (let r = 0; r < N; r++) acc[r] += buf.Pv[r] + buf.Pt[r] + buf.Pn[r];
    }
    const f = [], db = [];
    for (let r = N - 1; r >= 0; r--) { f.push(freqOf[r]); db.push(10 * Math.log10(acc[r] / K + 1e-14)); }
    return { f, db, fmin, fmax };
  };

  VIP.drawPhase = function (canvas, o) {
    const { ctx, w, h } = setup(canvas);
    const R = mulberry32(o.seed || 3);
    const cx = w / 2, cy = h / 2, rad = Math.min(w, h) * 0.44;
    ctx.strokeStyle = 'rgba(255,255,255,0.07)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(cx, cy - rad); ctx.lineTo(cx + rad, cy); ctx.lineTo(cx, cy + rad); ctx.lineTo(cx - rad, cy); ctx.closePath(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx, cy - rad); ctx.lineTo(cx, cy + rad); ctx.moveTo(cx - rad, cy); ctx.lineTo(cx + rad, cy); ctx.stroke();
    ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(cx - rad * 0.5, cy - rad * 0.5); ctx.lineTo(cx + rad * 0.5, cy + rad * 0.5); ctx.moveTo(cx + rad * 0.5, cy - rad * 0.5); ctx.lineTo(cx - rad * 0.5, cy + rad * 0.5); ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = '600 9px Inter, sans-serif'; ctx.fillStyle = 'rgba(167,180,194,0.85)'; ctx.textAlign = 'center';
    ctx.fillText('M', cx, cy - rad - 4); ctx.fillText('S', cx + rad + 8, cy + 3);
    ctx.fillText('L', cx - rad * 0.55 - 6, cy - rad * 0.55); ctx.fillText('R', cx + rad * 0.55 + 6, cy - rad * 0.55);
    const gauss = () => { let s = 0; for (let i = 0; i < 4; i++) s += R(); return (s - 2) * 0.87; };
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 9000; i++) {
      const m = gauss() * 0.3 * (R() < 0.15 ? 1.8 : 1), s = gauss() * 0.06;
      const x = cx + s * rad * 1.2, y = cy - m * rad * 0.95;
      ctx.fillStyle = 'rgba(46,213,229,0.10)';
      ctx.fillRect(x, y, 1.2, 1.2);
    }
    ctx.globalCompositeOperation = 'source-over';
  };

  /* Small line/area chart helper. pts: array of [x0..1, y0..1]. */
  VIP.drawCurve = function (canvas, series) {
    const { ctx, w, h } = setup(canvas);
    for (const s of series) {
      ctx.beginPath();
      s.pts.forEach(([x, y], i) => { const X = x * w, Y = (1 - y) * h; i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); });
      if (s.fill) {
        ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
        const gr = ctx.createLinearGradient(0, 0, 0, h);
        gr.addColorStop(0, s.fill); gr.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = gr; ctx.fill();
        ctx.beginPath();
        s.pts.forEach(([x, y], i) => { const X = x * w, Y = (1 - y) * h; i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); });
      }
      ctx.strokeStyle = s.color; ctx.lineWidth = s.width || 1.25;
      if (s.dash) ctx.setLineDash(s.dash);
      ctx.stroke(); ctx.setLineDash([]);
    }
    return { ctx, w, h };
  };

  /* Time ruler ticks into an element (HTML labels stay crisp). */
  VIP.ruler = function (el, t0, t1, major, minor, fmt) {
    const w = el.getBoundingClientRect().width;
    const html = [];
    const first = Math.ceil(t0 / minor) * minor;
    for (let t = first; t <= t1 + 1e-9; t += minor) {
      const x = ((t - t0) / (t1 - t0)) * w;
      const isMaj = Math.abs(t / major - Math.round(t / major)) < 1e-6;
      html.push(`<i class="tk${isMaj ? ' mj' : ''}" style="left:${x.toFixed(1)}px"></i>`);
      if (isMaj) html.push(`<span class="tl" style="left:${x.toFixed(1)}px">${fmt(t)}</span>`);
    }
    el.insertAdjacentHTML('beforeend', html.join(''));
  };
  VIP.mmss = (t, dec) => {
    const m = Math.floor(t / 60), s = t - m * 60;
    return `${String(m).padStart(2, '0')}:${(dec ? s.toFixed(dec) : String(Math.round(s))).padStart(dec ? 3 + dec : 2, '0')}`;
  };

  const ICONS = {
    play: '<path d="M8 5.5v13l10.5-6.5z" fill="currentColor" stroke="none"/>',
    pause: '<rect x="7" y="5.5" width="3.6" height="13" rx="1" fill="currentColor" stroke="none"/><rect x="13.4" y="5.5" width="3.6" height="13" rx="1" fill="currentColor" stroke="none"/>',
    stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="1.5" fill="currentColor" stroke="none"/>',
    prev: '<path d="M7 6v12M18 6l-8.5 6 8.5 6z" fill="currentColor"/>',
    next: '<path d="M17 6v12M6 6l8.5 6L6 18z" fill="currentColor"/>',
    loop: '<path d="M17 2.5l3 3-3 3"/><path d="M4 11.5v-2a4 4 0 0 1 4-4h12"/><path d="M7 21.5l-3-3 3-3"/><path d="M20 12.5v2a4 4 0 0 1-4 4H4"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    help: '<circle cx="12" cy="12" r="9.5"/><path d="M9.3 9.2a2.8 2.8 0 0 1 5.4 1c0 1.9-2.7 2.6-2.7 2.6"/><circle cx="12" cy="17" r=".6" fill="currentColor"/>',
    eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    eyeoff: '<path d="M3 3l18 18"/><path d="M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3 3.9M6.6 6.6A17 17 0 0 0 2 12s3.6 7 10 7a9.6 9.6 0 0 0 5.4-1.6"/>',
    lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7.5a4 4 0 0 1 8 0V11"/>',
    unlock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7.5a4 4 0 0 1 7.7-1.5"/>',
    speaker: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor" fill-opacity=".15"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
    mute: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor" fill-opacity=".15"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>',
    shield: '<path d="M12 2.8l7.5 3v5.7c0 4.6-3.2 8.3-7.5 9.7-4.3-1.4-7.5-5.1-7.5-9.7V5.8z"/><path d="M8.7 12.2l2.3 2.3 4.4-4.6"/>',
    shieldp: '<path d="M12 2.8l7.5 3v5.7c0 4.6-3.2 8.3-7.5 9.7-4.3-1.4-7.5-5.1-7.5-9.7V5.8z"/>',
    chip: '<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5" rx=".8"/><path d="M9 2.5V6M15 2.5V6M9 18v3.5M15 18v3.5M2.5 9H6M2.5 15H6M18 9h3.5M18 15h3.5"/>',
    wave: '<path d="M3 12h1.5M6 8.5v7M9 5v14M12 9v6M15 6.5v11M18 9.5v5M21 12h-1.5"/>',
    cursor: '<path d="M5 3.5l13 6.2-5.6 1.9-2 5.7z"/>',
    timesel: '<path d="M4 4v16M20 4v16"/><path d="M8 12h8M10.5 9.5L8 12l2.5 2.5M13.5 9.5L16 12l-2.5 2.5"/>',
    brush: '<path d="M14.5 4.5l5 5-8.5 8.5-5-5z"/><path d="M6 13l-2.5 6.5L10 17"/>',
    lasso: '<ellipse cx="12" cy="9" rx="8.5" ry="5.5"/><path d="M6.5 13.2c-1 1.6-.4 3.8 1.5 4.3 1.6.4 2.2 2 1.4 3.5"/>',
    wand: '<path d="M4 20L15 9"/><path d="M14 4.5v3M12.5 6h3M19 10v3M17.5 11.5h3M18.5 3.5v2M17.5 4.5h2"/><path d="M13 8l3 3"/>',
    zoomin: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5l5 5M10.5 7.5v6M7.5 10.5h6"/>',
    zoomout: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5l5 5M7.5 10.5h6"/>',
    fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
    export: '<path d="M12 15V3.5M7.5 8L12 3.5 16.5 8"/><path d="M4.5 14v4.5a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V14"/>',
    history: '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1"/><path d="M3.5 4v4.5H8"/><path d="M12 7.5V12l3 2"/>',
    compare: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M12 3v18"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    chev: '<path d="M9 6l6 6-6 6"/>',
    chevd: '<path d="M6 9l6 6 6-6"/>',
    folder: '<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.2h7a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
    spark: '<path d="M12 3.5l1.8 5 5 1.8-5 1.8-1.8 5-1.8-5-5-1.8 5-1.8z"/><path d="M19 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>',
    target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1" fill="currentColor"/>',
    minus: '<path d="M5 12h14"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    grip: '<circle cx="9" cy="7" r=".9" fill="currentColor"/><circle cx="15" cy="7" r=".9" fill="currentColor"/><circle cx="9" cy="12" r=".9" fill="currentColor"/><circle cx="15" cy="12" r=".9" fill="currentColor"/><circle cx="9" cy="17" r=".9" fill="currentColor"/><circle cx="15" cy="17" r=".9" fill="currentColor"/>',
    layers: '<path d="M12 3.5l9 4.8-9 4.8-9-4.8z"/><path d="M3 12.5l9 4.8 9-4.8"/><path d="M3 16.5l9 4.8 9-4.8"/>',
    snap: '<path d="M6 4v9a6 6 0 0 0 12 0V4"/><path d="M6 8h4M14 8h4"/>',
    undo: '<path d="M8 6L3.5 10.5 8 15"/><path d="M4 10.5h10a6 6 0 0 1 0 12h-3"/>',
    redo: '<path d="M16 6l4.5 4.5L16 15"/><path d="M20 10.5H10a6 6 0 0 0 0 12h3"/>',
    marker: '<path d="M6 3.5h12v12l-6 5-6-5z"/>',
    cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2.5V6M15 2.5V6M9 18v3.5M15 18v3.5M2.5 9H6M2.5 15H6M18 9h3.5M18 15h3.5"/>',
    send: '<path d="M4 12l16-8-6 16-2.5-6.5z"/>',
    dot3: '<circle cx="6" cy="12" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><circle cx="18" cy="12" r="1.2" fill="currentColor"/>',
    headphones: '<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="4.5" height="6.5" rx="1.5"/><rect x="16.5" y="14" width="4.5" height="6.5" rx="1.5"/>',
    power: '<path d="M12 3v8"/><path d="M6.4 6.9a7.5 7.5 0 1 0 11.2 0"/>',
  };
  VIP.icons = function (root) {
    (root || document).querySelectorAll('[data-i]').forEach((el) => {
      const n = el.getAttribute('data-i');
      el.innerHTML = `<svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICONS[n] || ''}</svg>`;
    });
  };

  /* Shared shell: top bar + optional transport. */
  VIP.shell = function (page) {
    const nav = ['Explain', 'Stems', 'Engineer'].map((n) => `<a class="${n.toLowerCase() === page ? 'on' : ''}">${n}</a>`).join('');
    document.getElementById('topbar').innerHTML = `
      <div class="tb-left">
        <div class="logo"><span class="mark"><svg viewBox="0 0 28 28" width="26" height="26"><defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff5a66"/><stop offset="1" stop-color="#b3121f"/></linearGradient></defs><rect x="1" y="1" width="26" height="26" rx="7" fill="#11161d" stroke="rgba(255,255,255,.08)"/><path d="M6 14h2.2M9.6 10.5v7M13 7v14M16.4 10v8M19.8 12.4v3.2" stroke="#e9eef4" stroke-width="1.9" stroke-linecap="round"/><path d="M5 20.5L23 7.5" stroke="url(#lg)" stroke-width="2.2" stroke-linecap="round"/></svg></span><span class="wm">VoiceIsolate<span>-Pro</span></span></div>
        <nav class="mainnav">${nav}</nav>
        <div class="utilnav"><a><i data-i="compare"></i>Compare</a><a><i data-i="history"></i>History</a><a><i data-i="export"></i>Export</a></div>
      </div>
      <div class="tb-center"><div class="file"><i data-i="wave"></i><span class="fname">Interview_042.wav</span><span class="fstate">Saved</span></div><div class="fmeta">48 kHz <b>•</b> 24-bit <b>•</b> Stereo <b>•</b> 12:48</div></div>
      <div class="tb-right">
        <div class="privacy"><i data-i="shield"></i><span><b>100% LOCAL</b> • AUDIO NEVER LEAVES DEVICE</span></div>
        <div class="engine"><span class="led"></span>LOCAL ENGINE</div>
        <div class="loads"><div><span>CPU</span><em><s style="width:16%"></s></em><b>16%</b></div><div><span>GPU</span><em><s style="width:27%"></s></em><b>27%</b></div></div>
        <div class="model"><i data-i="chip"></i><div><b>Models ready</b><span>SHA-256 verified • WebGPU</span></div></div>
        <button class="ib"><i data-i="gear"></i></button><button class="ib"><i data-i="help"></i></button>
      </div>`;
  };

  VIP.transport = function (el, opts) {
    const o = Object.assign({ time: '02:17.364', total: '12:48.000', pos: 0.179, right: '' }, opts || {});
    el.innerHTML = `
      <div class="tp-btns">
        <button class="tb" title="Previous"><i data-i="prev"></i></button>
        <button class="tb" title="Stop"><i data-i="stop"></i></button>
        <button class="tb play" title="Play"><i data-i="play"></i></button>
        <button class="tb" title="Pause"><i data-i="pause"></i></button>
        <button class="tb" title="Next"><i data-i="next"></i></button>
        <span class="sep"></span>
        <button class="tb on" title="Loop selection"><i data-i="loop"></i></button>
        <button class="speed">1.00×<i data-i="chevd"></i></button>
      </div>
      <div class="tp-time"><b>${o.time}</b><span>/ ${o.total}</span></div>
      <div class="tp-scrub"><div class="scr-track"><canvas class="scr-wave"></canvas><div class="scr-loop" style="left:${(o.pos * 100 - 0.4).toFixed(2)}%;width:0.75%"></div><div class="scr-head" style="left:${(o.pos * 100).toFixed(2)}%"></div></div><div class="scr-lbl"><span>00:00</span><span>Loop 02:14.2 – 02:19.8</span><span>12:48</span></div></div>
      <div class="ab"><button class="abA"><em>A</em>ORIGINAL</button><button class="abB on"><em>B</em>PROCESSED</button><span class="abhint">Hold <kbd>⌥</kbd> for A</span></div>
      <div class="outlvl"><span class="ol-lbl">OUT</span><div class="ol-meters"><div class="olm"><s style="width:71%"></s><u style="left:78%"></u></div><div class="olm"><s style="width:68%"></s><u style="left:76%"></u></div><div class="ol-scale"><span>-60</span><span>-36</span><span>-18</span><span>-6</span><span>0</span></div></div><b class="ol-pk">-6.2<small>dBTP</small></b></div>
      ${o.right}`;
    // overview waveform for whole file
    const c = el.querySelector('.scr-wave');
    const sc = VIP.makeScene({ seed: 99, voices: [{ id: 'a', f0: 118, level: -30, amp: 0.7, segs: segsFor(0, 768, 7, 0.62) }, { id: 'b', f0: 205, level: -40, amp: 0.32, segs: segsFor(3, 768, 11, 0.3) }], tv: { level: -60, amp: 0.06 } });
    VIP.drawWaveform(c, sc, { t0: 0, t1: 768, color: 'rgba(141,160,180,0.38)', rmsColor: 'rgba(190,206,222,0.55)', scale: 0.48, gain: 1.1, centerLine: false });
  };
  function segsFor(seed, len, avg, density) {
    const R = mulberry32(seed + 1); const out = []; let t = R() * 3;
    while (t < len) { const d = avg * (0.4 + R()); if (R() < density) out.push([t, Math.min(len, t + d)]); t += d + 0.4 + R() * 1.6; }
    return out;
  }
  VIP.segsFor = segsFor;
})();
