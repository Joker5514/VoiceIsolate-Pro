/**
 * @jest-environment jsdom
 *
 * Transport disclosure name, and vip-fixes rebinding cloned buttons onto app.dom.
 */
'use strict';

/* global document, window */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

describe('transport disclosure', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/app/index.html'), 'utf8');

  test('section-transport and its summary are named Playback transport', () => {
    const details = html.match(/<details[^>]*id="section-transport"[^>]*>/);
    const summary = html.match(/<summary[^>]*class="[^"]*pac-bar[^"]*"[^>]*>/);
    expect(details).toBeTruthy();
    expect(summary).toBeTruthy();
    expect(details[0]).toMatch(/aria-label="Playback transport"/);
    expect(summary[0]).toMatch(/aria-label="Playback transport"/);
    expect(html).toMatch(/id="tpPlayCollapseToggle"[^>]*aria-label="Collapse play button"/);
    expect((html.match(/id="tpPlay"/g) || []).length).toBe(1);
  });
});

describe('vip-fixes transport rebind', () => {
  const intervals = [];
  const timeouts = [];

  afterEach(() => {
    intervals.splice(0).forEach((id) => clearInterval(id));
    timeouts.splice(0).forEach((id) => clearTimeout(id));
    document.body.innerHTML = '';
    delete window._vipApp;
  });

  test('cloned transport buttons replace app.dom and do not leave the old node live', async () => {
    const origInterval = window.setInterval;
    const origTimeout = window.setTimeout;
    window.setInterval = (...args) => {
      const id = origInterval(...args);
      intervals.push(id);
      return id;
    };
    window.setTimeout = (...args) => {
      const id = origTimeout(...args);
      timeouts.push(id);
      return id;
    };

    document.body.innerHTML = `
      <details id="section-transport" aria-label="Playback transport">
        <summary class="pac-bar" aria-label="Playback transport"></summary>
        <button id="tpPlay" type="button" aria-label="Play (Space)"></button>
        <button id="tpPause" type="button"></button>
        <button id="tpStop" type="button"></button>
        <button id="tpRew" type="button"></button>
        <button id="tpFwd" type="button"></button>
        <button id="tpSpeedUp" type="button"></button>
        <button id="tpSpeedDown" type="button"></button>
        <select id="tpSpeed"><option value="1">1x</option></select>
        <input id="tpSeek" type="range" value="0" />
        <span id="tpCur"></span>
        <span id="tpDur"></span>
      </details>
    `;

    const ids = ['tpPlay', 'tpPause', 'tpStop', 'tpRew', 'tpFwd', 'tpSpeedUp', 'tpSpeedDown'];
    const previous = {};
    const staleClicks = {};
    const dom = {};
    for (const id of ids) {
      previous[id] = document.getElementById(id);
      staleClicks[id] = 0;
      previous[id].addEventListener('click', () => { staleClicks[id] += 1; });
      dom[id] = previous[id];
    }

    let played = 0;
    const buffer = { duration: 2 };
    window._vipApp = {
      dom,
      ctx: { state: 'running', currentTime: 0 },
      inputBuffer: buffer,
      params: {},
      playOffset: 0,
      ensureCtx: async () => {},
      _getBridgePlaybackBuffer: () => buffer,
      _ensureBridge: async () => ({
        loadBuffer() {},
        applyParams() {},
        setComparisonMode() {},
        seek: async () => {},
        play: async () => { played += 1; },
      }),
    };

    const src = fs.readFileSync(path.join(ROOT, 'public/app/vip-fixes.js'), 'utf8');
    window.eval(src);

    for (const id of ids) {
      const live = document.getElementById(id);
      expect(live).toBeTruthy();
      expect(live).not.toBe(previous[id]);
      expect(document.body.contains(previous[id])).toBe(false);
      expect(dom[id]).toBe(live);
      expect(document.querySelectorAll(`#${id}`).length).toBe(1);
    }

    dom.tpPlay.click();
    await new Promise((resolve) => origTimeout(resolve, 0));
    expect(played).toBe(1);
    expect(staleClicks.tpPlay).toBe(0);
    expect(dom.tpPause.disabled).toBe(false);
    expect(dom.tpStop.disabled).toBe(false);

    window.setInterval = origInterval;
    window.setTimeout = origTimeout;
  });
});
