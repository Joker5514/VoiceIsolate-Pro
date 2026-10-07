/**
 * WhisperHunter visibility + UI freeze regressions.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(ROOT, 'public/app/app.js'), 'utf8');
const tierJs = fs.readFileSync(path.join(ROOT, 'public/app/workflow-tier.js'), 'utf8');
const dspCore = fs.readFileSync(path.join(ROOT, 'public/app/dsp-core.js'), 'utf8');
const yieldJs = fs.readFileSync(path.join(ROOT, 'src/pipeline/ui-yield.js'), 'utf8');

describe('WhisperHunter AI restored', () => {
  test('button exists in Engineer HTML', () => {
    const html = fs.readFileSync(path.join(ROOT, 'public/app/index.html'), 'utf8');
    expect(html).toContain('id="btn-whisper-hunter"');
  });

  test('all workflow tiers enable WhisperHunter', () => {
    expect(tierJs).toMatch(/showWhisperHunter:\s*true/);
    // Must not hide button via display:none for tiers
    expect(tierJs).toContain("whisperBtn.hidden = false");
    expect(tierJs).toContain("whisperBtn.style.display = ''");
  });

  test('WHISPER_HUNTER orchestrator is wired', () => {
    expect(appJs).toContain('const WHISPER_HUNTER');
    expect(appJs).toContain('btn-whisper-hunter');
    expect(appJs).toContain('ensureWhisperHunterInstance');
  });

  test('dead preset Whisper Room is not selected', () => {
    expect(appJs).not.toContain("return 'Whisper Room'");
    expect(appJs).toContain("return 'Whisper Boost'");
  });
});

describe('UI freeze mitigations', () => {
  test('async STFT with UI yields exists in dsp-core', () => {
    expect(dspCore).toContain('forwardSTFTAsync');
    expect(dspCore).toContain('inverseSTFTAsync');
    // Yields are time-budgeted (CLAUDE.md §1.2): the caller's maybeYield,
    // never a per-yield rAF await, which is 0 Hz in a hidden tab.
    expect(dspCore).toContain('opts.maybeYield');
    expect(dspCore).not.toMatch(/requestAnimationFrame\(/);
    // Every async STFT call site passes the budget, directly or via stftOpts.
    const starts = [...appJs.matchAll(/await DSP\.(forward|inverse)STFTAsync\(/g)].map((m) => m.index);
    expect(starts.length).toBeGreaterThanOrEqual(2);
    const stftOpts = appJs.slice(appJs.indexOf('const stftOpts = {'), appJs.indexOf('};', appJs.indexOf('const stftOpts = {')));
    for (const at of starts) {
      // The call's arguments run up to the synchronous ternary branch.
      const args = appJs.slice(at, appJs.indexOf(': DSP.', at));
      if (/\bstftOpts\b/.test(args)) expect(stftOpts).toContain('maybeYield: yieldBudget');
      else expect(args).toContain('maybeYield: yieldBudget');
    }
  });

  test('spectral stage uses async STFT', () => {
    expect(appJs).toContain('forwardSTFTAsync');
    expect(appJs).toContain('inverseSTFTAsync');
    expect(appJs).toContain('yieldToBrowser');
  });

  test('pipeline paints overlay before heavy work', () => {
    expect(appJs).toMatch(/stageStart\('pipeline'\)[\s\S]*await yieldToBrowser\(\)/);
  });

  test('WhisperHunter does not multi-pass freeze the UI', () => {
    expect(appJs).toContain('app._forceSinglePass = true');
    expect(appJs).toMatch(/Single pipeline pass keeps the UI responsive|single pass/i);
  });

  test('yield budget prefers rAF for paint', () => {
    expect(yieldJs).toContain('yieldToBrowser');
    expect(yieldJs).toContain('requestAnimationFrame');
  });
});
