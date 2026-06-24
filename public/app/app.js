/**
 * VoiceIsolate Pro — Engineer Mode  (app.js)
 *
 * Main-thread orchestration.  Wires DOM inputs → SLIDER_REGISTRY → VIP_PARAMS
 * and routes rt:true sliders through the EngineerModeBridge.
 *
 * Addresses all six bug categories:
 *   §1  Slider DOM ↔ SLIDER_REGISTRY sync          — dynamic generation from STAGES
 *   §2  Value display not updating                  — input event → VIP_PARAMS + span
 *   §3  rt:true sliders not affecting playback      — bridge.apply() with null-guard
 *   §4  Slider group expand/collapse broken         — .active toggle on header click
 *   §5  Disabled state not releasing                 — enableAllSliders() on pipeline ready
 *   §6  Reset button incomplete                     — resetAllSliders() full cycle
 */

/* ──────────────────────────────────────────────────────────────────────────
 *  Global state
 * ────────────────────────────────────────────────────────────────────────── */

/** Live parameter store — every slider value is mirrored here. */
const VIP_PARAMS = {};

/**
 * Reference to the EngineerModeBridge instance.
 * Set to null until the PlaybackMixer is ready and the bridge is constructed.
 * All bridge calls MUST null-guard against this reference.
 *   Bug Category §3: rt:true sliders not affecting playback — null-guard fix
 */
let _bridge = null;

/**
 * Whether the audio pipeline is loaded and playback is active.
 * rt:true bridge.apply() calls are only made when this is true,
 * but VIP_PARAMS is always updated regardless.
 */
let _pipelineReady = false;

/* ──────────────────────────────────────────────────────────────────────────
 *  §1 — Dynamic slider DOM generation from STAGES + SLIDER_REGISTRY
 *
 *  This eliminates the class of bugs where HTML sliders and the registry
 *  drift apart.  Every slider in SLIDER_REGISTRY gets a DOM element;
 *  there are no orphans or disconnected controls.
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Builds the complete slider group UI from the canonical STAGES and
 * SLIDER_REGISTRY data structures defined in slider-map.js.
 *
 * Each slider gets:
 *  - <label for="{id}">    — from registry.label
 *  - <input type="range">  — with correct min/max/step/value/disabled
 *  - <span class="slider-value" id="{id}Val"> — display with unit suffix
 *
 * Each stage gets an accordion .slider-group wrapper.
 */
function buildSliderUI() {
  const container = document.getElementById('sliderGroups');
  if (!container) {
    console.error('[app] #sliderGroups container not found');
    return;
  }

  STAGES.forEach((stage, stageIdx) => {
    const group = document.createElement('div');
    group.className = 'slider-group';
    group.id = stage.id;

    // First stage starts expanded
    if (stageIdx === 0) {
      group.classList.add('active');
    }

    /* ── Header ── */
    const header = document.createElement('div');
    header.className = 'slider-group-header';
    header.setAttribute('role', 'button');
    header.setAttribute('aria-expanded', stageIdx === 0 ? 'true' : 'false');
    header.setAttribute('tabindex', '0');
    // §4 — accordion toggle wired here
    header.addEventListener('click', () => toggleGroup(group, header));

    const iconWrap = document.createElement('span');
    iconWrap.className = 'group-icon';
    const icon = document.createElement('i');
    icon.className = `fas ${stage.icon}`;
    iconWrap.appendChild(icon);

    const title = document.createElement('span');
    title.className = 'group-title';
    title.textContent = stage.title;

    const chevron = document.createElement('span');
    chevron.className = 'chevron';
    const chevronIcon = document.createElement('i');
    chevronIcon.className = 'fas fa-chevron-down';
    chevron.appendChild(chevronIcon);

    header.appendChild(iconWrap);
    header.appendChild(title);
    header.appendChild(chevron);

    /* ── Content ── */
    const content = document.createElement('div');
    content.className = 'slider-group-content';

    stage.sliders.forEach((sliderId) => {
      const entry = SLIDER_REGISTRY[sliderId];
      if (!entry) {
        console.warn(`[app] Slider "${sliderId}" in stage "${stage.id}" not found in SLIDER_REGISTRY`);
        return;
      }

      // Initialize VIP_PARAMS from registry default
      VIP_PARAMS[sliderId] = entry.default;

      const row = document.createElement('div');
      row.className = 'slider-row';

      const label = document.createElement('label');
      label.setAttribute('for', sliderId);
      label.textContent = entry.label;

      const input = document.createElement('input');
      input.type = 'range';
      input.id = sliderId;
      input.min = entry.min;
      input.max = entry.max;
      input.step = entry.step;
      input.value = entry.default;
      input.disabled = true; // §5 — all sliders start disabled until pipeline ready

      // §2 + §3 — input event handler
      input.addEventListener('input', () => onSliderInput(sliderId, input));

      const valSpan = document.createElement('span');
      valSpan.className = 'slider-value';
      valSpan.id = `${sliderId}Val`;
      valSpan.textContent = formatValue(entry.default, entry.unit);

      // Set initial --fill for WebKit track gradient
      updateFill(input, entry);

      row.appendChild(label);
      row.appendChild(input);
      row.appendChild(valSpan);
      content.appendChild(row);
    });

    group.appendChild(header);
    group.appendChild(content);
    container.appendChild(group);
  });
}

