/**
 * VoiceIsolate Pro — Motion controller (Layer 4: Presentation)
 *
 * The one place that turns the pure `MotionPolicy` into DOM state for both
 * entry points (Landing and the Engineer Console):
 *
 *   - publishes the policy as root data attributes + CSS custom properties
 *     (`/src/ui/motion/motion.css` keys every animation off them);
 *   - scroll entrances for Landing story sections (marketing surface only);
 *   - a sliding, tone-crossfading indicator for segmented controls and tabs
 *     (A/B Raw / Processed / Removed, profiles, workspace and viz tabs);
 *   - one-shot entrances for panels, sheets, dialogs and toasts via the Web
 *     Animations API (transform / opacity only, never layout properties);
 *   - pauses illustration motion when offscreen or when the tab is hidden.
 *
 * Decorative only: it never reads or writes audio, the mixer or the ML path,
 * and it never adds always-on motion to a working view.
 */
'use strict';

import { detectPerformanceTier } from '../core/PerformanceTier.js';
import {
  resolveMotionPolicy, motionCustomProperties, motionDataAttributes,
  staggerDelay, MotionSurface,
} from '../core/MotionPolicy.js';
import { mountIllustrations } from './Illustrations.js';

/** Landing story blocks that enter on scroll. Workspace cards are excluded. */
export const MARKETING_REVEAL_SELECTORS = Object.freeze([
  '.v3-flow > .v3-label',
  '.v3-flow__steps > li',
  '.v3-block__head',
  '.v3-split-figure',
  '.v3-pipeline > li',
  '.v3-principles > div',
  '.v3-uses > .v3-label',
  '.v3-uses > .vip-use-case',
  '.v3-section__head',
  '.v3-console-host',
  '.v3-modes > .v3-label',
  '.v3-modes > .ps-card',
  '.vip-trust',
  '.privacy-panel',
]);

/** Parents whose matching children stagger in order. */
export const STAGGER_PARENTS = Object.freeze([
  '.v3-flow__steps', '.v3-pipeline', '.v3-principles', '.v3-uses', '.v3-modes',
]);

const TONE_BY_ID = {
  compareOriginalBtn: 'ref', compareCleanedBtn: 'voice', compareRemovedBtn: 'bgst',
};
const TONE_BY_MODE = { raw: 'ref', original: 'ref', processed: 'voice', removed: 'bgst' };
const pressed = (el) => el.getAttribute('aria-pressed') === 'true';

/** Segmented groups that get a sliding indicator. */
export const SEGMENT_GROUPS = Object.freeze([
  { selector: '.compare-row__ab', item: 'button', active: pressed, tone: (el) => TONE_BY_ID[el.id] || 'voice' },
  { selector: '.vip-comparison-toggle [role="group"]', item: 'button[data-mode]', active: pressed, tone: (el) => TONE_BY_MODE[el.dataset.mode] || 'voice' },
  { selector: '#profilesPanel .v3-seg', item: 'button', active: (el) => pressed(el) || el.classList.contains('vip-btn--primary'), tone: () => 'voice' },
  { selector: '.v3-nav', item: 'a', active: (el) => el.hasAttribute('aria-current'), tone: () => 'voice' },
  { selector: '#tabBar', item: '.tab-btn', active: (el) => el.getAttribute('aria-selected') === 'true', tone: () => 'voice' },
  { selector: '.ps-workspace-nav', item: 'a', active: (el) => el.hasAttribute('aria-current'), tone: () => 'voice' },
  { selector: '.ps-field-nav', item: 'button', active: (el) => el.hasAttribute('aria-current'), tone: () => 'voice' },
]);

