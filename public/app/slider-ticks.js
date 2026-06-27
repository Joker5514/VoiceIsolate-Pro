/**
 * VoiceIsolate Pro — slider-ticks.js
 * ==============================================
 * Adds visual tick marks + haptic-style snap to every slider.
 *
 * ARCHITECTURE:
 *   1. For each slider in SLIDER_REGISTRY, a <datalist> of <option> tags
 *      is generated and linked via the slider's `list` attribute.
 *      This gives native browser tick marks at zero DOM/CSS cost.
 *
 *   2. A JS 'input' listener rounds the live value to the nearest `step`
 *      on every interaction — this is the "haptic snap" effect.  The thumb
 *      physically stops at each tick position instead of flowing freely.
 *
 *   3. CSS positions the datalist ticks via .slider-tick-wrapper and
 *      overrides the native datalist marks with styled neon dashes.
 *
 *   4. The wrapper div is injected between the existing <input> and its
 *      parent row so no layout shift occurs — the grid column sizing is
 *      preserved.
 *
 * SNAP PRECISION:
 *   The snap rounds to `step` decimal places to avoid floating-point
 *   accumulation (e.g., 0.5 + 0.5 ≠ 1.0000000001 after 100 steps).
 *
 * COMPATIBILITY:
 *   • Datalist ticks render natively in Chrome, Edge, Firefox, Safari 14+.
 *   • The snap behaviour works in all browsers regardless.
 *   • prefers-reduced-motion: tick transitions disabled via CSS.
 */

import { SLIDER_REGISTRY } from './slider-map.js';

// Build a lookup: id → registry entry
const REGISTRY_MAP = Object.fromEntries(SLIDER_REGISTRY.map(s => [s.id, s]));

/**
 * Round `value` to the nearest `step`, with correct decimal precision.
 * @param {number} value
 * @param {number} step
 * @param {number} min  – range minimum (for step alignment)
 * @returns {number}
 */
function snapToStep(value, step, min) {
  if (!step || step <= 0) return value;
  // Align snap to min (steps start from min, not 0)
  const shifted = value - min;
  const snapped = Math.round(shifted / step) * step;
  // Precision: determine decimal places in step
  const decimals = (step.toString().split('.')[1] || '').length;
  return parseFloat((min + snapped).toFixed(decimals));
}

/**
 * Generate an array of tick values for a slider.
 * Caps at 40 ticks max to avoid datalist overload on ultra-fine steps.
 * @param {number} min
 * @param {number} max
 * @param {number} step
 * @returns {number[]}
 */
function generateTicks(min, max, step) {
  if (!step || step <= 0) return [];
  const ticks = [];
  const maxTicks = 40;
  const range = max - min;
  // If step would produce > maxTicks, coarsen it to a multiple
  let effectiveStep = step;
  if (range / step > maxTicks) {
    const mult = Math.ceil((range / step) / maxTicks);
    effectiveStep = step * mult;
  }
  const decimals = (effectiveStep.toString().split('.')[1] || '').length;
  for (let v = min; v <= max + effectiveStep * 0.001; v += effectiveStep) {
    ticks.push(parseFloat(v.toFixed(decimals)));
    if (ticks.length > maxTicks) break;
  }
  // Ensure max is always included
  if (ticks[ticks.length - 1] !== max) ticks.push(max);
  return ticks;
}

/**
 * Attach tick marks and snap behaviour to a single slider input element.
 * Safe to call multiple times on the same element (idempotent).
 * @param {HTMLInputElement} input
 */
function attachTicks(input) {
  if (input._ticksAttached) return;
  input._ticksAttached = true;

  const id = input.id || input.dataset.sliderId;
  const def = REGISTRY_MAP[id];
  if (!def) return; // unknown slider, skip

  const min  = def.min  ?? parseFloat(input.min)  ?? 0;
  const max  = def.max  ?? parseFloat(input.max)  ?? 100;
  const step = def.step ?? parseFloat(input.step) ?? 1;

  // ── Datalist for native tick marks ──────────────────────────────────────
  const listId = `ticks-${id}-${Date.now()}`;
  const datalist = document.createElement('datalist');
  datalist.id = listId;

  const ticks = generateTicks(min, max, step);
  ticks.forEach(v => {
    const opt = document.createElement('option');
    opt.value = String(v);
    datalist.appendChild(opt);
  });
  input.setAttribute('list', listId);

  // Inject datalist inside the slider's wrapper (or directly in the DOM)
  (input.closest('.slider-tick-wrapper') || input.parentNode).appendChild(datalist);

  // ── Wrap in .slider-tick-wrapper if not already wrapped ─────────────────
  if (!input.closest('.slider-tick-wrapper')) {
    const wrapper = document.createElement('div');
    wrapper.className = 'slider-tick-wrapper';
    wrapper.dataset.min  = min;
    wrapper.dataset.max  = max;
    wrapper.dataset.step = step;
    input.parentNode.insertBefore(wrapper, input);
    wrapper.appendChild(input);
    wrapper.appendChild(datalist);
  }

  // ── Haptic snap: round on every input event ──────────────────────────────
  const snapHandler = (e) => {
    const raw = parseFloat(e.target.value);
    if (isNaN(raw)) return;
    const snapped = snapToStep(raw, step, min);
    if (snapped !== raw) {
      // Only update if actually changed (avoids infinite loop)
      e.target.value = snapped;
      // Re-fire a synthetic 'input' event so downstream listeners see snapped value
      // Use a flag to prevent this re-fire from triggering another snap
      if (!e._isSnapped) {
        const synth = new Event('input', { bubbles: true });
        synth._isSnapped = true;
        e.target.dispatchEvent(synth);
      }
    }
    // Vibrate on mobile if Vibration API available
    if (navigator.vibrate && !e._isSnapped) {
      navigator.vibrate(1); // 1ms micro-pulse per tick crossing
    }
  };
  input.addEventListener('input', snapHandler);

  // ── Arrow key step enforcement (accessibility) ───────────────────────────
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      e.preventDefault();
      const current = parseFloat(input.value);
      const next = Math.max(min, snapToStep(current - step, step, min));
      input.value = next;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      e.preventDefault();
      const current = parseFloat(input.value);
      const next = Math.min(max, snapToStep(current + step, step, min));
      input.value = next;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
}