/* ──────────────────────────────────────────────────────────────────────────
 *  §2 — Value display update
 *
 *  The input event listener updates both VIP_PARAMS[id] AND the display
 *  span in real time.  Display span follows the pattern {sliderId}Val.
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Format a numeric value with its unit suffix for display.
 * @param {number} value
 * @param {string} unit — dB, Hz, ms, %, x, s, LUFS
 * @returns {string}
 */
function formatValue(value, unit) {
  // Display integer for whole-number units where step >= 1
  const entry = SLIDER_REGISTRY[Object.keys(VIP_PARAMS).find(k => VIP_PARAMS[k] === value)];
  if (typeof value === 'number') {
    // Use toFixed based on step precision
    const absVal = Math.abs(value);
    if (absVal === 0) return `0${unit}`;
    if (absVal >= 100) return `${Math.round(value)}${unit}`;
    if (absVal >= 10) return value % 1 === 0 ? `${Math.round(value)}${unit}` : `${value.toFixed(1)}${unit}`;
    return `${value.toFixed(1)}${unit}`;
  }
  return `${value}${unit}`;
}

/**
 * Format a slider's current value for display, using the registry's unit.
 * @param {string} id
 * @param {number} value
 * @returns {string}
 */
function formatSliderValue(id, value) {
  const entry = SLIDER_REGISTRY[id];
  if (!entry) return `${value}`;
  const unit = entry.unit;
  const step = entry.step;

  // Determine decimal places from step
  let decimals = 0;
  if (step < 0.01) decimals = 3;
  else if (step < 0.1) decimals = 2;
  else if (step < 1) decimals = 1;
  else decimals = 0;

  return `${Number(value).toFixed(decimals)}${unit}`;
}

/**
 * Input event handler for all sliders.
 * Updates VIP_PARAMS, display span, fill gradient, and routes to bridge.
 *
 *   Bug Category §2: Value display not updating — updates VIP_PARAMS + span
 *   Bug Category §3: rt:true sliders not affecting playback — bridge.apply with null-guard
 */