/** Landing headings that get a split-line mask reveal (blur to sharp). */
export const SPLIT_HEADING_SELECTOR = 'body.v3 .v3-h2';
/** Landing CTAs that lean toward the pointer (pointer: fine only). */
export const MAGNETIC_SELECTOR = 'body.v3 .v3-btn--primary';
/** Landing story cards that tilt with a specular highlight (pointer: fine only). */
export const TILT_SELECTOR = 'body.v3 :is(.v3-flow__steps a, .v3-pipeline > li, .v3-modes > .ps-card, .v3-split-figure)';
export const MAGNET_MAX_PX = 6;
export const TILT_MAX_DEG = 4;

const WATCHED_ATTRS = ['aria-pressed', 'aria-selected', 'aria-current', 'class', 'hidden'];

/** Read the inputs the policy needs. Feature-detected; no UA sniffing. */
export function readMotionSignals(win = globalThis) {
  let reducedMotion = false;
  try {
    reducedMotion = typeof win.matchMedia === 'function'
      && win.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch { reducedMotion = false; }
  let tier;
  try { tier = detectPerformanceTier(win); } catch { tier = undefined; }
  const forced = (() => {
    try { return new URLSearchParams(win.location?.search || '').get('motionTier'); } catch { return null; }
  })();
  if (forced && /^(HIGH|BALANCED|CONSTRAINED)$/.test(forced)) tier = forced;
  return { reducedMotion, tier, saveData: win.navigator?.connection?.saveData === true };
}

export function computePolicies(signals) {
  return {
    marketing: resolveMotionPolicy({ ...signals, surface: MotionSurface.MARKETING }),
    work: resolveMotionPolicy({ ...signals, surface: MotionSurface.WORK }),
  };
}

/** Publish policies on <html>. Pure DOM writes, safe to call repeatedly. */
export function applyPolicies(doc, policies) {
  const root = doc.documentElement;
  for (const [k, v] of Object.entries(motionDataAttributes(policies.marketing, policies.work))) {
    root.setAttribute(k, v);
  }
  for (const [k, v] of Object.entries(motionCustomProperties(policies.work))) root.style.setProperty(k, v);
  // Marketing reveals may be longer than work reveals; publish separately.
  root.style.setProperty('--vip-motion-reveal-marketing', `${policies.marketing.durations.reveal}ms`);
  root.style.setProperty('--vip-motion-stagger-marketing', `${policies.marketing.durations.stagger}ms`);
  root.style.setProperty('--vip-motion-ease-marketing', policies.marketing.ease);
}

/**
 * One-shot entrance via WAAPI. Returns the Animation or null when the policy
 * forbids it. Reduced motion keeps sheets as a short opacity fade only.
 */
export function playEntrance(el, policy, { kind = 'panel', distance = 6 } = {}) {
  if (!el || typeof el.animate !== 'function') return null;
  const d = policy.durations;
  if (kind === 'sheet') {
    if (!policy.animations && !policy.reduced) return null;
    const fadeOnly = policy.reduced || policy.sheetFadeOnly;
    const frames = fadeOnly
      ? [{ opacity: 0 }, { opacity: 1 }]
      : [{ opacity: 0, transform: 'translateY(8px) scale(.985)' }, { opacity: 1, transform: 'none' }];
    return el.animate(frames, { duration: d.sheet, easing: policy.ease });
  }
  if (!policy.entrances) return null;
  const duration = kind === 'toast' ? d.toggle : d.reveal || d.toggle;
  return el.animate(
    [{ opacity: 0, transform: `translateY(${distance}px)` }, { opacity: 1, transform: 'none' }],
    { duration, easing: policy.ease },
  );
}

/** Left-to-right wipe for a freshly drawn waveform / spectrogram (clip-path). */
export function playWipe(el, policy) {
  if (!el || typeof el.animate !== 'function' || !policy.stateMotion) return null;
  return el.animate(
    [{ clipPath: 'inset(0 100% 0 0)', opacity: 0.4 }, { clipPath: 'inset(0 0 0 0)', opacity: 1 }],
    { duration: policy.durations.sheet * 2, easing: policy.ease },
  );
}

function attachSegment(doc, win, group, cfg) {
  if (group.dataset.vipSeg === '1') return;
  group.dataset.vipSeg = '1';
  try {
    if (win.getComputedStyle(group).position === 'static') group.classList.add('vip-seg-host');
  } catch { group.classList.add('vip-seg-host'); }
  const ind = doc.createElement('span');
  ind.className = 'vip-seg-ind';
  ind.setAttribute('aria-hidden', 'true');
  ind.innerHTML = '<i data-tone="ref"></i><i data-tone="voice"></i><i data-tone="bgst"></i>';
  group.appendChild(ind);
  let raf = 0;
  const update = () => {
    raf = 0;
    const items = [...group.querySelectorAll(cfg.item)];
    const active = items.find((el) => cfg.active(el));
    if (!active || active.offsetParent === null || !active.offsetWidth) {
      ind.dataset.on = '0';
      return;
    }
    const x = active.offsetLeft;
    const w = active.offsetWidth;
    ind.style.transform = `translate3d(${x}px,0,0) scaleX(${(w / 100).toFixed(4)})`;
    ind.dataset.tone = cfg.tone(active);
    ind.dataset.on = '1';
    if (!ind.dataset.ready) {
      // First placement lands without sliding in from x = 0.
      win.requestAnimationFrame(() => { ind.dataset.ready = '1'; });
    }
  };
  const schedule = () => { if (!raf) raf = win.requestAnimationFrame(update); };
  new win.MutationObserver((records) => {
    if (records.some((r) => r.target !== ind && !ind.contains(r.target))) schedule();
  }).observe(group, { subtree: true, attributes: true, attributeFilter: WATCHED_ATTRS });
  if (typeof win.ResizeObserver === 'function') new win.ResizeObserver(schedule).observe(group);
  schedule();
}

function attachSegments(doc, win) {
  for (const cfg of SEGMENT_GROUPS) {
    for (const group of doc.querySelectorAll(cfg.selector)) attachSegment(doc, win, group, cfg);
  }
}

function wireReveals(doc, win, policy) {
  if (!policy.entrances || typeof win.IntersectionObserver !== 'function') return;
  for (const sel of STAGGER_PARENTS) {
    for (const parent of doc.querySelectorAll(sel)) {
      [...parent.children].forEach((child, i) => {
        child.style.setProperty('--vip-reveal-delay', `${staggerDelay(i, policy)}ms`);
      });
    }
  }
  const vh = win.innerHeight || 800;
  const io = new win.IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.dataset.vipReveal = 'in';
      io.unobserve(e.target);
    }
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
  const targets = doc.querySelectorAll(MARKETING_REVEAL_SELECTORS.join(','));
  for (const el of targets) {
    // Anything already on screen stays put: no flash of hidden content.
    if (el.getBoundingClientRect().top < vh) continue;
    el.dataset.vipReveal = 'pending';
    io.observe(el);
  }
  win.addEventListener('beforeprint', () => {
    for (const el of doc.querySelectorAll('[data-vip-reveal="pending"]')) el.dataset.vipReveal = 'in';
  });
}

