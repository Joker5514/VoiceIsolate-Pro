/* eslint-env browser */
/**
 * Browser-side measurement probes for the shell QA smoke.
 *
 * Injected with `page.addInitScript` and evaluated in the page, so every check
 * reads what Chromium actually rendered (computed styles, real geometry,
 * `elementFromPoint`) rather than the JS state the app believes it is in.
 * Static parsing of the stylesheets missed all six shipped defects; this file
 * exists so the guards can never drift back to asserting intent.
 */
window.__vipQA = {
  /* ── colour maths (WCAG 2.1 relative luminance) ───────────────────────── */
  srgb(c) { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); },
  lum(rgb) { return 0.2126 * this.srgb(rgb[0]) + 0.7152 * this.srgb(rgb[1]) + 0.0722 * this.srgb(rgb[2]); },
  parse(s) {
    if (!s) return null;
    const m = String(s).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  },
  over(fg, bg) {
    const a = fg.a;
    return [fg.r * a + bg[0] * (1 - a), fg.g * a + bg[1] * (1 - a), fg.b * a + bg[2] * (1 - a)];
  },
  /**
   * Resolve the set of background colours the text could actually sit on.
   *
   * A single composited colour is not enough. A `linear-gradient` paints a
   * range, and scoring against one ancestor colour can pass text that fails
   * over part of the ramp. So every parseable gradient contributes ONE
   * CANDIDATE PER COLOUR STOP, and the caller scores the worst of them: if
   * text clears AA against every stop it clears AA everywhere on that ramp.
   *
   * Only a `url()` image (real pixels this cannot see) is genuinely
   * unmeasurable, and those are reported rather than silently passed.
   */
  GRADIENT_COLOR: /rgba?\([^)]*\)|#[0-9a-f]{3,8}\b/gi,
  parseStops(bgImage) {
    if (!bgImage || bgImage === 'none') return [];
    // Real pixels — no way to score these from computed style alone.
    if (/url\(/i.test(bgImage)) return null;
    const found = bgImage.match(this.GRADIENT_COLOR) || [];
    const stops = [];
    for (const raw of found) {
      const c = raw.startsWith('#') ? this.parseHex(raw) : this.parse(raw);
      if (!c) return null;
      if (c.a > 0) stops.push(c);
    }
    return stops;
  },
  parseHex(h) {
    let v = h.slice(1);
    if (v.length === 3 || v.length === 4) v = v.split('').map((c) => c + c).join('');
    if (v.length !== 6 && v.length !== 8) return null;
    const n = parseInt(v, 16);
    if (Number.isNaN(n)) return null;
    return v.length === 6
      ? { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 }
      : { r: (n >>> 24) & 255, g: (n >> 16) & 255, b: (n >> 8) & 255, a: (n & 255) / 255 };
  },
  /** An absolutely-positioned ::before/::after that actually covers the box. */
  pseudoOverlays(node) {
    const out = [];
    for (const pseudo of ['::before', '::after']) {
      const ps = getComputedStyle(node, pseudo);
      if (!ps || ps.content === 'none' || ps.content === '' || ps.content === 'normal') continue;
      if (ps.position !== 'absolute' && ps.position !== 'fixed') continue;
      if (ps.display === 'none' || ps.visibility === 'hidden' || Number(ps.opacity) === 0) continue;
      // A zero-sized or inset-collapsed pseudo paints nothing behind the text.
      if (parseFloat(ps.width) === 0 || parseFloat(ps.height) === 0) continue;
      const c = this.parse(ps.backgroundColor);
      if (c && c.a > 0) out.push(c);
    }
    return out;
  },
  /** @returns {{bases: number[][], unmeasured: boolean}} */
  resolveBases(node, depth) {
    if (!node || node.nodeType !== 1 || (depth || 0) > 40) {
      return { bases: [[0, 0, 0]], unmeasured: false };
    }
    const cs = getComputedStyle(node);
    const own = this.parse(cs.backgroundColor);
    const stops = this.parseStops(cs.backgroundImage);
    const overlays = this.pseudoOverlays(node);

    if (stops === null) return { bases: [[0, 0, 0]], unmeasured: true };

    let below;
    if (own && own.a >= 1 && !stops.length) {
      below = { bases: [[own.r, own.g, own.b]], unmeasured: false };
    } else {
      const under = this.resolveBases(node.parentElement, (depth || 0) + 1);
      const painted = (own && own.a > 0)
        ? under.bases.map((b) => this.over(own, b))
        : under.bases;
      if (stops.length) {
        const out = [];
        for (const b of painted) for (const st of stops) out.push(this.over(st, b));
        below = { bases: out, unmeasured: under.unmeasured };
      } else {
        below = { bases: painted, unmeasured: under.unmeasured };
      }
    }
    if (overlays.length) {
      const withOverlay = [];
      for (const b of below.bases) {
        withOverlay.push(b);
        for (const o of overlays) withOverlay.push(this.over(o, b));
      }
      below = { bases: withOverlay, unmeasured: below.unmeasured };
    }
    // Keep the candidate set bounded on deeply nested gradient stacks.
    if (below.bases.length > 12) below = { bases: below.bases.slice(0, 12), unmeasured: below.unmeasured };
    return below;
  },
  /** Back-compat single-colour view: the first candidate. */
  effectiveBg(el) {
    const r = this.resolveBases(el, 0);
    const base = r.bases[0].slice();
    base.unmeasured = r.unmeasured;
    return base;
  },
  ratio(fg, bg) {
    const f = this.lum(this.over(fg, bg));
    const b = this.lum(bg);
    return (Math.max(f, b) + 0.05) / (Math.min(f, b) + 0.05);
  },

  /* ── DOM helpers ──────────────────────────────────────────────────────── */
  path(el) {
    const bits = [];
    let n = el;
    while (n && n.nodeType === 1 && bits.length < 5) {
      let s = n.tagName.toLowerCase();
      if (n.id) { bits.unshift(s + '#' + n.id); break; }
      if (n.className && typeof n.className === 'string') {
        s += '.' + n.className.trim().split(/\s+/).slice(0, 2).join('.');
      }
      bits.unshift(s);
      n = n.parentElement;
    }
    return bits.join(' > ');
  },
  /** True when nothing in the ancestor chain removes the element from paint. */
  rendered(el) {
    let n = el;
    while (n && n.nodeType === 1) {
      const cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.contentVisibility === 'hidden') return false;
      if (Number(cs.opacity) === 0) return false;
      n = n.parentElement;
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  },
  ownText(el) {
    let t = '';
    for (const n of el.childNodes) if (n.nodeType === 3) t += n.textContent;
    return t.trim();
  },

  /* ── defect 1: `hidden` must be authoritative ─────────────────────────── */
  hiddenButVisible() {
    const out = [];
    for (const el of document.querySelectorAll('[hidden]')) {
      const cs = getComputedStyle(el);
      if (cs.display !== 'none') {
        const r = el.getBoundingClientRect();
        out.push({ el: this.path(el), display: cs.display, w: Math.round(r.width), h: Math.round(r.height) });
      }
    }
    return out;
  },

  /* ── defect 2: a clipping ancestor must not swallow a control ─────────── */
  clippedBy(el) {
    const r = el.getBoundingClientRect();
    let n = el.parentElement;
    while (n && n.nodeType === 1) {
      const cs = getComputedStyle(n);
      const clipX = /hidden|clip/.test(cs.overflowX);
      const clipY = /hidden|clip/.test(cs.overflowY);
      if (clipX || clipY) {
        const nr = n.getBoundingClientRect();
        const overRight = r.right - (nr.left + n.clientWidth);
        const overLeft = nr.left - r.left;
        const overBottom = r.bottom - (nr.top + n.clientHeight);
        if (clipX && overRight > 1) return { by: this.path(n), overRight: Math.round(overRight) };
        if (clipX && overLeft > 1) return { by: this.path(n), overLeft: Math.round(overLeft) };
        // `hidden` and `clip` are not user-scrollable, so a scrollHeight larger
        // than clientHeight does not let anyone reveal the control — only a
        // genuinely scrollable `auto`/`scroll` ancestor does.
        if (clipY && overBottom > 1) {
          const scrollable = /auto|scroll/.test(cs.overflowY) && n.scrollHeight > n.clientHeight + 1;
          if (!scrollable) return { by: this.path(n), overBottom: Math.round(overBottom) };
        }
      }
      n = n.parentElement;
    }
    return null;
  },

  /* ── defect 3: the header must size to its content ────────────────────── */
  headerMetrics() {
    const hdr = document.querySelector('.hdr');
    if (!hdr) return null;
    const cs = getComputedStyle(hdr);
    const r = hdr.getBoundingClientRect();
    let bottom = r.top;
    let right = r.left;
    for (const c of hdr.querySelectorAll('*')) {
      const cr = c.getBoundingClientRect();
      if (cr.width === 0 && cr.height === 0) continue;
      if (getComputedStyle(c).position === 'fixed') continue;
      bottom = Math.max(bottom, cr.bottom);
      right = Math.max(right, cr.right);
    }
    return {
      height: Math.round(r.height),
      offsetHeight: hdr.offsetHeight,
      scrollHeight: hdr.scrollHeight,
      clientHeight: hdr.clientHeight,
      overflowBottomPx: Math.round(bottom - r.bottom),
      overflowRightPx: Math.round(right - r.right),
      cssHeight: cs.height,
      cssMinHeight: cs.minHeight,
      // The clamp the defect used. Resolving it here lets the caller tell
      // "pinned to the token" from "happens to measure the same".
      titlebarH: getComputedStyle(document.documentElement).getPropertyValue('--titlebar-h').trim(),
      publishedVar: getComputedStyle(document.documentElement).getPropertyValue('--vip-hdr-h').trim(),
    };
  },

  /* ── defect 4: WCAG AA text contrast ──────────────────────────────────── */
  /**
   * WCAG 1.4.3 exempts text that is part of an inactive user-interface
   * component, so disabled controls are reported separately rather than
   * counted as failures.
   */
  contrastFailures() {
    const fails = [];
    const unmeasured = [];
    const positionDependent = [];
    const seen = new Set();
    for (const el of document.querySelectorAll('*')) {
      const text = this.ownText(el);
      if (!text) continue;
      if (!this.rendered(el)) continue;
      if (el.closest(':disabled, [aria-disabled="true"]')) continue;
      const cs = getComputedStyle(el);
      const fill = cs.webkitTextFillColor || cs.color;
      const fg = this.parse(fill);
      // A fully transparent fill means the glyphs are painted by a clipped
      // background (gradient text); there is no foreground colour to measure.
      if (!fg || fg.a === 0) continue;
      const resolved = this.resolveBases(el, 0);
      // Only a url() image is truly unscorable; gradients contribute one
      // candidate per stop and are scored at their worst.
      if (resolved.unmeasured) {
        unmeasured.push({ el: this.path(el), text: this.ownText(el).slice(0, 40) });
        continue;
      }
      const px = parseFloat(cs.fontSize);
      const weight = parseInt(cs.fontWeight, 10) || 400;
      const need = (px >= 24 || (px >= 18.66 && weight >= 700)) ? 3 : 4.5;

      // Score every candidate. With one candidate this is an exact verdict.
      // With several (a gradient ramp) the honest reading is three-way: a
      // stop's colour may or may not be the one behind these glyphs, so
      //   all candidates pass  -> pass, no false pass is possible
      //   all candidates fail  -> fail, it cannot be rescued by position
      //   mixed                -> depends where the text sits on the ramp,
      //                           which computed style cannot tell us
      // Reporting the mixed set separately keeps the pass/fail verdict sound
      // without silently swallowing the ambiguous cases.
      let worst = Infinity;
      let best = -Infinity;
      let worstBg = resolved.bases[0];
      for (const cand of resolved.bases) {
        const r = this.ratio(fg, cand);
        if (r < worst) { worst = r; worstBg = cand; }
        if (r > best) best = r;
      }
      const key = this.path(el) + '|' + fill + '|' + text.slice(0, 20);
      if (seen.has(key)) continue;
      seen.add(key);
      const entry = {
        el: this.path(el), text: text.slice(0, 40), color: fill,
        bg: 'rgb(' + worstBg.map(Math.round).join(',') + ')',
        ratio: Math.round(worst * 100) / 100, need, px, weight,
      };
      if (best + 0.005 < need) fails.push(entry);
      else if (worst + 0.005 < need) {
        entry.bestRatio = Math.round(best * 100) / 100;
        entry.candidates = resolved.bases.length;
        positionDependent.push(entry);
      }
    }
    fails.sort((a, b) => a.ratio - b.ratio);
    positionDependent.sort((a, b) => a.ratio - b.ratio);
    fails.unmeasured = unmeasured;
    fails.positionDependent = positionDependent;
    return fails;
  },

  /* ── defect 5: no focusable content inside an aria-hidden region ──────── */
  FOCUSABLE: 'a[href],button,input,select,textarea,summary,iframe,[tabindex],[contenteditable="true"]',
  focusableInAriaHidden() {
    const out = [];
    for (const region of document.querySelectorAll('[aria-hidden="true"]')) {
      if (region.hasAttribute('inert') || region.closest('[inert]')) continue;
      if (!this.rendered(region)) continue;
      // The region itself may be the focusable one — `aria-hidden` on a button
      // hides it from assistive tech while leaving it in the tab order.
      const candidates = [...region.querySelectorAll(this.FOCUSABLE)];
      if (region.matches(this.FOCUSABLE)) candidates.unshift(region);
      for (const f of candidates) {
        const ti = f.getAttribute('tabindex');
        if (ti !== null && Number(ti) < 0) continue;
        if (f.disabled || f.closest('[inert]')) continue;
        if (!this.rendered(f)) continue;
        out.push({ region: this.path(region), focusable: this.path(f) });
      }
    }
    return out;
  },
};
