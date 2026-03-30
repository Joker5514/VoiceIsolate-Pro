/**
 * VoiceIsolate Pro v21 — Mobile UI Tests
 *
 * Covers changes introduced in this PR:
 *   - app.js: sr-info element, --pct CSS variable, mobile DOM refs, mobile event
 *             listeners, statsToggle handler, onSlider/applyPreset --pct update,
 *             mobile button state/visibility management
 *   - index.html: statsToggle button, hdrStats id, mobile-action-bar elements
 *   - style.css:  .sr-info rules, --pct gradient, desktop display:none for new elements
 *   - mobile.css: new CSS variables, hdr-stats.expanded, hdr-stats-toggle, mobile
 *                 action bar, .sr-info hidden on mobile
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const appJs    = fs.readFileSync(path.join(ROOT, 'public/app/app.js'),    'utf8');
const indexHtml = fs.readFileSync(path.join(ROOT, 'public/app/index.html'), 'utf8');
const styleCss  = fs.readFileSync(path.join(ROOT, 'public/app/style.css'),  'utf8');
const mobileCss = fs.readFileSync(path.join(ROOT, 'public/app/mobile.css'), 'utf8');

// ─── Pure math helpers (extracted from the PR's calculation logic) ──────────

/**
 * Replicates the --pct calculation used in buildSliders, onSlider, and applyPreset.
 * Returns a string like "37.5%".
 */
function calcPct(val, min, max) {
  const pct = ((val - min) / (max - min)) * 100;
  return `${pct.toFixed(1)}%`;
}

// ════════════════════════════════════════════════════════════════════════════
// 1. app.js — sr-info element creation in buildSliders
// ════════════════════════════════════════════════════════════════════════════