function onSliderInput(id, inputEl) {
  const value = parseFloat(inputEl.value);
  const entry = SLIDER_REGISTRY[id];
  if (!entry) return;

  // §2 — Update VIP_PARAMS store
  VIP_PARAMS[id] = value;

  // §2 — Update the display span (pattern: {id}Val)
  const valSpan = document.getElementById(`${id}Val`);
  if (valSpan) {
    valSpan.textContent = formatSliderValue(id, value);
  } else {
    console.warn(`[app] Display span "${id}Val" not found for slider "${id}"`);
  }

  // Update the WebKit track fill gradient
  updateFill(inputEl, entry);

  // §3 — Route rt:true sliders to the bridge during active playback
  if (entry.rt && _pipelineReady && _bridge) {
    // Null-guard: _bridge may be null if pipeline not yet initialized
    if (EngineerModeBridge && EngineerModeBridge.handles(id)) {
      try {
        _bridge.apply(id, value);
      } catch (err) {
        console.warn(`[app] Bridge apply error for "${id}":`, err);
      }
    }
  }
}

/**
 * Updates the --fill CSS custom property on a range input for the
 * WebKit track gradient.  Calculates the percentage of the slider's
 * current position between min and max.
 */
function updateFill(inputEl, entry) {
  const min = parseFloat(inputEl.min);
  const max = parseFloat(inputEl.max);
  const val = parseFloat(inputEl.value);
  const pct = ((val - min) / (max - min)) * 100;
  inputEl.style.setProperty('--fill', `${pct}%`);
}

/* ──────────────────────────────────────────────────────────────────────────
 *  §3 — Bridge integration (null-guarded)
 *
 *  _bridge is null until PlaybackMixer is ready.  All calls are guarded.
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Initialize the bridge with a PlaybackMixer instance.
 * Called by the audio pipeline once it has constructed the mixer graph.
 *   Bug Category §3: rt:true sliders not affecting playback
 */
function initBridge(mixer) {
  try {
    // In the static app context, EngineerModeBridge is imported as a module.
    // For the standalone HTML page, we simulate this with the global reference.
    if (typeof EngineerModeBridge !== 'undefined') {
      _bridge = new EngineerModeBridge(mixer);
      console.log('[app] EngineerModeBridge initialized');
    } else {
      console.warn('[app] EngineerModeBridge class not available — rt sliders will update VIP_PARAMS only');
    }
  } catch (err) {
    console.error('[app] Failed to initialize EngineerModeBridge:', err);
    _bridge = null;
  }
}

/* ──────────────────────────────────────────────────────────────────────────
 *  §4 — Slider group expand/collapse (accordion)
 *
 *  Uses .active class toggle.  The CSS in style.css handles the
 *  max-height + opacity transition.  No display:none toggling.
 *   Bug Category §4: Slider group expand/collapse broken
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Toggle a slider group's expanded/collapsed state.
 * @param {HTMLElement} groupEl — the .slider-group element
 * @param {HTMLElement} headerEl — the .slider-group-header element
 */
function toggleGroup(groupEl, headerEl) {
  const isActive = groupEl.classList.toggle('active');
  headerEl.setAttribute('aria-expanded', isActive ? 'true' : 'false');
}

/* ──────────────────────────────────────────────────────────────────────────
 *  §5 — Disabled state lifecycle
 *
 *  All 52 sliders start disabled.  Once the audio pipeline is loaded and
 *  the mixer graph is constructed, enableAllSliders() is called to release
 *  the disabled state on every slider.
 *   Bug Category §5: Disabled state not releasing
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Enable all 52 sliders after the pipeline is ready.
 * Called from the onReady / pipeline-ready callback.
 *   Bug Category §5: Disabled state not releasing
 */
