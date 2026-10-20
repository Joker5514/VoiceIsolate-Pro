/**
 * TargetSpeakerUI structure guards (shared Landing + Engineer module).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ui = fs.readFileSync(
  path.join(__dirname, '../src/presentation/TargetSpeakerUI.js'),
  'utf8',
);

describe('TargetSpeakerUI UX', () => {
  test('exports mountTargetSpeakerUI', () => {
    expect(ui).toMatch(/export function mountTargetSpeakerUI/);
  });

  test('includes step-by-step how-to copy', () => {
    expect(ui).toMatch(/Focus on one voice/);
    expect(ui).toMatch(/How to enroll a target voice|vip-ts-steps/);
    expect(ui).toMatch(/Load & prepare audio/);
    expect(ui).toMatch(/Mark a clean speech region/);
    expect(ui).toMatch(/Enroll/);
    expect(ui).toMatch(/Isolate target/);
  });

  test('has tips disclosure and quick-fill helpers', () => {
    expect(ui).toMatch(/Tips for best results/);
    expect(ui).toMatch(/First 2 s/);
    expect(ui).toMatch(/Around playhead/);
    expect(ui).toMatch(/getPlayheadSec|getDurationSec/);
  });

  test('injects self-contained styles for all surfaces', () => {
    expect(ui).toMatch(/vip-target-speaker-styles/);
    expect(ui).toMatch(/ensureStyles/);
  });

  test('Landing mounts shared module', () => {
    const landing = fs.readFileSync(path.join(__dirname, '../public/landing.js'), 'utf8');
    const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
    expect(landing).toMatch(/ensureTargetSpeakerUi/);
    expect(landing).toMatch(/TargetSpeakerUI\.js/);
    expect(html).toMatch(/targetSpeakerLandingPanel/);
    expect(html).toMatch(/id="targetSpeakerPanel"/);
  });

  test('Engineer section uses friendly summary', () => {
    const eng = fs.readFileSync(path.join(__dirname, '../public/app/index.html'), 'utf8');
    expect(eng).toMatch(/Focus on one voice \(target enrollment\)/);
    expect(eng).toMatch(/id="targetSpeakerPanel"/);
  });
});

describe('TargetSpeakerUI enrollment race', () => {
  // Allow extra time: the module import + JSDOM + audio processing can be slow on
  // first run in CI / cold Node environments (especially Windows).
  test('Clear during a pending ECAPA enrollment discards the late embedding', async () => {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><div id="host"></div>');
    const g = global;
    const saved = { document: g.document, window: g.window, HTMLElement: g.HTMLElement };
    g.window = dom.window;
    g.document = dom.window.document;
    g.HTMLElement = dom.window.HTMLElement;
    try {
      const { mountTargetSpeakerUI } = await import('../src/presentation/TargetSpeakerUI.js');
      const sr = 48000;
      const x = new Float32Array(sr * 2);
      for (let i = 0; i < x.length; i++) {
        x[i] = 0.3 * Math.sin((2 * Math.PI * 140 * i) / sr) + 0.1 * Math.sin((2 * Math.PI * 900 * i) / sr);
      }
      let finish = null;
      const host = {
        ready: async () => true,
        // First enrollment resolves at once; the second is held pending.
        embed: () => (finish === null
          ? (finish = undefined, Promise.resolve(new Float32Array(192).fill(0.2)))
          : new Promise((resolve) => { finish = resolve; })),
        unavailableReason: null,
      };
      const container = dom.window.document.getElementById('host');
      mountTargetSpeakerUI({
        container,
        getAudio: () => ({ channelData: [x], sampleRate: sr }),
        onIsolated: async () => {},
        speakerEmbedding: host,
      });
      const q = (sel) => container.querySelector(sel);
      const inputs = container.querySelectorAll('input[type="number"]');
      inputs[0].value = '0';
      inputs[1].value = '1.5';
      q('.vip-ts-enroll').click();
      await new Promise((r) => setTimeout(r, 0));
      expect(q('.vip-ts-status').textContent).toMatch(/ECAPA speaker embedding/);
      // Re-enroll; Clear stays enabled from the first enrollment, as a user sees it.
      q('.vip-ts-enroll').click();
      await new Promise((r) => setTimeout(r, 0));
      expect(typeof finish).toBe('function');
      expect(q('.vip-ts-clear').disabled).toBe(false);
      q('.vip-ts-clear').click();
      finish(new Float32Array(192).fill(0.1));
      await new Promise((r) => setTimeout(r, 0));
      expect(q('.vip-ts-apply').disabled).toBe(true);
      expect(q('.vip-ts-status').textContent).toMatch(/cleared/);
    } finally {
      Object.assign(g, saved);
      dom.window.close();
    }
  }, 15000);
});
