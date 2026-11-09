/**
 * Premium Audio Control — one collapsible transport.
 * Source contract only: the original control IDs stay, and no second
 * play or process listener is introduced.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public/app/index.html'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'public/app/app.js'), 'utf8');
const js = fs.readFileSync(path.join(ROOT, 'public/app/engineer-console.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public/app/premium-audio-control.css'), 'utf8');
const shared = fs.readFileSync(path.join(ROOT, 'src/presentation/PremiumAudioControl.js'), 'utf8');

function transportBlock() {
  const start = html.indexOf('id="section-transport"');
  const end = html.indexOf('id="vizCard"', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return html.slice(start, end);
}

describe('premium audio control module', () => {
  test('one transport details element stays open in markup for the lock test', () => {
    const hits = html.match(/id="section-transport"/g) || [];
    expect(hits).toHaveLength(1);
    expect(html).toMatch(/<details[^>]*id="section-transport"[^>]*open/);
    expect(html).toMatch(/class="card transport-card pac vip-section"/);
  });

  test('collapsed bar holds play, clock, seek, and readiness once each', () => {
    const block = transportBlock();
    const summaryEnd = block.indexOf('</summary>');
    const summary = block.slice(0, summaryEnd);
    for (const id of ['tpPlay', 'tpCur', 'tpDur', 'tpSeek', 'tpSeekFill', 'pacReady']) {
      expect(summary).toContain(`id="${id}"`);
    }
    expect(summary).toContain('pac-bar');
    expect(html.match(/id="tpPlay"/g)).toHaveLength(1);
    expect(block.indexOf('id="tpPause"')).toBeGreaterThan(summaryEnd);
  });

  test('expanded groups keep the original transport and selection controls', () => {
    const block = transportBlock();
    for (const id of [
      'tpPause', 'tpStop', 'tpRew', 'tpFwd', 'tpSpeed',
      'tpLoop', 'tpCropIn', 'tpCropOut', 'tpCropClear',
      'pacSelection', 'tpAB', 'pacProcessSlot', 'pacStatus',
    ]) {
      expect(block).toContain(`id="${id}"`);
    }
  });

  test('collapse does not reset the engine and selection text mirrors the crop', () => {
    expect(app).toMatch(/id === 'section-transport'/);
    expect(app).toMatch(/pacSelection/);
    expect(app).toMatch(/formatTransportSelection/);
    expect(shared).toMatch(/Full file/);
    expect(app).not.toMatch(/section-transport[\s\S]{0,180}AudioContext/);
  });

  test('process buttons are moved into the slot and not cloned', () => {
    expect(js).toMatch(/pacProcessSlot/);
    expect(js).toMatch(/slot\.append\(btn\)/);
    expect(js).toMatch(/slot\.append\(again\)/);
    expect(js).not.toMatch(/tpPlay[\s\S]{0,80}cloneNode/);
    expect(js).not.toMatch(/processBtn[\s\S]{0,80}cloneNode/);
    const pin = js.match(/function pinEngineerDock\(\) \{[\s\S]*?\n  \}/);
    expect(pin).toBeTruthy();
    expect(pin[0]).not.toMatch(/\.open\s*=\s*true/);
  });

  test('engineer chrome still goes through the shared module', () => {
    expect(js).toMatch(/guardTransportSummary/);
    expect(js).toMatch(/readBadgeStatus/);
    expect(shared).toMatch(/pac-bar/);
  });

  test('stylesheet restores the summary and retires the duplicate mobile process bar', () => {
    const sheetAt = html.indexOf('premium-audio-control.css');
    const skinAt = html.indexOf('workstation-premium.css');
    expect(sheetAt).toBeGreaterThan(skinAt);
    const dockAt = html.indexOf('/vip-workstation.css');
    if (dockAt !== -1) expect(sheetAt).toBeGreaterThan(dockAt);
    const fitAt = html.indexOf('/mobile-fit.css');
    if (fitAt !== -1) expect(sheetAt).toBeGreaterThan(fitAt);
    expect(css).toMatch(/summary\.pac-bar/);
    expect(css).toMatch(/display:\s*flex/);
    expect(css).toMatch(/\.mobile-action-bar\s*\{\s*display:\s*none\s*!important/);
    expect(css).toMatch(/#processBtn/);
    expect(css).toMatch(/#reprocessBtn/);
  });
});