function enableAllSliders() {
  const allSliders = document.querySelectorAll('#sliderGroups input[type="range"]');
  allSliders.forEach((slider) => {
    slider.disabled = false;
  });
  _pipelineReady = true;

  // Update pipeline status UI
  const statusEl = document.getElementById('pipelineStatus');
  const statusText = document.getElementById('statusText');
  if (statusEl) statusEl.classList.add('ready');
  if (statusEl) statusEl.classList.remove('loading');
  if (statusText) statusText.textContent = 'Pipeline ready — adjust sliders to mix in real time';

  // Re-apply current VIP_PARAMS values to the bridge for all rt:true sliders
  // so the bridge state is in sync with any slider positions set before
  // the pipeline was ready (e.g. defaults).
  if (_bridge) {
    Object.keys(VIP_PARAMS).forEach((id) => {
      const entry = SLIDER_REGISTRY[id];
      if (entry && entry.rt && EngineerModeBridge && EngineerModeBridge.handles(id)) {
        try {
          _bridge.apply(id, VIP_PARAMS[id]);
        } catch (err) {
          console.warn(`[app] Bridge re-apply error for "${id}":`, err);
        }
      }
    });
  }

  console.log(`[app] ${allSliders.length} sliders enabled`);
}

/* ──────────────────────────────────────────────────────────────────────────
 *  §6 — Reset button
 *
 *  Restores every slider to its SLIDER_REGISTRY default value, updates
 *  the display span, updates VIP_PARAMS, and fires apply() on the bridge
 *  for any rt:true slider.
 *   Bug Category §6: Reset button incomplete
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Reset all 52 sliders to their factory defaults.
 *   Bug Category §6: Reset button — restores DOM, VIP_PARAMS, and bridge
 */
function resetAllSliders() {
  Object.keys(SLIDER_REGISTRY).forEach((id) => {
    const entry = SLIDER_REGISTRY[id];
    const inputEl = document.getElementById(id);
    const valSpan = document.getElementById(`${id}Val`);

    if (inputEl) {
      inputEl.value = entry.default;
      updateFill(inputEl, entry);
    }

    if (valSpan) {
      valSpan.textContent = formatSliderValue(id, entry.default);
    }

    // Update VIP_PARAMS
    VIP_PARAMS[id] = entry.default;

    // §6 — Fire bridge.apply() for rt:true sliders during active playback
    if (entry.rt && _pipelineReady && _bridge) {
      if (EngineerModeBridge && EngineerModeBridge.handles(id)) {
        try {
          _bridge.apply(id, entry.default);
        } catch (err) {
          console.warn(`[app] Bridge reset apply error for "${id}":`, err);
        }
      }
    }
  });

  console.log('[app] All sliders reset to defaults');
}

/* ──────────────────────────────────────────────────────────────────────────
 *  File drop zone handling
 * ────────────────────────────────────────────────────────────────────────── */

function initFileDropZone() {
  const dropZone = document.getElementById('fileDropZone');
  const fileInput = document.getElementById('fileInput');
  if (!dropZone || !fileInput) return;

  // Click to open file browser
  dropZone.addEventListener('click', () => fileInput.click());

  // Keyboard support to open file browser
  dropZone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInput.click();
    }
  });

  // File selected via input
  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      handleFileLoad(e.target.files[0]);
    }
  });

  // Drag events
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });

  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('drag-over');
  });

  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    if (e.dataTransfer.files.length > 0) {
      handleFileLoad(e.dataTransfer.files[0]);
    }
  });
}

/**
 * Simulate the audio file load → pipeline ready flow.
 * In the real app, this would trigger stem separation and mixer graph
 * construction.  Here we simulate with a timeout and mock mixer.
 */
function handleFileLoad(file) {
  const statusEl = document.getElementById('pipelineStatus');
  const statusText = document.getElementById('statusText');
  const dropZone = document.getElementById('fileDropZone');

  // Update status to loading
  if (statusEl) statusEl.classList.add('loading');
  if (statusEl) statusEl.classList.remove('ready');
  if (statusText) statusText.textContent = `Loading "${file.name}" — separating stems…`;

  // Update drop zone to show loaded file
  if (dropZone) {
    dropZone.querySelector('p').textContent = file.name;
    dropZone.querySelector('i').className = 'fas fa-music';
  }

  // Simulate pipeline initialization (in real app: stem separation + mixer graph)
  setTimeout(() => {
    // Create a mock PlaybackMixer for demo purposes
    const mockMixer = createMockMixer();

    // Initialize the bridge with the mock mixer
    // §3 — bridge must be ready before sliders are enabled
    initBridge(mockMixer);

    // §5 — Enable all sliders now that pipeline is ready
    enableAllSliders();
  }, 1500);
}

