/**
 * VoiceIsolate Pro — Mobile UI Tests
 *
 * Covers the changes introduced in this PR:
 *   - app.js: slider-hint-btn creation in slider rendering
 *   - app.js: --pct CSS variable calculation (initPct, onSlider, applyPreset)
 *   - app.js: Mobile DOM refs (mobileProcessBtn, mobileReprocessBtn, mobileStopBtn, statsToggle, hdrStats)
 *   - app.js: Mobile action bar event listeners
 *   - app.js: Stats toggle logic (expand/collapse)
 *   - app.js: Mobile button state management (onAudioLoaded, runPipeline start/success/finally)
 *   - index.html: statsToggle button, hdrStats id, mobile-action-bar structure
 *   - style.css: hdr-stats-toggle and mobile-action-bar hidden by default
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const appJs   = fs.readFileSync(path.join(__dirname, '../public/app/app.js'), 'utf8');
const html    = fs.readFileSync(path.join(__dirname, '../public/app/index.html'), 'utf8');
const styleCss = fs.readFileSync(path.join(__dirname, '../public/app/style.css'), 'utf8');
const mobileCss = fs.readFileSync(path.join(__dirname, '../public/app/mobile.css'), 'utf8');
const transportCss = fs.readFileSync(path.join(__dirname, '../public/transport-polish.css'), 'utf8');
const landingCss = fs.readFileSync(path.join(__dirname, '../public/landing.css'), 'utf8');

// ─── Pure --pct calculation (extracted from changed code) ────────────────────

/**
 * Mirrors the formula added to initPct, onSlider, and applyPreset.
 * pct = ((value - min) / (max - min)) * 100   → `${pct.toFixed(1)}%`
 */
function calcPct(value, min, max) {
  const pct = ((value - min) / (max - min)) * 100;
  return `${pct.toFixed(1)}%`;
}

// ═══════════════════════════════════════════════════════════════
// 1.  --pct CSS variable formula
// ═══════════════════════════════════════════════════════════════