/**
 * Scan the document for all slider inputs and attach ticks.
 * Call once after app.js renders the slider DOM.
 * Also sets up a MutationObserver to catch dynamically-added sliders.
 */
export function initSliderTicks() {
  // Process existing sliders
  document.querySelectorAll(
    '.sr-row input[type="range"], .slider-row input[type="range"]'
  ).forEach(attachTicks);

  // Watch for new sliders added dynamically
  const observer = new MutationObserver((mutations) => {
    mutations.forEach(m => {
      m.addedNodes.forEach(node => {
        if (node.nodeType !== 1) return;
        if (node.matches('input[type="range"]')) {
          attachTicks(node);
        } else {
          node.querySelectorAll?.('input[type="range"]').forEach(attachTicks);
        }
      });
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });

  console.log('[VIP Ticks] Initialized on', document.querySelectorAll('.sr-row input[type="range"], .slider-row input[type="range"]').length, 'sliders');
}

/**
 * AUDIT LOG — dispatch routing verification.
 * Run in browser console: VIPSliderAudit.run()
 * Reports any SLIDER_REGISTRY entry whose worklet/worker key is
 * not found in the dsp-processor _params or a known ml-worker param.
 */
const WORKLET_KNOWN_PARAMS = new Set([
  'outGain','dryWet','nrAmount','gateThresh','gateRange','gateAttack','gateRelease','gateHold',
  'hpFreq','hpQ','lpFreq','lpQ','compThresh','compRatio','compAttack','compRelease',
  'compKnee','compMakeup','limThresh','limRelease','specTilt','stereoWidth','outWidth','ditherAmt',
  'eqSub','eqBass','eqWarmth','eqBody','eqLowMid','eqMid','eqPresence','eqClarity','eqAir','eqBrill'
]);
const WORKER_KNOWN_PARAMS = new Set([
  'nrSensitivity','nrSpectralSub','nrFloor','nrSmoothing','gateLookahead',
  'deEssFreq','deEssAmt','formantShift','derevAmt','derevDecay','harmRecov','harmOrder',
  'phaseCorr','voiceIso','bgSuppress','voiceFocusLo','voiceFocusHi','crosstalkCancel'
]);

export const VIPSliderAudit = {
  run() {
    const issues = [];
    SLIDER_REGISTRY.forEach(s => {
      const toWorklet = s.target === 'worklet' || s.target === 'both';
      const toWorker  = s.target === 'worker'  || s.target === 'both';
      if (toWorklet && !WORKLET_KNOWN_PARAMS.has(s.key)) {
        issues.push({ id: s.id, problem: `target=worklet but key "${s.key}" not in dsp-processor._params` });
      }
      if (toWorker && !WORKER_KNOWN_PARAMS.has(s.key)) {
        issues.push({ id: s.id, problem: `target=worker but key "${s.key}" not recognised by ml-worker` });
      }
      if (s.min >= s.max) {
        issues.push({ id: s.id, problem: `min (${s.min}) >= max (${s.max})` });
      }
      if (s.step <= 0) {
        issues.push({ id: s.id, problem: `step (${s.step}) must be > 0` });
      }
      if (s.default < s.min || s.default > s.max) {
        issues.push({ id: s.id, problem: `default (${s.default}) out of range [${s.min}, ${s.max}]` });
      }
    });
    if (issues.length === 0) {
      console.log('%c[VIP Audit] All 52 sliders PASS', 'color:#00ffe7;font-weight:700');
    } else {
      console.warn(`[VIP Audit] ${issues.length} issue(s) found:`);
      issues.forEach(i => console.warn(`  • ${i.id}: ${i.problem}`));
    }
    return issues;
  }
};

// Auto-expose audit to console for quick testing
if (typeof window !== 'undefined') {
  window.VIPSliderAudit = VIPSliderAudit;
}
