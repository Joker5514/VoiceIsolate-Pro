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
  /** Flatten the ancestor background stack until an opaque layer is reached. */
  effectiveBg(el) {
    const stack = [];
    let n = el;
    while (n && n.nodeType === 1) {
      const c = this.parse(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0) stack.push(c);
      if (c && c.a >= 1) break;
      n = n.parentElement;
    }
    let base = [0, 0, 0];
    for (let i = stack.length - 1; i >= 0; i--) base = this.over(stack[i], base);
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
        if (clipY && overBottom > 1 && n.scrollHeight <= n.clientHeight + 1) {
          return { by: this.path(n), overBottom: Math.round(overBottom) };
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
      const bg = this.effectiveBg(el);
      const ratio = this.ratio(fg, bg);
      const px = parseFloat(cs.fontSize);
      const weight = parseInt(cs.fontWeight, 10) || 400;
      const need = (px >= 24 || (px >= 18.66 && weight >= 700)) ? 3 : 4.5;
      if (ratio + 0.005 < need) {
        const key = this.path(el) + '|' + fill + '|' + text.slice(0, 20);
        if (seen.has(key)) continue;
        seen.add(key);
        fails.push({
          el: this.path(el), text: text.slice(0, 40), color: fill,
          bg: 'rgb(' + bg.map(Math.round).join(',') + ')',
          ratio: Math.round(ratio * 100) / 100, need, px, weight,
        });
      }
    }
    return fails.sort((a, b) => a.ratio - b.ratio);
  },

  /* ── defect 5: no focusable content inside an aria-hidden region ──────── */
  FOCUSABLE: 'a[href],button,input,select,textarea,summary,iframe,[tabindex],[contenteditable="true"]',
  focusableInAriaHidden() {
    const out = [];
    for (const region of document.querySelectorAll('[aria-hidden="true"]')) {
      if (region.hasAttribute('inert') || region.closest('[inert]')) continue;
      if (!this.rendered(region)) continue;
      for (const f of region.querySelectorAll(this.FOCUSABLE)) {
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