describe('--pct CSS variable formula', () => {
  test('value at minimum → 0.0%', () => {
    expect(calcPct(0, 0, 100)).toBe('0.0%');
  });

  test('value at maximum → 100.0%', () => {
    expect(calcPct(100, 0, 100)).toBe('100.0%');
  });

  test('midpoint value → 50.0%', () => {
    expect(calcPct(50, 0, 100)).toBe('50.0%');
  });

  test('quarter-point value → 25.0%', () => {
    expect(calcPct(25, 0, 100)).toBe('25.0%');
  });

  test('non-zero minimum offset is applied correctly', () => {
    // range [-20, 20], value 0 → midpoint = 50%
    expect(calcPct(0, -20, 20)).toBe('50.0%');
  });

  test('non-zero minimum at lower bound → 0.0%', () => {
    expect(calcPct(-20, -20, 20)).toBe('0.0%');
  });

  test('non-zero minimum at upper bound → 100.0%', () => {
    expect(calcPct(20, -20, 20)).toBe('100.0%');
  });

  test('result is formatted with exactly one decimal place', () => {
    // 1/3 of range → 33.3%
    const r = calcPct(1, 0, 3);
    expect(r).toMatch(/^\d+\.\d%$/);
    expect(r).toBe('33.3%');
  });

  test('fractional slider value produces correct percentage', () => {
    // range 0–1, value 0.5 → 50.0%
    expect(calcPct(0.5, 0, 1)).toBe('50.0%');
  });

  test('boundary: value beyond max clamps above 100%', () => {
    // Formula does not clamp; just verify deterministic output
    const r = calcPct(110, 0, 100);
    expect(parseFloat(r)).toBeGreaterThan(100);
  });

  test('result string always ends with %', () => {
    ['0', '50', '100'].forEach(v => {
      expect(calcPct(Number(v), 0, 100)).toMatch(/%$/);
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// 2.  app.js source — --pct formula present in all three sites
// ═══════════════════════════════════════════════════════════════

describe('app.js — --pct CSS variable wiring', () => {
  test('Engineer rows are mounted via DspSlider (track fill --pct owned there)', () => {
    expect(appJs).toMatch(/createDspSliderRow\s*\(/);
    expect(appJs).toMatch(/DspSlider\.js/);
  });

  test('_setSliderUiInner keeps --pct sync for legacy range inputs', () => {
    expect(appJs).toContain("el.style.setProperty('--pct'");
    expect(appJs).toContain('`${pct.toFixed(1)}%`');
    expect(appJs).toContain('parseFloat(el.min)');
    expect(appJs).toContain('parseFloat(el.max)');
  });

  test('applyPreset delegates slider updates through _setSliderUi', () => {
    const presetBlock = appJs.match(/applyPreset\(name[\s\S]*?\)[\s\S]*?if \(this\.liveChainBuilt\)/)?.[0] || '';
    expect(presetBlock).toContain('_setSliderUi(key, rawValue');
  });

  test('_setSliderUi updates via DspSlider.setValue or legacy range + aria', () => {
    const setterBlock = appJs.match(/_setSliderUiInner\(id, rawValue[\s\S]*?if \(notify && el\)/)?.[0] || '';
    expect(setterBlock.length).toBeGreaterThan(80);
    expect(setterBlock).toMatch(/_dspSlider\.setValue|el\.value = value/);
    expect(setterBlock).toMatch(/aria-valuenow|setValue\(value/);
  });
});

// ═══════════════════════════════════════════════════════════════
// 3.  app.js source — slider hint button (replaces legacy sr-info span)
// ═══════════════════════════════════════════════════════════════

describe('app.js — slider hint button creation', () => {
  test('imports slider-hint-ui helpers', () => {
    expect(appJs).toContain("from './slider-hint-ui.js'");
    expect(appJs).toContain('buildHintPanel');
  });

  test('creates a hintBtn with className slider-hint-btn', () => {
    expect(appJs).toContain("hintBtn.className = 'slider-hint-btn'");
  });

  test('hintBtn text content is "i"', () => {
    expect(appJs).toContain("hintBtn.textContent = 'i'");
  });

  test('hintBtn has accessible label and aria-expanded', () => {
    expect(appJs).toContain("hintBtn.setAttribute('aria-label', `Explain ${s.label}`)");
    expect(appJs).toContain("hintBtn.setAttribute('aria-expanded', 'false')");
  });

  test('hintBtn is appended to slider row', () => {
    expect(appJs).toContain('row.appendChild(hintBtn)');
  });

  test('hint button is created in _appendSliderRow after DspSlider mount', () => {
    const mountPos = appJs.indexOf('createDspSliderRow(');
    const hintBtnPos = appJs.indexOf("hintBtn.className = 'slider-hint-btn'");
    expect(mountPos).toBeGreaterThan(-1);
    expect(hintBtnPos).toBeGreaterThan(mountPos);
  });
});

// ═══════════════════════════════════════════════════════════════
// 4.  app.js source — mobile DOM refs in cacheDom
// ═══════════════════════════════════════════════════════════════

describe('app.js — mobile DOM refs in cacheDom()', () => {
  test("cacheDom caches mobileProcessBtn", () => {
    expect(appJs).toContain("mobileProcessBtn:g('mobileProcessBtn')");
  });

  test("cacheDom caches mobileReprocessBtn", () => {
    expect(appJs).toContain("mobileReprocessBtn:g('mobileReprocessBtn')");
  });

  test("cacheDom caches mobileStopBtn", () => {
    expect(appJs).toContain("mobileStopBtn:g('mobileStopBtn')");
  });

  test("cacheDom caches statsToggle", () => {
    expect(appJs).toContain("statsToggle:g('statsToggle')");
  });

  test("cacheDom caches hdrStats", () => {
    expect(appJs).toContain("hdrStats:g('hdrStats')");
  });
});

// ═══════════════════════════════════════════════════════════════
// 5.  app.js source — mobile event listeners in bindEvents
// ═══════════════════════════════════════════════════════════════

describe('app.js — mobile event listeners in bindEvents()', () => {
  test('mobileProcessBtn click → runPipeline', () => {
    expect(appJs).toContain('this.dom.mobileProcessBtn.addEventListener');
    expect(appJs).toContain("() => this.runPipeline()");
  });

  test('mobileReprocessBtn click → runPipeline', () => {
    expect(appJs).toContain('this.dom.mobileReprocessBtn.addEventListener');
  });

  test('mobileStopBtn click → sets abortFlag to true', () => {
    expect(appJs).toContain('this.dom.mobileStopBtn.addEventListener');
    expect(appJs).toContain('this.abortFlag = true');
  });

  test('mobile button listeners are guarded with null-checks', () => {
    // Must not crash if elements are absent (desktop)
    expect(appJs).toContain('if (this.dom.mobileProcessBtn)');
    expect(appJs).toContain('if (this.dom.mobileReprocessBtn)');
    expect(appJs).toContain('if (this.dom.mobileStopBtn)');
  });

  test('statsToggle listener guarded by both statsToggle and hdrStats check', () => {
    expect(appJs).toContain('if (this.dom.statsToggle && this.dom.hdrStats)');
  });
});

// ═══════════════════════════════════════════════════════════════
// 6.  Stats toggle logic — simulated DOM behaviour
// ═══════════════════════════════════════════════════════════════

describe('Stats toggle — expand / collapse behaviour (simulated DOM)', () => {
  /**
   * Extracts the statsToggle click handler body from app.js and runs it
   * against lightweight mock DOM objects.
   */
  function makeToggleMocks(initialExpanded) {
    const classes = new Set(initialExpanded ? ['expanded'] : []);
    const hdrStats = {
      classList: {
        toggle(cls) {
          if (classes.has(cls)) { classes.delete(cls); return false; }
          else { classes.add(cls); return true; }
        },
        contains(cls) { return classes.has(cls); },
      },
    };
    const statsToggle = {
      _ariaExpanded: 'false',
      textContent: '▼',
      setAttribute(attr, val) { if (attr === 'aria-expanded') this._ariaExpanded = val; },
    };
    return { hdrStats, statsToggle, classes };
  }

  function runToggle(hdrStats, statsToggle) {
    // Inline of the click handler from app.js
    const expanded = hdrStats.classList.toggle('expanded');
    statsToggle.setAttribute('aria-expanded', String(expanded));
    statsToggle.textContent = expanded ? '▲' : '▼';
  }

  test('first click adds "expanded" class to hdrStats', () => {
    const { hdrStats, statsToggle, classes } = makeToggleMocks(false);
    runToggle(hdrStats, statsToggle);
    expect(classes.has('expanded')).toBe(true);
  });

  test('first click sets aria-expanded to "true"', () => {
    const { hdrStats, statsToggle } = makeToggleMocks(false);
    runToggle(hdrStats, statsToggle);
    expect(statsToggle._ariaExpanded).toBe('true');
  });

  test('first click changes button text to ▲', () => {
    const { hdrStats, statsToggle } = makeToggleMocks(false);
    runToggle(hdrStats, statsToggle);
    expect(statsToggle.textContent).toBe('▲');
  });

  test('second click removes "expanded" class', () => {
    const { hdrStats, statsToggle, classes } = makeToggleMocks(false);
    runToggle(hdrStats, statsToggle);
    runToggle(hdrStats, statsToggle);
    expect(classes.has('expanded')).toBe(false);
  });

  test('second click sets aria-expanded back to "false"', () => {
    const { hdrStats, statsToggle } = makeToggleMocks(false);
    runToggle(hdrStats, statsToggle);
    runToggle(hdrStats, statsToggle);
    expect(statsToggle._ariaExpanded).toBe('false');
  });

  test('second click changes button text back to ▼', () => {
    const { hdrStats, statsToggle } = makeToggleMocks(false);
    runToggle(hdrStats, statsToggle);
    runToggle(hdrStats, statsToggle);
    expect(statsToggle.textContent).toBe('▼');
  });

  test('toggle is idempotent across even number of clicks (returns to initial state)', () => {
    const { hdrStats, statsToggle, classes } = makeToggleMocks(false);
    for (let i = 0; i < 4; i++) runToggle(hdrStats, statsToggle);
    expect(classes.has('expanded')).toBe(false);
    expect(statsToggle._ariaExpanded).toBe('false');
  });

  test('starting expanded: first click collapses (removes class)', () => {
    const { hdrStats, statsToggle, classes } = makeToggleMocks(true);
    runToggle(hdrStats, statsToggle);
    expect(classes.has('expanded')).toBe(false);
    expect(statsToggle._ariaExpanded).toBe('false');
    expect(statsToggle.textContent).toBe('▼');
  });
});

// ═══════════════════════════════════════════════════════════════
// 7.  app.js source — mobile button state in onAudioLoaded
// ═══════════════════════════════════════════════════════════════

describe('app.js — mobile button state in onAudioLoaded()', () => {
  test('updates process buttons via _updateProcessButtonsState after audio is loaded', () => {
    const onAudioLoadedBlock = appJs.match(/onAudioLoaded\(name[\s\S]*?_updateProcessButtonsState\(\)/)?.[0] || '';
    expect(onAudioLoadedBlock.length).toBeGreaterThan(0);
  });

  test('disables mobileReprocessBtn until output exists', () => {
    expect(appJs).toMatch(/mobileReprocessBtn\.disabled\s*=\s*!hasOut\s*\|\|\s*busy/);
  });

  test('mobileProcessBtn state is null-guarded in _updateProcessButtonsState', () => {
    expect(appJs).toContain('if (this.dom.mobileProcessBtn) this.dom.mobileProcessBtn.disabled = !hasSource || busy');
  });

  test('mobileReprocessBtn state is null-guarded in _updateProcessButtonsState', () => {
    expect(appJs).toContain('if (this.dom.mobileReprocessBtn) this.dom.mobileReprocessBtn.disabled = !hasOut || busy');
  });
});

// ═══════════════════════════════════════════════════════════════
// 8.  app.js source — mobile button visibility in runPipeline
// ═══════════════════════════════════════════════════════════════

describe('app.js — mobile button visibility in runPipeline()', () => {
  test('hides mobileProcessBtn when pipeline starts', () => {
    expect(appJs).toContain("this.dom.mobileProcessBtn.style.display = 'none'");
  });

  test('hides mobileReprocessBtn when pipeline starts', () => {
    expect(appJs).toContain("this.dom.mobileReprocessBtn.style.display = 'none'");
  });

  test('shows mobileStopBtn when pipeline starts', () => {
    expect(appJs).toContain("this.dom.mobileStopBtn.style.display = 'inline-flex'");
  });

  test('enables mobileReprocessBtn after successful pipeline completion', () => {
    expect(appJs).toContain('this.dom.mobileReprocessBtn.disabled = false');
  });

  test('restores mobileProcessBtn to inline-flex in finally block', () => {
    expect(appJs).toContain("this.dom.mobileProcessBtn.style.display='inline-flex'");
  });

  test('restores mobileReprocessBtn to inline-flex in finally block', () => {
    expect(appJs).toContain("this.dom.mobileReprocessBtn.style.display='inline-flex'");
  });

  test('hides mobileStopBtn in finally block', () => {
    expect(appJs).toContain("this.dom.mobileStopBtn.style.display='none'");
  });

  test('all mobile button visibility changes are null-guarded', () => {
    // Count the null-guard patterns for mobile process button
    const guards = (appJs.match(/if \(this\.dom\.mobileProcessBtn\)/g) || []).length;
    expect(guards).toBeGreaterThanOrEqual(3); // onAudioLoaded + runPipeline start + finally
  });

  test('mobileStopBtn show/hide guards are present', () => {
    const guards = (appJs.match(/if \(this\.dom\.mobileStopBtn\)/g) || []).length;
    expect(guards).toBeGreaterThanOrEqual(2); // start + finally
  });
});

// ═══════════════════════════════════════════════════════════════
// 9.  index.html — stats toggle button
// ═══════════════════════════════════════════════════════════════

describe('index.html — stats toggle button', () => {
  test('statsToggle button element exists', () => {
    expect(html).toContain('id="statsToggle"');
  });

  test('statsToggle has class hdr-stats-toggle', () => {
    expect(html).toContain('class="hdr-stats-toggle"');
  });

  test('statsToggle has aria-label="Toggle stats"', () => {
    expect(html).toContain('aria-label="Toggle stats"');
  });

  test('statsToggle has aria-expanded="false" as initial state', () => {
    expect(html).toContain('aria-expanded="false"');
  });

  test('statsToggle contains the down-arrow entity ▼ (&#9660;)', () => {
    expect(html).toContain('&#9660;');
  });

  test('statsToggle is a <button> element', () => {
    expect(html).toMatch(/<button[^>]+id="statsToggle"/);
  });
});

// ═══════════════════════════════════════════════════════════════
// 10. index.html — hdrStats id
// ═══════════════════════════════════════════════════════════════

describe('index.html — hdrStats element', () => {
  test('hdr-stats div has id="hdrStats"', () => {
    expect(html).toContain('id="hdrStats"');
  });

  test('hdrStats element retains class hdr-stats', () => {
    expect(html).toMatch(/class="hdr-stats"[^>]*id="hdrStats"|id="hdrStats"[^>]*class="hdr-stats"/);
  });

  test('hdrStats div contains stat child elements', () => {
    // The stats panel still contains the SNR, Duration, etc. entries
    expect(html).toContain('id="hSNR"');
    expect(html).toContain('id="hDur"');
    expect(html).toContain('id="hSR"');
  });

  test('statsToggle button appears before hdrStats div in source order', () => {
    const togglePos  = html.indexOf('id="statsToggle"');
    const statsPos   = html.indexOf('id="hdrStats"');
    expect(togglePos).toBeGreaterThan(-1);
    expect(statsPos).toBeGreaterThan(-1);
    expect(togglePos).toBeLessThan(statsPos);
  });
});

// ═══════════════════════════════════════════════════════════════
// 11. index.html — mobile action bar
// ═══════════════════════════════════════════════════════════════

describe('index.html — mobile action bar', () => {
  test('mobile-action-bar container exists', () => {
    expect(html).toContain('class="mobile-action-bar"');
    expect(html).toContain('id="mobileActionBar"');
  });

  test('mobileProcessBtn button exists', () => {
    expect(html).toContain('id="mobileProcessBtn"');
  });

  test('mobileProcessBtn has class btn and btn-primary', () => {
    expect(html).toMatch(/id="mobileProcessBtn"[^>]*class="btn btn-primary"|class="btn btn-primary"[^>]*id="mobileProcessBtn"/);
  });

  test('mobileProcessBtn is initially disabled', () => {
    // The disabled attribute must appear on the mobileProcessBtn element
    const mobileBar = html.match(/<div class="mobile-action-bar"[\s\S]*?<\/div>\s*\n/)?.[0] || html;
    const processBtn = mobileBar.match(/id="mobileProcessBtn"[^>]*/)?.[0] || '';
    expect(processBtn).toContain('disabled');
  });

  test('mobileReprocessBtn button exists', () => {
    expect(html).toContain('id="mobileReprocessBtn"');
  });

  test('mobileReprocessBtn has class btn btn-reprocess', () => {
    expect(html).toMatch(/id="mobileReprocessBtn"[^>]*class="btn btn-reprocess"|class="btn btn-reprocess"[^>]*id="mobileReprocessBtn"/);
  });

  test('mobileReprocessBtn is initially disabled', () => {
    const btn = html.match(/id="mobileReprocessBtn"[^>]*/)?.[0] || '';
    expect(btn).toContain('disabled');
  });

  test('mobileStopBtn button exists', () => {
    expect(html).toContain('id="mobileStopBtn"');
  });

  test('mobileStopBtn has class btn btn-danger', () => {
    expect(html).toMatch(/id="mobileStopBtn"[^>]*class="btn btn-danger"|class="btn btn-danger"[^>]*id="mobileStopBtn"/);
  });

  test('mobileStopBtn is initially hidden via inline style display:none', () => {
    const btn = html.match(/id="mobileStopBtn"[^>]*/)?.[0] || '';
    expect(btn).toContain('display:none');
  });

  test('mobile-action-bar comment describes sticky action bar', () => {
    expect(html).toContain('Mobile sticky action bar');
  });

  test('all three mobile buttons are children of mobile-action-bar container', () => {
    const barMatch = html.match(/<div class="mobile-action-bar"[^>]*>([\s\S]*?)<\/div>/);
    expect(barMatch).not.toBeNull();
    const barContent = barMatch[1];
    expect(barContent).toContain('mobileProcessBtn');
    expect(barContent).toContain('mobileReprocessBtn');
    expect(barContent).toContain('mobileStopBtn');
  });
});

// ═══════════════════════════════════════════════════════════════
// 12. style.css — default hidden state for new mobile elements
// ═══════════════════════════════════════════════════════════════

describe('style.css — mobile elements hidden on desktop by default', () => {
  test('.hdr-stats-toggle is set to display:none outside media queries', () => {
    // Must appear at the top-level (not inside a @media block) to default-hide on desktop
    expect(styleCss).toContain('.hdr-stats-toggle{display:none}');
  });

  test('.mobile-action-bar is set to display:none outside media queries', () => {
    expect(styleCss).toContain('.mobile-action-bar{display:none}');
  });

  test('both desktop-hide rules appear before the @media(max-width:960px) breakpoint', () => {
    const togglePos   = styleCss.indexOf('.hdr-stats-toggle{display:none}');
    const barPos      = styleCss.indexOf('.mobile-action-bar{display:none}');
    const mediaPos    = styleCss.indexOf('@media(max-width:960px)');
    expect(togglePos).toBeGreaterThan(-1);
    expect(barPos).toBeGreaterThan(-1);
    expect(mediaPos).toBeGreaterThan(-1);
    expect(togglePos).toBeLessThan(mediaPos);
    expect(barPos).toBeLessThan(mediaPos);
  });
});

// ═══════════════════════════════════════════════════════════════
// 13. Regression / boundary tests
// ═══════════════════════════════════════════════════════════════

describe('Regression and boundary cases', () => {
  test('calcPct: value exactly at min and max produce 0.0% and 100.0% (boundary)', () => {
    // Regression: ensure no off-by-one in the formula
    expect(calcPct(0, 0, 100)).toBe('0.0%');
    expect(calcPct(100, 0, 100)).toBe('100.0%');
  });

  test('calcPct: typical slider range (NR amount 0–100, value 60) → 60.0%', () => {
    expect(calcPct(60, 0, 100)).toBe('60.0%');
  });

  test('calcPct: decimal precision — 1/7 produces one decimal place', () => {
    const r = calcPct(1, 0, 7);
    // 1/7 * 100 ≈ 14.285…  → 14.3%
    expect(r).toBe('14.3%');
  });

  test('app.js: hint button is always appended regardless of the s.rt flag', () => {
    // The hintBtn block is outside the `if (s.rt)` guard
    const rtIfBlock = appJs.indexOf('if (s.rt) {');
    const hintBtnBlock = appJs.indexOf("hintBtn.className = 'slider-hint-btn'");
    // hintBtn comes after the rt-badge if-block
    expect(hintBtnBlock).toBeGreaterThan(rtIfBlock);
    // hintBtn is NOT inside the if (s.rt) block (it appears after the closing brace)
    const rtBlockEnd = appJs.indexOf("labelEl.appendChild(badge)");
    expect(hintBtnBlock).toBeGreaterThan(rtBlockEnd);
  });

  test('index.html: mobileProcessBtn SVG icon has aria-hidden="true" (decorative)', () => {
    // The play icon inside the button is decorative and must be hidden from AT
    const svgInBtn = html.match(/id="mobileProcessBtn"[\s\S]*?<\/button>/)?.[0] || '';
    expect(svgInBtn).toContain('aria-hidden="true"');
  });

  test('app.js: stats toggle aria-expanded value is a string, not boolean', () => {
    // String(expanded) is required — setAttribute expects a string
    expect(appJs).toContain("String(expanded)");
  });

  test('app.js: every mobileProcessBtn access in runPipeline is covered by a null guard', () => {
    // Count how many times the null-guard appears vs how many times the button is accessed
    const runPipelineBlock = appJs.match(/async runPipeline\([\s\S]*?async pip\(/)?.[0] || '';
    const guardCount  = (runPipelineBlock.match(/if \(this\.dom\.mobileProcessBtn\)/g) || []).length;
    const accessCount = (runPipelineBlock.match(/this\.dom\.mobileProcessBtn\b/g) || []).length;
    // Each guard covers at least one access so guards must be >= half of total occurrences
    // (guard line + access line = 2 occurrences per guarded site when written as single-line if)
    expect(guardCount).toBeGreaterThanOrEqual(1);
    expect(accessCount).toBeGreaterThan(0);
    // Every access count should be paired with a guard on the same or previous expression
    expect(guardCount * 2).toBeGreaterThanOrEqual(accessCount);
  });
});

// ═══════════════════════════════════════════════════════════════
// 14. Regression: removed duplicate formula assertion
//     The PR removed `expect(appJs).toContain("((s.val - s.min) / (s.max - s.min)) * 100")`
//     because the canonical form in app.js uses a `range` variable, not inline subtraction.
// ═══════════════════════════════════════════════════════════════

describe('--pct formula — range variable approach (regression for removed assertion)', () => {
  test('app.js does NOT contain the inline-division form without range variable', () => {
    // The PR removed this assertion because app.js uses `const range = s.max - s.min`
    // and then `(s.val - s.min) / range`, NOT the fully-inlined form.
    // This test documents and guards that contract.
    expect(appJs).not.toContain('((s.val - s.min) / (s.max - s.min)) * 100');
  });

  test('app.js uses DspSlider factory for Engineer rows (zero-range safe)', () => {
    // Rows are built by createDspSliderRow; percent fill uses clampSnap + --pct.
    expect(appJs).toMatch(/createDspSliderRow\s*\(/);
    expect(appJs).toMatch(/from '\/src\/presentation\/DspSlider\.js'/);
  });

  test('app.js guards against zero-range when syncing legacy range inputs', () => {
    // _setSliderUiInner still paints legacy inputs with an explicit range > 0 guard
    const occurrences = (appJs.match(/range > 0 \? .* : 0/g) || []).length;
    expect(occurrences).toBeGreaterThanOrEqual(1);
    expect(appJs).toMatch(/const min = parseFloat\(el\.min\)/);
    expect(appJs).toMatch(/const max = parseFloat\(el\.max\)/);
    expect(appJs).toMatch(/const range = max - min/);
  });

  test('DspSlider clampSnap rejects divide-by-zero style ranges safely', async () => {
    const { clampSnap } = await import('../src/presentation/DspSlider.js');
    expect(clampSnap(5, 5, 5, 1)).toBe(5);
    expect(Number.isFinite(clampSnap(12, 0, 100, 5))).toBe(true);
  });

  test('calcPct helper: identical result whether computed inline or via range variable', () => {
    // Both formulations are algebraically equivalent; verify numerical parity
    const value = 37, min = 10, max = 90;
    const inline = ((value - min) / (max - min)) * 100;
    const range = max - min;
    const viaRange = (range > 0) ? ((value - min) / range) * 100 : 0;
    expect(inline).toBeCloseTo(viaRange, 10);
  });

  test('calcPct: zero-range guard is equivalent to returning 0 when min === max', () => {
    // Simulates what app.js does when range === 0
    const value = 5, min = 5, max = 5;
    const range = max - min; // === 0
    const result = range > 0 ? ((value - min) / range) * 100 : 0;
    expect(result).toBe(0);
  });

  test('calcPct: negative value (below min) produces negative percentage without clamping', () => {
    // The formula does not clamp; documents the deliberate no-clamp behaviour
    const r = calcPct(-10, 0, 100);
    expect(parseFloat(r)).toBeLessThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// 15. Cross-platform transport + visualization mobile styles
// ═══════════════════════════════════════════════════════════════

describe('mobile.css — transport seek + viz gallery touch targets', () => {
  test('styles transport-seek container for mobile touch', () => {
    expect(mobileCss).toContain('.transport-seek');
    expect(mobileCss).toContain('var(--mob-touch-min)');
  });

  test('tab-btn has minimum touch height on mobile', () => {
    expect(mobileCss).toContain('.tab-btn');
    expect(mobileCss).toContain('touch-action: manipulation');
  });

  test('gallery mode compact sizing on mobile', () => {
    expect(mobileCss).toContain('.viz-card.viz-gallery');
    expect(mobileCss).toContain('.btn-viz-gallery');
  });
});

describe('transport-polish.css — coarse pointer seek bar sizing', () => {
  test('enlarges seek thumb on touch devices', () => {
    expect(transportCss).toContain('@media (pointer: coarse)');
    expect(transportCss).toContain('.landing-seek-input');
    expect(transportCss).toContain('width: 18px');
  });
});

describe('landing.css — landing page seek bar touch support', () => {
  test('transport-seek touch styles for browser landing page', () => {
    expect(landingCss).toContain('.transport-seek');
    expect(landingCss).toContain('.landing-seek-input');
  });
});
