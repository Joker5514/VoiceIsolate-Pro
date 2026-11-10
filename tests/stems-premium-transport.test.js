/**
 * Stems universal play menu shares the Engineer premium transport.
 * Source contract plus the shared chrome helpers. Playback listeners stay
 * on the landing nodes (playBtn, seekSlider, per-stem mutes).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const landing = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const landingJs = fs.readFileSync(path.join(ROOT, 'public/landing.js'), 'utf8');
const engineer = fs.readFileSync(path.join(ROOT, 'public/app/index.html'), 'utf8');
const engineerJs = fs.readFileSync(path.join(ROOT, 'public/app/engineer-console.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public/app/premium-audio-control.css'), 'utf8');

function block(html, startId, endId) {
  const start = html.indexOf(`id="${startId}"`);
  const end = html.indexOf(`id="${endId}"`, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return html.slice(start, end);
}

describe('stems transport shares the engineer module', () => {
  test('landing loads the shared sheet after the dock and mobile sheets', () => {
    const sheet = landing.indexOf('/app/premium-audio-control.css');
    expect(sheet).toBeGreaterThan(landing.indexOf('/vip-workstation.css'));
    expect(sheet).toBeGreaterThan(landing.indexOf('/mobile-fit.css'));
    expect(css).toMatch(/:is\(body\.eng-console, body\.v3\)/);
    expect(css).toMatch(/summary\.pac-bar/);
    expect(css).toMatch(/body\.v3 > details\.v3-transport\.pac/);
  });

  test('collapsed bar matches engineer: play, clock, seek, readiness, chevron', () => {
    const html = block(landing, 'landingTransport', 'compareRow');
    const summaryEnd = html.indexOf('</summary>');
    const summary = html.slice(0, summaryEnd);
    for (const id of ['playBtn', 'playCollapseToggle', 'timeReadout', 'seekSlider', 'landingSeekFill', 'landingReady', 'landingProcessBar']) {
      expect(summary).toContain(`id="${id}"`);
    }
    expect(summary).toContain('pac-bar');
    expect(summary).toContain('pac-chevron');
    expect(summary).toContain('aria-label="Playback transport"');
    expect(html.indexOf('id="pauseBtn"')).toBeGreaterThan(summaryEnd);
    expect(landing.match(/id="playBtn"/g)).toHaveLength(1);
    expect(landing.match(/id="landingTransport"/g)).toHaveLength(1);
  });

  test('expanded groups keep engineer controls and stems compare', () => {
    const html = block(landing, 'landingTransport', 'compareRow');
    for (const id of [
      'pauseBtn', 'stopBtn', 'landingRew', 'landingFwd', 'landingSpeed',
      'landingSpeedDown', 'landingSpeedUp',
      'loopBtn', 'cropInBtn', 'cropOutBtn', 'cropClearBtn',
      'landingSelection', 'compareOriginalBtn', 'compareCleanedBtn', 'compareRemovedBtn',
      'landingProcessSlot', 'landingTransportStatus',
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain('>Transport<');
    expect(html).toContain('>Timeline<');
    expect(html).toContain('>Processing<');
    expect(html).toContain('Full file');
    // Per-stem lanes stay outside the play menu.
    const lanes = landing.indexOf('id="muteVoiceBtn"');
    const transport = landing.indexOf('id="landingTransport"');
    expect(lanes).toBeGreaterThan(-1);
    expect(lanes).toBeLessThan(transport);
    expect(landing).toContain('id="muteNoiseBtn"');
    expect(landing).toContain('id="volumeSlider"');
  });

  test('engineer markup is unchanged as the source of the module', () => {
    expect(engineer).toMatch(/id="section-transport"/);
    expect(engineer).toMatch(/class="[^"]*pac-bar/);
    for (const id of ['tpPlay', 'tpPause', 'tpStop', 'tpRew', 'tpFwd', 'tpSpeed', 'tpLoop', 'pacSelection', 'pacProcessSlot']) {
      expect(engineer).toContain(`id="${id}"`);
    }
  });

  test('both surfaces call the shared chrome and landing does not start a second player', () => {
    expect(engineerJs).toMatch(/PremiumAudioControl\.js/);
    expect(engineerJs).toMatch(/guardTransportSummary/);
    expect(engineerJs).toMatch(/readBadgeStatus/);
    expect(landingJs).toMatch(/guardTransportSummary\(transport\)/);
    expect(landingJs).toMatch(/bindTransportOpen/);
    expect(landingJs).toMatch(/formatTransportSelection/);
    expect(landingJs).toMatch(/setPlaybackRate/);
    expect(landingJs).toMatch(/seekBy\(-10\)/);
    expect(landingJs).toMatch(/seekBy\(10\)/);
    expect(landingJs).toMatch(/seekBy\(-5\)/);
    expect(landingJs).toMatch(/landingProcessSlot/);
    expect(landingJs).toMatch(/landingProcessBar/);
    expect(landingJs).toMatch(/placeProcessButton/);
    expect(landingJs).not.toMatch(/new AudioContext\(/);
    expect(landingJs).not.toMatch(/getUserMedia/);
    expect(landing).not.toMatch(/getUserMedia/);
  });
});

describe('premium transport helpers', () => {
  let api;

  beforeAll(async () => {
    api = await import('../src/presentation/PremiumAudioControl.js');
  });

  test('selection label matches the engineer crop sentence', () => {
    expect(api.formatTransportSelection({ in: 0, out: 10 }, false)).toBe('Full file');
    expect(api.formatTransportSelection(null, true)).toBe('Full file');
    expect(api.formatTransportSelection({ in: 65, out: 95 }, true)).toBe('1:05 – 1:35 · 0:30');
  });

  test('status chip truncates and maps quick-clean stages', () => {
    const ready = { dataset: {}, textContent: '' };
    const status = { textContent: '' };
    api.paintTransportStatus(ready, status, { text: 'x'.repeat(60), state: 'processing' });
    expect(ready.dataset.state).toBe('processing');
    expect(ready.textContent.endsWith('…')).toBe(true);
    expect(ready.textContent.length).toBeLessThanOrEqual(48);
    expect(status.textContent).toHaveLength(60);

    const processing = api.readQuickCleanStatus({ textContent: 'Working', dataset: { state: 'processing' } });
    expect(processing.state).toBe('processing');
    const calm = api.readQuickCleanStatus({ textContent: 'Done', dataset: { state: 'processed' } });
    expect(calm.state).toBe('ready');
    const failed = api.readQuickCleanStatus({ textContent: 'No', dataset: { state: 'error' } });
    expect(failed.state).toBe('error');
    const badge = api.readBadgeStatus(
      { dataset: { state: 'done' }, querySelector: () => ({ textContent: 'badge' }) },
      { textContent: 'pipeline' },
    );
    expect(badge).toEqual({ text: 'pipeline', state: 'done' });
  });

  test('bar controls do not toggle the disclosure; the chevron still can', () => {
    let prevented = 0;
    const card = {
      dataset: {},
      addEventListener(type, fn) { this._fn = fn; },
    };
    api.guardTransportSummary(card);
    api.guardTransportSummary(card);
    expect(card.dataset.pacGuard).toBe('1');
    const fire = (closestMap) => {
      const event = { preventDefault() { prevented += 1; }, target: { closest(sel) { return closestMap[sel] || null; } } };
      card._fn(event);
    };
    fire({ '.pac-bar': true, 'button, input, select, textarea, a, label': true });
    expect(prevented).toBe(1);
    fire({ '.pac-bar': true });
    expect(prevented).toBe(1);
    fire({});
    expect(prevented).toBe(1);
  });

  test('disclosure defaults closed and remembers the user toggle', () => {
    const mem = {
      _v: null,
      _k: null,
      getItem() { return this._v; },
      setItem(k, v) { this._k = k; this._v = v; },
    };
    const summary = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
    const card = {
      open: true,
      dataset: {},
      querySelector() { return summary; },
      addEventListener(type, fn) { this._toggle = fn; },
    };
    api.bindTransportOpen(card, mem, 'vip.landing.transportOpen');
    expect(card.open).toBe(false);
    expect(summary.attrs['aria-expanded']).toBe('false');
    card.open = true;
    card._toggle();
    expect(mem._k).toBe('vip.landing.transportOpen');
    expect(mem._v).toBe('1');
    expect(summary.attrs['aria-expanded']).toBe('true');

    const again = {
      open: false,
      dataset: {},
      querySelector() { return summary; },
      addEventListener() {},
    };
    api.bindTransportOpen(again, mem, 'vip.landing.transportOpen');
    expect(again.open).toBe(true);
  });

  test('process stays on the bar while the dock is closed and moves when it opens', () => {
    const button = { id: 'processBtn' };
    const make = () => {
      const el = {
        children: [],
        contains(node) { return this.children.includes(node); },
        append(node) { this.children.push(node); },
      };
      return el;
    };
    const bar = make();
    const slot = make();
    expect(api.placeProcessButton({ open: false, bar, slot, button })).toBe(bar);
    expect(bar.children).toEqual([button]);
    expect(slot.children).toEqual([]);
    expect(api.placeProcessButton({ open: false, bar, slot, button })).toBe(bar);
    expect(bar.children).toEqual([button]);
    expect(api.placeProcessButton({ open: true, bar, slot, button })).toBe(slot);
    expect(slot.children).toEqual([button]);
    expect(api.placeProcessButton({ open: true, bar: null, slot, button })).toBe(slot);
    expect(api.placeProcessButton({ open: false, bar: null, slot, button })).toBe(slot);
  });

  test('speed steps stop at the ends and emit change', () => {
    const select = {
      value: '1',
      options: [{ value: '0.5' }, { value: '1' }, { value: '2' }],
      dispatched: 0,
      dispatchEvent() { this.dispatched += 1; },
    };
    expect(api.stepSelect(select, 1)).toBe('2');
    expect(select.dispatched).toBe(1);
    expect(api.stepSelect(select, 1)).toBe('2');
    expect(select.dispatched).toBe(1);
    expect(api.stepSelect(select, -1)).toBe('1');
  });
});