/**
 * Creates a mock PlaybackMixer with AudioParam-like nodes for demo purposes.
 * In production, the real PlaybackMixer from the audio pipeline is used.
 */
function createMockMixer() {
  // Create a real AudioContext for the mock nodes
  const ctx = new (window.AudioContext || window.webkitAudioContext)();

  const createGain = () => ctx.createGain();
  const createBiquad = (type) => {
    const f = ctx.createBiquadFilter();
    f.type = type;
    return f;
  };
  const createCompressor = () => ctx.createDynamicsCompressor();
  const createStereoPanner = () => ctx.createStereoPanner();
  const createDelay = () => ctx.createDelay(5.0);

  return {
    context: ctx,
    stemGains: {
      vocal: createGain(),
      drums: createGain(),
      bass: createGain(),
      other: createGain(),
    },
    vocalEQ: {
      low: createBiquad('lowshelf'),
      mid: createBiquad('peaking'),
      high: createBiquad('highshelf'),
    },
    drumsEQ: {
      low: createBiquad('lowshelf'),
      mid: createBiquad('peaking'),
    },
    bassEQ: {
      low: createBiquad('lowshelf'),
      mid: createBiquad('peaking'),
    },
    otherEQ: {
      mid: createBiquad('peaking'),
      high: createBiquad('highshelf'),
    },
    drumsComp: createCompressor(),
    bassComp: createCompressor(),
    otherComp: createCompressor(),
    deEsser: (() => {
      const f = createBiquad('peaking');
      // Extend with a threshold AudioParam (gain-based de-esser mock)
      const thresholdGain = ctx.createGain();
      f.threshold = thresholdGain.gain;
      return f;
    })(),
    reverb: {
      mix: createGain(),
      convolver: ctx.createConvolver(),
    },
    master: {
      gain: createGain(),
      pan: createStereoPanner(),
      width: createStereoPanner(),
      limiter: createCompressor(),
    },
    delay: {
      delayNode: createDelay(),
      feedback: createGain(),
      mix: createGain(),
      filter: (() => {
        const f = createBiquad('lowpass');
        f.frequency.value = 4000;
        return f;
      })(),
    },
    gate: {
      threshold: (() => {
        const g = ctx.createGain();
        g.gain.value = 0;
        return g.gain; // AudioParam used as gate threshold proxy
      })(),
      attack: (() => {
        const g = ctx.createGain();
        return g.gain;
      })(),
      release: (() => {
        const g = ctx.createGain();
        return g.gain;
      })(),
      hold: (() => {
        const g = ctx.createGain();
        return g.gain;
      })(),
    },
  };
}

/* ──────────────────────────────────────────────────────────────────────────
 *  Initialization
 * ────────────────────────────────────────────────────────────────────────── */

document.addEventListener('DOMContentLoaded', () => {
  // §1 — Build all slider DOM elements from registry
  buildSliderUI();

  // §6 — Wire the reset button
  const resetBtn = document.getElementById('resetSlidersBtn');
  if (resetBtn) {
    resetBtn.addEventListener('click', resetAllSliders);
  } else {
    console.error('[app] #resetSlidersBtn not found');
  }

  // Initialize file drop zone
  initFileDropZone();

  // Keyboard support for accordion headers
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      const header = e.target.closest('.slider-group-header');
      if (header) {
        e.preventDefault();
        const group = header.closest('.slider-group');
        if (group) toggleGroup(group, header);
      }
    }
  });

  console.log(`[app] Engineer Mode initialized — ${Object.keys(SLIDER_REGISTRY).length} sliders across ${STAGES.length} groups`);
});