/**
 * Wrap each line of a heading (split on <br>) in a clipping mask so the line
 * rises into place and sharpens from a slight blur. Text and ids are kept;
 * only wrapper spans are added. Returns the number of lines.
 */
export function splitHeadingLines(heading) {
  if (!heading || heading.dataset.vipSplit) return 0;
  const parts = heading.innerHTML.split(/<br\s*\/?>/i).map((p) => p.trim()).filter(Boolean);
  heading.innerHTML = parts
    .map((html, i) => `<span class="vip-line"><span class="vip-line__inner" style="--vip-line-i:${i}">${html}</span></span>`)
    .join('');
  heading.dataset.vipSplit = 'pending';
  return parts.length;
}

function wireSplitHeadings(doc, win, policy) {
  if (!policy.entrances || policy.reduced || typeof win.IntersectionObserver !== 'function') return;
  const vh = win.innerHeight || 800;
  const io = new win.IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.dataset.vipSplit = 'in';
      io.unobserve(e.target);
    }
  }, { rootMargin: '0px 0px -10% 0px', threshold: 0.2 });
  for (const h of doc.querySelectorAll(SPLIT_HEADING_SELECTOR)) {
    if (h.getBoundingClientRect().top < vh) continue;
    if (splitHeadingLines(h)) io.observe(h);
  }
  win.addEventListener('beforeprint', () => {
    for (const h of doc.querySelectorAll('[data-vip-split="pending"]')) h.dataset.vipSplit = 'in';
  });
}