describe('app.js — sr-info element creation', () => {
  test('creates an element with class "sr-info"', () => {
    expect(appJs).toContain("infoEl.className = 'sr-info'");
  });

  test('sets textContent of sr-info to "i"', () => {
    expect(appJs).toContain("infoEl.textContent = 'i'");
  });

  test('marks sr-info as aria-hidden="true"', () => {
    expect(appJs).toContain("infoEl.setAttribute('aria-hidden', 'true')");
  });

  test('appends sr-info to the label element', () => {
    expect(appJs).toContain('labelEl.appendChild(infoEl)');
  });

  test('sr-info is created as a span element', () => {
    // buildSliders uses document.createElement('span') for infoEl
    const match = appJs.match(/const infoEl = document\.createElement\('(\w+)'\)/);
    expect(match).not.toBeNull();
    expect(match[1]).toBe('span');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. app.js — --pct CSS variable calculation (pure math)
// ════════════════════════════════════════════════════════════════════════════

describe('app.js — --pct CSS variable calculation formula', () => {
  test('midpoint value maps to 50.0%', () => {
    expect(calcPct(0, -12, 12)).toBe('50.0%');
  });

  test('minimum value maps to 0.0%', () => {
    expect(calcPct(0, 0, 100)).toBe('0.0%');
  });

  test('maximum value maps to 100.0%', () => {
    expect(calcPct(100, 0, 100)).toBe('100.0%');
  });

  test('75% of range maps to 75.0%', () => {
    expect(calcPct(75, 0, 100)).toBe('75.0%');
  });

  test('negative range: -6 between -24 and 0 maps to 75.0%', () => {
    expect(calcPct(-6, -24, 0)).toBe('75.0%');
  });

  test('toFixed(1) produces exactly one decimal place', () => {
    // 1/3 of range → 33.3...% → rounded to 33.3%
    expect(calcPct(1, 0, 3)).toBe('33.3%');
  });

  test('value equal to min yields exactly "0.0%"', () => {
    expect(calcPct(-24, -24, 24)).toBe('0.0%');
  });

  test('value equal to max yields exactly "100.0%"', () => {
    expect(calcPct(24, -24, 24)).toBe('100.0%');
  });

  test('integer result still has one decimal place (e.g. 25.0%)', () => {
    expect(calcPct(25, 0, 100)).toBe('25.0%');
  });
});

describe('app.js — buildSliders --pct initialisation code', () => {
  test('initPct variable is declared and computed from s.val, s.min, s.max', () => {
    expect(appJs).toContain('const initPct = ((s.val - s.min) / (s.max - s.min)) * 100');
  });

  test('--pct CSS property is set on the input element using initPct', () => {
    expect(appJs).toContain("inputEl.style.setProperty('--pct', `${initPct.toFixed(1)}%`)");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. app.js — mobile DOM element references in cacheDom
// ════════════════════════════════════════════════════════════════════════════

describe('app.js — mobile DOM element references in cacheDom', () => {
  test('cacheDom references mobileProcessBtn', () => {
    expect(appJs).toContain("mobileProcessBtn:g('mobileProcessBtn')");
  });

  test('cacheDom references mobileReprocessBtn', () => {
    expect(appJs).toContain("mobileReprocessBtn:g('mobileReprocessBtn')");
  });

  test('cacheDom references mobileStopBtn', () => {
    expect(appJs).toContain("mobileStopBtn:g('mobileStopBtn')");
  });

  test('cacheDom references statsToggle', () => {
    expect(appJs).toContain("statsToggle:g('statsToggle')");
  });

  test('cacheDom references hdrStats', () => {
    expect(appJs).toContain("hdrStats:g('hdrStats')");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. app.js — mobile event listeners in bindEvents
// ════════════════════════════════════════════════════════════════════════════

describe('app.js — mobile event listeners in bindEvents', () => {
  test('mobileProcessBtn click calls runPipeline', () => {
    expect(appJs).toContain(
      "this.dom.mobileProcessBtn.addEventListener('click', () => this.runPipeline())"
    );
  });

  test('mobileReprocessBtn click calls runPipeline', () => {
    expect(appJs).toContain(
      "this.dom.mobileReprocessBtn.addEventListener('click', () => this.runPipeline())"
    );
  });

  test('mobileStopBtn click sets abortFlag to true', () => {
    expect(appJs).toContain(
      "this.dom.mobileStopBtn.addEventListener('click', () => { this.abortFlag = true; })"
    );
  });

  test('mobile button listeners are guarded with null checks', () => {
    // Each binding uses "if (this.dom.mobileXxx)" before addEventListener
    expect(appJs).toMatch(/if \(this\.dom\.mobileProcessBtn\)\s+this\.dom\.mobileProcessBtn\.addEventListener/);
    expect(appJs).toMatch(/if \(this\.dom\.mobileReprocessBtn\)\s+this\.dom\.mobileReprocessBtn\.addEventListener/);
    expect(appJs).toMatch(/if \(this\.dom\.mobileStopBtn\)\s+this\.dom\.mobileStopBtn\.addEventListener/);
  });

  test('statsToggle handler checks both statsToggle and hdrStats before binding', () => {
    expect(appJs).toContain('if (this.dom.statsToggle && this.dom.hdrStats)');
  });

  test('statsToggle click toggles "expanded" class on hdrStats', () => {
    expect(appJs).toContain("this.dom.hdrStats.classList.toggle('expanded')");
  });

  test('statsToggle updates aria-expanded attribute on click', () => {
    expect(appJs).toContain("this.dom.statsToggle.setAttribute('aria-expanded', String(expanded))");
  });

  test('statsToggle textContent changes to ▲ when expanded', () => {
    expect(appJs).toContain("this.dom.statsToggle.textContent = expanded ? '▲' : '▼'");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. app.js — onSlider --pct update
// ════════════════════════════════════════════════════════════════════════════

describe('app.js — onSlider --pct CSS variable update', () => {
  test('onSlider computes pct using parseFloat of el.min and el.max', () => {
    expect(appJs).toContain(
      'const pct = ((v - parseFloat(el.min)) / (parseFloat(el.max) - parseFloat(el.min))) * 100'
    );
  });

  test('onSlider calls setProperty with --pct and toFixed(1)% string', () => {
    expect(appJs).toContain("el.style.setProperty('--pct', `${pct.toFixed(1)}%`)");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 6. app.js — applyPreset --pct update
// ════════════════════════════════════════════════════════════════════════════

describe('app.js — applyPreset --pct CSS variable update', () => {
  test('applyPreset computes pct from params, s.min, s.max', () => {
    expect(appJs).toContain(
      'const pct = ((this.params[s.id] - s.min) / (s.max - s.min)) * 100'
    );
  });

  test('applyPreset calls setProperty with --pct on the slider element', () => {
    // Locate the applyPreset method and verify --pct appears after the pct calculation
    const applyPresetIdx = appJs.indexOf('applyPreset(name)');
    expect(applyPresetIdx).toBeGreaterThan(-1);
    // The --pct setProperty must appear within reasonable distance after applyPreset
    const applyPresetChunk = appJs.substring(applyPresetIdx, applyPresetIdx + 800);
    expect(applyPresetChunk).toContain("el.style.setProperty('--pct'");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 7. app.js — mobile button state management in onAudioLoaded
// ════════════════════════════════════════════════════════════════════════════

describe('app.js — onAudioLoaded mobile button state', () => {
  test('enables mobileProcessBtn when audio is loaded', () => {
    expect(appJs).toContain('if (this.dom.mobileProcessBtn) this.dom.mobileProcessBtn.disabled = false');
  });

  test('disables mobileReprocessBtn when audio is first loaded', () => {
    expect(appJs).toContain('if (this.dom.mobileReprocessBtn) this.dom.mobileReprocessBtn.disabled = true');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 8. app.js — mobile button visibility during pipeline execution
// ════════════════════════════════════════════════════════════════════════════

describe('app.js — runPipeline mobile button visibility', () => {
  test('hides mobileProcessBtn when pipeline starts', () => {
    expect(appJs).toContain(
      "if (this.dom.mobileProcessBtn)   this.dom.mobileProcessBtn.style.display = 'none'"
    );
  });

  test('hides mobileReprocessBtn when pipeline starts', () => {
    expect(appJs).toContain(
      "if (this.dom.mobileReprocessBtn) this.dom.mobileReprocessBtn.style.display = 'none'"
    );
  });

  test('shows mobileStopBtn when pipeline starts', () => {
    expect(appJs).toContain(
      "if (this.dom.mobileStopBtn)      this.dom.mobileStopBtn.style.display = 'inline-flex'"
    );
  });

  test('restores mobileProcessBtn visibility in finally block', () => {
    expect(appJs).toContain(
      "if (this.dom.mobileProcessBtn)   { this.dom.mobileProcessBtn.style.display='inline-flex'; }"
    );
  });

  test('restores mobileReprocessBtn visibility in finally block', () => {
    expect(appJs).toContain(
      "if (this.dom.mobileReprocessBtn) { this.dom.mobileReprocessBtn.style.display='inline-flex'; }"
    );
  });

  test('hides mobileStopBtn in finally block', () => {
    expect(appJs).toContain(
      "if (this.dom.mobileStopBtn)      this.dom.mobileStopBtn.style.display='none'"
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 9. app.js — mobileReprocessBtn enabled after successful pipeline
// ════════════════════════════════════════════════════════════════════════════

describe('app.js — mobileReprocessBtn state after pipeline completion', () => {
  test('enables mobileReprocessBtn when pipeline completes successfully', () => {
    expect(appJs).toContain(
      'if (this.dom.mobileReprocessBtn) this.dom.mobileReprocessBtn.disabled = false'
    );
  });

  test('mobileReprocessBtn enable appears in the pipeline success path, not only in finally', () => {
    // Look for the disabled = false assignment (success path) vs the display restoration (finally)
    const successPath = appJs.match(/this\.dom\.saveProcBtn\.disabled = false[\s\S]{0,200}mobileReprocessBtn/);
    expect(successPath).not.toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 10. index.html — statsToggle button
// ════════════════════════════════════════════════════════════════════════════

describe('index.html — statsToggle button', () => {
  test('contains an element with id="statsToggle"', () => {
    expect(indexHtml).toContain('id="statsToggle"');
  });

  test('statsToggle has class "hdr-stats-toggle"', () => {
    expect(indexHtml).toContain('class="hdr-stats-toggle"');
  });

  test('statsToggle has aria-label="Toggle stats"', () => {
    expect(indexHtml).toContain('aria-label="Toggle stats"');
  });

  test('statsToggle initial aria-expanded is "false"', () => {
    expect(indexHtml).toMatch(/id="statsToggle"[^>]*aria-expanded="false"|aria-expanded="false"[^>]*id="statsToggle"/);
  });

  test('statsToggle is a <button> element', () => {
    expect(indexHtml).toMatch(/<button[^>]+id="statsToggle"/);
  });

  test('statsToggle contains the ▼ down-arrow character initially', () => {
    // &#9660; is ▼
    expect(indexHtml).toMatch(/id="statsToggle"[^>]*>&#9660;/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 11. index.html — hdrStats div with id
// ════════════════════════════════════════════════════════════════════════════

describe('index.html — hdrStats div', () => {
  test('hdr-stats div now has id="hdrStats"', () => {
    expect(indexHtml).toContain('id="hdrStats"');
  });

  test('the element with id="hdrStats" also has class "hdr-stats"', () => {
    expect(indexHtml).toMatch(/class="hdr-stats"[^>]*id="hdrStats"|id="hdrStats"[^>]*class="hdr-stats"/);
  });

  test('hdrStats contains stat children (SNR, Duration, etc.)', () => {
    expect(indexHtml).toContain('id="hSNR"');
    expect(indexHtml).toContain('id="hDur"');
    expect(indexHtml).toContain('id="hSR"');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 12. index.html — mobile action bar
// ════════════════════════════════════════════════════════════════════════════

describe('index.html — mobile action bar structure', () => {
  test('contains the mobile-action-bar container', () => {
    expect(indexHtml).toContain('class="mobile-action-bar"');
  });

  test('mobile-action-bar has id="mobileActionBar"', () => {
    expect(indexHtml).toContain('id="mobileActionBar"');
  });

  test('contains mobileProcessBtn', () => {
    expect(indexHtml).toContain('id="mobileProcessBtn"');
  });

  test('contains mobileReprocessBtn', () => {
    expect(indexHtml).toContain('id="mobileReprocessBtn"');
  });

  test('contains mobileStopBtn', () => {
    expect(indexHtml).toContain('id="mobileStopBtn"');
  });

  test('mobileProcessBtn is initially disabled', () => {
    expect(indexHtml).toMatch(/id="mobileProcessBtn"[^>]*disabled|disabled[^>]*id="mobileProcessBtn"/);
  });

  test('mobileReprocessBtn is initially disabled', () => {
    expect(indexHtml).toMatch(/id="mobileReprocessBtn"[^>]*disabled|disabled[^>]*id="mobileReprocessBtn"/);
  });

  test('mobileStopBtn is initially hidden via inline style', () => {
    expect(indexHtml).toMatch(/id="mobileStopBtn"[^>]*style="display:none"|style="display:none"[^>]*id="mobileStopBtn"/);
  });

  test('mobileProcessBtn uses btn-primary class', () => {
    expect(indexHtml).toMatch(/id="mobileProcessBtn"[^>]*class="btn btn-primary"|class="btn btn-primary"[^>]*id="mobileProcessBtn"/);
  });

  test('mobileProcessBtn contains a play icon SVG with aria-hidden', () => {
    // The SVG inside the process button has aria-hidden="true"
    const mobileBarBlock = indexHtml.match(/id="mobileActionBar"[\s\S]*?<\/div>/);
    expect(mobileBarBlock).not.toBeNull();
    expect(mobileBarBlock[0]).toContain('aria-hidden="true"');
  });

  test('mobile-action-bar appears after the footer element', () => {
    const footerIdx    = indexHtml.indexOf('</footer>');
    const mobileBarIdx = indexHtml.indexOf('id="mobileActionBar"');
    expect(footerIdx).toBeGreaterThan(-1);
    expect(mobileBarIdx).toBeGreaterThan(-1);
    expect(mobileBarIdx).toBeGreaterThan(footerIdx);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 13. style.css — .sr-info rules
// ════════════════════════════════════════════════════════════════════════════

describe('style.css — .sr-info CSS class', () => {
  test('.sr-info class is defined', () => {
    expect(styleCss).toContain('.sr-info');
  });

  test('.sr-info uses display:inline-flex', () => {
    expect(styleCss).toMatch(/\.sr-info\{[^}]*display:inline-flex/);
  });

  test('.sr-info has border-radius:50% (circular badge)', () => {
    expect(styleCss).toMatch(/\.sr-info\{[^}]*border-radius:50%/);
  });

  test('.sr-info has pointer-events:none (non-interactive)', () => {
    expect(styleCss).toMatch(/\.sr-info\{[^}]*pointer-events:none/);
  });

  test('.sr-info has margin-left:auto (pushes to right of label)', () => {
    expect(styleCss).toMatch(/\.sr-info\{[^}]*margin-left:auto/);
  });

  test('.sr-info has flex-shrink:0 (prevents compression)', () => {
    expect(styleCss).toMatch(/\.sr-info\{[^}]*flex-shrink:0/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 14. style.css — --pct CSS variable usage in range input
// ════════════════════════════════════════════════════════════════════════════

describe('style.css — --pct CSS variable in slider track gradient', () => {
  test('input[type="range"] background uses --pct variable', () => {
    expect(styleCss).toContain('var(--pct');
  });

  test('default track gradient goes from red to a surface colour split at --pct', () => {
    expect(styleCss).toContain(
      'background:linear-gradient(to right,var(--red) 0%,var(--red) var(--pct,50%),var(--s4) var(--pct,50%),var(--s4) 100%)'
    );
  });

  test('realtime slider uses --pct with cyan colour', () => {
    expect(styleCss).toContain(
      'background:linear-gradient(to right,var(--cyan) 0%,var(--cyan) var(--pct,50%),var(--s4) var(--pct,50%),var(--s4) 100%)'
    );
  });

  test('fallback default for --pct is 50%', () => {
    expect(styleCss).toContain('var(--pct,50%)');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 15. style.css — desktop display:none for new mobile elements
// ════════════════════════════════════════════════════════════════════════════

describe('style.css — new mobile elements hidden on desktop', () => {
  test('.hdr-stats-toggle is hidden by default (display:none)', () => {
    expect(styleCss).toContain('.hdr-stats-toggle{display:none}');
  });

  test('.mobile-action-bar is hidden by default (display:none)', () => {
    expect(styleCss).toContain('.mobile-action-bar{display:none}');
  });

  test('both hide rules appear before the responsive media queries', () => {
    const toggleIdx    = styleCss.indexOf('.hdr-stats-toggle{display:none}');
    const actionBarIdx = styleCss.indexOf('.mobile-action-bar{display:none}');
    const mediaIdx     = styleCss.indexOf('@media(max-width:960px)');
    expect(toggleIdx).toBeLessThan(mediaIdx);
    expect(actionBarIdx).toBeLessThan(mediaIdx);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 16. mobile.css — new CSS custom properties
// ════════════════════════════════════════════════════════════════════════════

describe('mobile.css — new CSS custom properties', () => {
  test('defines --mob-slider-track', () => {
    expect(mobileCss).toContain('--mob-slider-track');
  });

  test('defines --mob-slider-thumb', () => {
    expect(mobileCss).toContain('--mob-slider-thumb');
  });

  test('defines --mob-touch-min', () => {
    expect(mobileCss).toContain('--mob-touch-min');
  });

  test('--mob-slider-track is defined with a pixel value', () => {
    expect(mobileCss).toMatch(/--mob-slider-track:\s*\d+px/);
  });

  test('--mob-slider-thumb is defined with a pixel value', () => {
    expect(mobileCss).toMatch(/--mob-slider-thumb:\s*\d+px/);
  });

  test('--mob-touch-min is 44px (WCAG 2.5.5 minimum touch target)', () => {
    expect(mobileCss).toMatch(/--mob-touch-min:\s*44px/);
  });

  test('new properties are declared inside the :root block', () => {
    const rootBlock = mobileCss.match(/:root\s*\{([\s\S]*?)\}/);
    expect(rootBlock).not.toBeNull();
    expect(rootBlock[1]).toContain('--mob-slider-track');
    expect(rootBlock[1]).toContain('--mob-slider-thumb');
    expect(rootBlock[1]).toContain('--mob-touch-min');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 17. mobile.css — .hdr-stats.expanded styles
// ════════════════════════════════════════════════════════════════════════════

describe('mobile.css — .hdr-stats.expanded styles', () => {
  test('.hdr-stats.expanded is defined', () => {
    expect(mobileCss).toContain('.hdr-stats.expanded');
  });

  test('.hdr-stats.expanded uses display:grid (grid layout when expanded)', () => {
    expect(mobileCss).toMatch(/\.hdr-stats\.expanded\s*\{[^}]*display:\s*grid/);
  });

  test('.hdr-stats is hidden by default in mobile (display:none)', () => {
    expect(mobileCss).toMatch(/\.hdr-stats\s*\{\s*display:\s*none/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 18. mobile.css — .hdr-stats-toggle styles in mobile media query
// ════════════════════════════════════════════════════════════════════════════

describe('mobile.css — .hdr-stats-toggle visible on mobile', () => {
  test('.hdr-stats-toggle is shown on mobile with display:flex', () => {
    expect(mobileCss).toMatch(/\.hdr-stats-toggle\s*\{[^}]*display:\s*flex/);
  });

  test('.hdr-stats-toggle has a defined width', () => {
    expect(mobileCss).toMatch(/\.hdr-stats-toggle\s*\{[^}]*width:/);
  });

  test('.hdr-stats-toggle has a defined height', () => {
    expect(mobileCss).toMatch(/\.hdr-stats-toggle\s*\{[^}]*height:/);
  });

  test('.hdr-stats-toggle has cursor:pointer', () => {
    expect(mobileCss).toMatch(/\.hdr-stats-toggle\s*\{[^}]*cursor:\s*pointer/);
  });

  test('.hdr-stats-toggle has border-radius for rounded appearance', () => {
    expect(mobileCss).toMatch(/\.hdr-stats-toggle\s*\{[^}]*border-radius:/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 19. mobile.css — mobile action bar styles
// ════════════════════════════════════════════════════════════════════════════

describe('mobile.css — sticky mobile action bar styles', () => {
  test('.mobile-action-bar is defined inside a max-width:768px media query', () => {
    // Find the 768px block
    const media768 = mobileCss.match(/@media \(max-width: 768px\)([\s\S]*?)(?=@media|\s*$)/g);
    expect(media768).not.toBeNull();
    const hasBar = media768.some(block => block.includes('.mobile-action-bar'));
    expect(hasBar).toBe(true);
  });

  test('.mobile-action-bar uses position:fixed', () => {
    expect(mobileCss).toMatch(/\.mobile-action-bar\s*\{[^}]*position:\s*fixed/);
  });

  test('.mobile-action-bar is anchored to bottom:0', () => {
    expect(mobileCss).toMatch(/\.mobile-action-bar\s*\{[^}]*bottom:\s*0/);
  });

  test('.mobile-action-bar has z-index:200 (above content)', () => {
    expect(mobileCss).toMatch(/\.mobile-action-bar\s*\{[^}]*z-index:\s*200/);
  });

  test('.mobile-action-bar spans full width (left:0 and right:0)', () => {
    const barBlock = mobileCss.match(/\.mobile-action-bar\s*\{([^}]*)\}/);
    expect(barBlock).not.toBeNull();
    expect(barBlock[1]).toContain('left: 0');
    expect(barBlock[1]).toContain('right: 0');
  });

  test('.mobile-action-bar respects safe-area-inset-bottom for notch devices', () => {
    expect(mobileCss).toMatch(/\.mobile-action-bar\s*\{[^}]*var\(--safe-bottom\)/);
  });

  test('.mobile-action-bar uses display:flex for horizontal layout', () => {
    expect(mobileCss).toMatch(/\.mobile-action-bar\s*\{[^}]*display:\s*flex/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 20. mobile.css — .sr-info hidden on mobile (touch tooltips not useful)
// ════════════════════════════════════════════════════════════════════════════

describe('mobile.css — .sr-info hidden on mobile', () => {
  test('.sr-info has display:none in the mobile stylesheet', () => {
    expect(mobileCss).toContain('.sr-info { display: none; }');
  });

  test('.sr-info hide rule is inside a max-width media query', () => {
    // Confirm it is inside a @media block, not at the root level
    const srInfoIdx = mobileCss.indexOf('.sr-info { display: none; }');
    // Find the nearest @media opening before this position
    const beforeRule = mobileCss.substring(0, srInfoIdx);
    const lastMedia  = beforeRule.lastIndexOf('@media');
    expect(lastMedia).toBeGreaterThan(-1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 21. mobile.css — actions-row hidden when mobile action bar is active
// ════════════════════════════════════════════════════════════════════════════

describe('mobile.css — in-panel actions-row hidden when mobile bar is shown', () => {
  test('.actions-row is hidden inside the 768px breakpoint', () => {
    // actions-row is set to display: none in mobile so the sticky bar takes over
    expect(mobileCss).toContain('.actions-row { display: none; }');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 22. mobile.css — touch pointer min-height uses --mob-touch-min variable
// ════════════════════════════════════════════════════════════════════════════

describe('mobile.css — touch target min-height uses CSS variable', () => {
  test('min-height for buttons references --mob-touch-min', () => {
    expect(mobileCss).toContain('min-height: var(--mob-touch-min)');
  });

  test('min-width for buttons references --mob-touch-min', () => {
    expect(mobileCss).toContain('min-width: var(--mob-touch-min)');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 23. mobile.css — slider track and thumb use --mob-slider-track/thumb vars
// ════════════════════════════════════════════════════════════════════════════

describe('mobile.css — slider track and thumb sizing via CSS variables', () => {
  test('input[type="range"] height references --mob-slider-track', () => {
    expect(mobileCss).toContain('height: var(--mob-slider-track)');
  });

  test('slider thumb width references --mob-slider-thumb', () => {
    expect(mobileCss).toContain('width: var(--mob-slider-thumb)');
  });

  test('slider thumb height references --mob-slider-thumb', () => {
    expect(mobileCss).toContain('height: var(--mob-slider-thumb)');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 24. Regression — old ::after pseudo-element info icon removed from CSS
// ════════════════════════════════════════════════════════════════════════════

describe('style.css — old ::after info icon removed (replaced by sr-info element)', () => {
  test('sr-label::after with ⓘ content is no longer present', () => {
    // The old implementation used .sr-label::after { content:'ⓘ' }
    // It was replaced by the JS-generated .sr-info span
    expect(styleCss).not.toContain(".sr-label::after{content:'ⓘ'");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 25. Regression — old border-bottom separator on .sr-row removed
// ════════════════════════════════════════════════════════════════════════════

describe('style.css — .sr-row styling updated', () => {
  test('.sr-row no longer uses border-bottom for separation', () => {
    // Old: border-bottom:1px solid rgba(255,255,255,0.02)
    // New: uses hover background instead
    expect(styleCss).not.toContain('border-bottom:1px solid rgba(255,255,255,0.02)');
  });

  test('.sr-row now has a hover background transition', () => {
    expect(styleCss).toContain('.sr-row:hover{background:rgba(255,255,255,0.024)}');
  });
});