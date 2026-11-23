/**
 * Web, Android, and Desktop ship one shell. This checks that the shared
 * workspace contract is what all three load, and that the new presentation
 * code stays out of the audio path.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('three surfaces, one workspace contract', () => {
  const landing = read('public/index.html');
  const engineer = read('public/app/index.html');
  const landingJs = read('public/landing-v3.js');
  const consoleJs = read('public/app/engineer-console.js');
  const blocks = read('src/presentation/WorkspaceBlocks.js');
  const css = read('public/workspace-blocks.css');
  const guide = read('docs/guides/WORKSPACE_LAYOUT.md');
  const capacitor = JSON.parse(read('capacitor.config.json'));
  const electron = read('electron/main.cjs');
  const build = read('scripts/build.mjs');

  test('both shells link the shared tokens and the workspace sheet', () => {
    for (const html of [landing, engineer]) {
      expect(html).toContain('design-tokens.css');
      expect(html).toContain('workspace-blocks.css');
    }
  });

  test('Stems and Engineer both install the same module', () => {
    expect(landingJs).toContain("initWorkspaceBlocks({ mode: 'stems' })");
    expect(consoleJs).toContain("initWorkspaceBlocks({ mode: 'engineer' })");
    expect(landingJs).toContain('/src/presentation/WorkspaceBlocks.js');
    expect(consoleJs).toContain('/src/presentation/WorkspaceBlocks.js');
  });

  test('Android and Desktop consume the build copied from public and src', () => {
    expect(capacitor.webDir).toBe('build');
    expect(electron).toContain("mainWindow.loadURL('vip://app/index.html')");
    expect(build).toContain('cpRecursive(PUBLIC, BUILD)');
    expect(build).toContain('cpRecursive(SRC, buildSrc)');
  });

  test('the catalog covers the required Stems and Engineer blocks', () => {
    const required = {
      stems: ['nav', 'upload', 'signal', 'mixer', 'stem-voice', 'stem-background', 'waveform', 'transport', 'export', 'spectrum', 'diagnostics', 'processing', 'settings'],
      engineer: ['stage-column', 'session-column', 'upload', 'waveform', 'signal', 'forensic', 'evidence', 'diagnostics', 'cockpit', 'integrity', 'safety', 'processing', 'presets', 'export', 'transport', 'target'],
    };
    for (const [mode, ids] of Object.entries(required)) {
      for (const id of ids) {
        expect(blocks).toContain(`id: '${id}'`);
      }
      expect(blocks).toContain(`${mode}:`);
    }
    for (const id of [
      'uploadPanel', 'signalCanvasSection', 'enhancePanel', 'landingTransport',
      'compareRow', 'sourceConfidencePanel', 'advancedMixDetails', 'settings',
    ]) {
      expect(landing).toContain(`id="${id}"`);
    }
    expect(landing).toContain('v3-lane--voice');
    expect(landing).toContain('v3-lane--bg');
    expect(landing).toContain('v3-lanes__wave');
    expect(landing).toContain('v3-spectrum');
    for (const id of [
      'section-upload', 'vizCard', 'section-signal-canvas', 'section-forensic',
      'forensicInspectorMount', 'section-analysis', 'section-cockpit',
      'section-processing', 'vipSignalChain', 'section-presets', 'section-save',
      'section-transport', 'section-target-speaker',
    ]) {
      expect(engineer).toContain(`id="${id}"`);
    }
    expect(consoleJs).toContain('ec-col-stage');
    expect(consoleJs).toContain('ec-col-session');
    expect(consoleJs).toContain('ecIntegrityCard');
    expect(consoleJs).toContain('ecOutputSafety');
  });

  test('resize stays on the presentation layer', () => {
    for (const src of [blocks, css]) {
      expect(src).not.toMatch(/getUserMedia/);
      expect(src).not.toMatch(/new AudioContext|webkitAudioContext/);
      expect(src).not.toMatch(/MLWorker/);
      expect(src).not.toMatch(/runPipeline/);
    }
  });

  test('touch and narrow layouts keep a usable grip', () => {
    expect(css).toMatch(/pointer:\s*coarse/);
    expect(css).toContain('min-height: 44px');
    expect(css).toContain('width: 44px');
    expect(css).toContain('max-width: 1279px');
  });

  test('platform exceptions are written down', () => {
    expect(guide).toMatch(/Drum, bass/);
    expect(guide).toMatch(/vip-panel-sizes/);
    expect(guide).toMatch(/1280px/);
    expect(guide).toMatch(/pointer: coarse/);
    expect(guide).toMatch(/window frame/);
    expect(guide).toMatch(/pearlescent red/);
    expect(guide).toMatch(/iOS is out of scope/);
    expect(guide).toMatch(/does not start workers/);
  });
});
