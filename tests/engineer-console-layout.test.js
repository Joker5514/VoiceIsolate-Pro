/**
 * Engineer Console layout guards — IDs must remain; skin files present.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public/app/index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public/app/engineer-console.css'), 'utf8');
const js = fs.readFileSync(path.join(ROOT, 'public/app/engineer-console.js'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'public/app/app.js'), 'utf8');
const aw = fs.readFileSync(path.join(ROOT, 'public/app/lib/analysis-workspace.js'), 'utf8');

describe('Engineer Console skin', () => {
  test('index loads console CSS/JS', () => {
    expect(html).toMatch(/engineer-console\.css/);
    expect(html).toMatch(/engineer-console\.js/);
    expect(html).toMatch(/neural-console\.css/);
  });

  test('neural console chrome proxies existing controls', () => {
    expect(js).toMatch(/installNeuralChrome/);
    expect(js).toMatch(/getElementById\('fileInput'\)/);
    expect(js).toMatch(/getElementById\('saveProcBtn'\)/);
    expect(js).toMatch(/data-hero-tier/);
    expect(js).toMatch(/heroSceneSelect/);
    expect(js).toMatch(/aria-controls/);
    expect(js).toMatch(/aria-selected/);
    expect(js).toMatch(/ArrowRight/);
    expect(js).not.toMatch(/getUserMedia/);
    expect(html).toContain('Live Mix');
    expect(html).toContain('Quick Clean');
    expect(html).toContain('id="fileInput"');
    expect(html).toContain('id="tpPlay"');
  });

  test('neural chrome hit targets stay at least 44px without resizing play', () => {
    const skin = fs.readFileSync(path.join(ROOT, 'public/app/neural-console.css'), 'utf8');
    const hit = /body\.eng-console\.neural-console \.nc-btn,[\s\S]*?\.nc-preset \{([^}]*)\}/.exec(skin);
    expect(hit).not.toBeNull();
    expect(hit[1]).toMatch(/min-height:\s*44px/);
    expect(hit[1]).toMatch(/min-width:\s*44px/);
    const play = /body\.eng-console\.neural-console #tpPlay\.btn-tp-play \{([^}]*)\}/.exec(skin);
    expect(play[1]).not.toMatch(/\b(?:min-)?(?:width|height)\s*:/);
  });

  test('critical control IDs still present', () => {
    for (const id of [
      'fileInput',
      'processBtn',
      'reprocessBtn',
      'tpPlay',
      'tpAB',
      'spectroCanvas',
      'waveCanvas',
      'tab-gate',
      'tab-eq',
      'tab-dyn',
      'section-target-speaker',
      'targetSpeakerPanel',
      'btnAnalyzeFull',
      'analysisWorkspace',
      'section-processing',
      'pipeFill',
      'hPeak',
      'hSNR',
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  test('layout builder reparents without renaming IDs', () => {
    expect(js).toMatch(/ec-grid/);
    expect(js).toMatch(/ec-col-session/);
    expect(js).toMatch(/ec-col-stage/);
    expect(js).toMatch(/ec-col-rack/);
    expect(js).toMatch(/ecIntegrityCard|DSP Integrity/);
    expect(js).toMatch(/section-ec-analysis/);
    expect(js).toMatch(/section-ec-diar/);
    expect(js).toMatch(/bindCollapsibleSections/);
    expect(js).toMatch(/ecOutputSafety|Output Safety/);
    expect(js).toMatch(/ecFocusExplain|Focus on one voice/);
  });

  test('console CSS defines rack modules and clean-output cue', () => {
    expect(css).toMatch(/body\.eng-console/);
    expect(css).toMatch(/ec-col-rack/);
    expect(css).toMatch(/ec-clean-output/);
    expect(css).toMatch(/ec-focus-explain/);
  });

  test('Process auto-chains analysis', () => {
    expect(app).toMatch(/runFullAnalysis/);
    expect(app).toMatch(/auto-analysis after process/);
    expect(aw).toMatch(/app\.runFullAnalysis\s*=\s*runAnalysis/);
  });

  test('target speaker section defaults collapsed in markup', () => {
    expect(html).toMatch(/id="section-target-speaker"/);
    expect(html).not.toMatch(/id="section-target-speaker"\s+open/);
  });
});