/** Pure: magnetic offset toward the pointer, clamped to `max` px. */
export function magneticOffset(px, py, rect, max = MAGNET_MAX_PX) {
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const nx = Math.max(-1, Math.min(1, (px - cx) / (rect.width / 2 || 1)));
  const ny = Math.max(-1, Math.min(1, (py - cy) / (rect.height / 2 || 1)));
  return { x: +(nx * max).toFixed(2), y: +(ny * max * 0.6).toFixed(2) };
}

/** Pure: card tilt (deg) and specular position (0..1) from pointer position. */
export function tiltFromPointer(px, py, rect, max = TILT_MAX_DEG) {
  const u = Math.max(0, Math.min(1, (px - rect.left) / (rect.width || 1)));
  const v = Math.max(0, Math.min(1, (py - rect.top) / (rect.height || 1)));
  return { rx: +((0.5 - v) * 2 * max).toFixed(2), ry: +((u - 0.5) * 2 * max).toFixed(2), u, v };
}

function finePointer(win) {
  try { return win.matchMedia('(pointer: fine)').matches && win.matchMedia('(hover: hover)').matches; } catch { return false; }
}

/** Magnetic CTAs and tilting story cards. Landing only, pointer: fine only. */
function wirePointerEffects(doc, win, policy) {
  if (!policy.pointerEffects || policy.reduced || !finePointer(win)) return;
  doc.documentElement.setAttribute('data-motion-pointer', 'on');
  for (const btn of doc.querySelectorAll(MAGNETIC_SELECTOR)) {
    let raf = 0; let ev = null;
    const apply = () => {
      raf = 0;
      if (!ev) return;
      const o = magneticOffset(ev.clientX, ev.clientY, btn.getBoundingClientRect());
      btn.style.translate = `${o.x}px ${o.y}px`;
    };
    btn.classList.add('vip-magnetic');
    btn.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse') return;
      ev = e;
      btn.dataset.magnet = 'on';
      if (!raf) raf = win.requestAnimationFrame(apply);
    });
    btn.addEventListener('pointerleave', () => {
      ev = null;
      btn.dataset.magnet = 'off';
      btn.style.translate = '';
    });
  }
  for (const card of doc.querySelectorAll(TILT_SELECTOR)) {
    if (card.querySelector(':scope > .vip-spec')) continue;
    const spec = doc.createElement('span');
    spec.className = 'vip-spec';
    spec.setAttribute('aria-hidden', 'true');
    spec.innerHTML = '<span class="vip-spec__light"></span>';
    card.appendChild(spec);
    card.classList.add('vip-tilt');
    const light = spec.firstChild;
    let raf = 0; let ev = null;
    const apply = () => {
      raf = 0;
      if (!ev) return;
      const r = card.getBoundingClientRect();
      const t = tiltFromPointer(ev.clientX, ev.clientY, r);
      card.style.transform = `perspective(900px) rotateX(${t.rx}deg) rotateY(${t.ry}deg) translateY(-2px)`;
      light.style.transform = `translate3d(${(t.u * r.width).toFixed(1)}px, ${(t.v * r.height).toFixed(1)}px, 0)`;
    };
    card.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse') return;
      ev = e;
      card.dataset.tilt = 'on';
      if (!raf) raf = win.requestAnimationFrame(apply);
    });
    card.addEventListener('pointerleave', () => {
      ev = null;
      card.dataset.tilt = 'off';
      card.style.transform = '';
    });
  }
}

function wireAmbientPause(doc, win) {
  const root = doc.documentElement;
  const sync = () => root.toggleAttribute('data-motion-hidden', doc.hidden === true);
  doc.addEventListener('visibilitychange', sync);
  sync();
  if (typeof win.IntersectionObserver !== 'function') return;
  const io = new win.IntersectionObserver((entries) => {
    for (const e of entries) e.target.toggleAttribute('data-vip-offscreen', !e.isIntersecting);
  });
  for (const host of doc.querySelectorAll('[data-vip-illustration]')) io.observe(host);
}

/** Dialogs (`.modal.open`), toasts and opened <details> sheets. */
function wireSheetsAndToasts(doc, win, getWork) {
  const animateModal = (modal) => {
    const content = modal.querySelector('.modal-content') || modal;
    playEntrance(content, getWork(), { kind: 'sheet' });
  };
  for (const modal of doc.querySelectorAll('.modal')) {
    let wasOpen = modal.classList.contains('open');
    new win.MutationObserver(() => {
      const open = modal.classList.contains('open');
      if (open && !wasOpen) animateModal(modal);
      wasOpen = open;
    }).observe(modal, { attributes: true, attributeFilter: ['class'] });
  }
  const toasts = doc.getElementById('toastRegion');
  if (toasts) {
    new win.MutationObserver((records) => {
      for (const r of records) {
        for (const n of r.addedNodes) {
          if (n.nodeType === 1) playEntrance(n, getWork(), { kind: 'toast', distance: 8 });
        }
      }
    }).observe(toasts, { childList: true });
  }
  doc.addEventListener('toggle', (e) => {
    const d = e.target;
    if (!(d && d.tagName === 'DETAILS' && d.open)) return;
    const body = [...d.children].find((c) => c.tagName !== 'SUMMARY');
    if (body) playEntrance(body, getWork(), { kind: 'panel', distance: 4 });
  }, true);
}

/** Engineer viz tabs: fade the newly selected panel in. */
function wireTabPanels(doc, win, getWork) {
  const bar = doc.getElementById('tabBar');
  if (!bar) return;
  let current = bar.querySelector('[aria-selected="true"]');
  new win.MutationObserver(() => {
    const next = bar.querySelector('[aria-selected="true"]');
    if (!next || next === current) return;
    current = next;
    const panel = doc.getElementById(next.getAttribute('aria-controls') || '');
    if (panel) playEntrance(panel, getWork(), { kind: 'panel', distance: 4 });
  }).observe(bar, { subtree: true, attributes: true, attributeFilter: ['aria-selected'] });
}

/** Landing Quick Clean: result reveal when a Process finishes. */
function wireQuickClean(doc, win, getWork) {
  const panel = doc.getElementById('uploadPanel');
  if (!panel) return;
  let prev = panel.dataset.state;
  new win.MutationObserver(() => {
    const state = panel.dataset.state;
    if (state === prev) return;
    const was = prev;
    prev = state;
    if (state === 'processed' && (was === 'processing' || was === 'downloading')) {
      const policy = getWork();
      playEntrance(doc.querySelector('#enhancePanel .v3-lanes'), policy, { kind: 'panel', distance: 8 });
      playWipe(doc.getElementById('waveCanvas'), policy);
      const ind = doc.querySelector('.compare-row__ab .vip-seg-ind');
      if (ind && policy.stateMotion && typeof ind.animate === 'function') {
        ind.animate([{ opacity: 0 }, { opacity: 1 }], { duration: policy.durations.sheet, easing: policy.ease });
      }
    }
  }).observe(panel, { attributes: true, attributeFilter: ['data-state'] });
}

const ENGINEER_EMPTY_COPY = {
  title: 'Import a recording to begin',
  sub: 'After Process, the Clean Voice and Background stems appear here beside the original. Everything runs on this device.',
};

/** Engineer: illustrated empty state over the stage until a file loads. */
export function mountEngineerEmptyState(doc, win, getWork) {
  // The Neon Pulse stage is the first thing in view; the spectrogram stage is the fallback host.
  const host = doc.getElementById('np-canvas-wrap') || doc.getElementById('spectro3d-container');
  if (!host || doc.getElementById('vipEngineerEmpty') || win.__vipFileSeen) return null;
  const box = doc.createElement('div');
  box.id = 'vipEngineerEmpty';
  box.className = 'vip-empty';
  box.setAttribute('role', 'note');
  box.innerHTML = `<div class="vip-empty__art" data-vip-illustration="engineer-empty"></div>
<p class="vip-empty__title"></p><p class="vip-empty__sub"></p>`;
  box.querySelector('.vip-empty__title').textContent = ENGINEER_EMPTY_COPY.title;
  box.querySelector('.vip-empty__sub').textContent = ENGINEER_EMPTY_COPY.sub;
  host.appendChild(box);
  mountIllustrations(box);
  const dismiss = () => {
    if (box.hidden) return;
    const policy = getWork();
    const done = () => { box.hidden = true; };
    if (policy.animations && typeof box.animate === 'function') {
      const a = box.animate([{ opacity: 1 }, { opacity: 0 }], { duration: policy.durations.toggle, easing: policy.ease });
      a.onfinish = done;
    } else {
      done();
    }
    for (const id of ['spectroCanvas', 'waveCanvas']) playWipe(doc.getElementById(id), policy);
  };
  win.addEventListener('vip:fileAccepted', dismiss);
  win.addEventListener('vip:fileLoaded', dismiss);
  return box;
}

let initialised = null;

/**
 * @param {object} [opts]
 * @param {'landing'|'engineer'} [opts.page]
 * @param {Document} [opts.doc] @param {Window} [opts.win]
 */
export function initMotion({ page = 'landing', doc = globalThis.document, win = globalThis } = {}) {
  if (!doc?.documentElement) return null;
  if (initialised) return initialised;
  let policies = computePolicies(readMotionSignals(win));
  applyPolicies(doc, policies);
  const getWork = () => policies.work;

  try {
    const mq = win.matchMedia?.('(prefers-reduced-motion: reduce)');
    mq?.addEventListener?.('change', () => {
      policies = computePolicies(readMotionSignals(win));
      applyPolicies(doc, policies);
    });
  } catch { /* older engines: policy fixed for the session */ }

  mountIllustrations(doc);
  if (page === 'engineer') {
    // A file can arrive before the stage host exists; remember it.
    const seen = () => { win.__vipFileSeen = true; };
    win.addEventListener('vip:fileAccepted', seen, { once: true });
    win.addEventListener('vip:fileLoaded', seen, { once: true });
    mountEngineerEmptyState(doc, win, getWork);
    for (const ms of [400, 1500]) win.setTimeout(() => mountEngineerEmptyState(doc, win, getWork), ms);
  }
  wireAmbientPause(doc, win);
  if (page === 'landing') {
    wireReveals(doc, win, policies.marketing);
    wireSplitHeadings(doc, win, policies.marketing);
    wirePointerEffects(doc, win, policies.marketing);
    wireQuickClean(doc, win, getWork);
  }
  wireSheetsAndToasts(doc, win, getWork);
  wireTabPanels(doc, win, getWork);
  attachSegments(doc, win);
  // Some groups mount late (ComparisonToggle, engineer-console navs).
  for (const ms of [400, 1500, 4000]) win.setTimeout(() => attachSegments(doc, win), ms);

  doc.documentElement.setAttribute('data-motion-ready', '');
  initialised = { get policies() { return policies; } };
  win.VIPMotion = initialised;
  return initialised;
}
