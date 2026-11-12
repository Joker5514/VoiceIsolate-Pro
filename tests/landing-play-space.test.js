/**
 * Landing transport: Space plays, a disabled play control looks disabled,
 * and a finished import prints its duration.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('transport keys', () => {
  let transportKeyAction;

  beforeAll(async () => {
    ({ transportKeyAction } = await import('../src/core/TransportKeys.js'));
  });

  function ev(partial) {
    return {
      key: '',
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      defaultPrevented: false,
      target: { tagName: 'BODY', isContentEditable: false, closest: () => null },
      ...partial,
    };
  }

  test('Space and K play when focus is on the page', () => {
    expect(transportKeyAction(ev({ key: ' ' }))).toBe('play');
    expect(transportKeyAction(ev({ key: 'k' }))).toBe('play');
    expect(transportKeyAction(ev({ key: 'K' }))).toBe('play');
  });

  test('skips text fields, contenteditable, and a focused button', () => {
    expect(transportKeyAction(ev({ key: ' ', target: { tagName: 'INPUT', closest: () => null } }))).toBeNull();
    expect(transportKeyAction(ev({ key: ' ', target: { tagName: 'TEXTAREA', closest: () => null } }))).toBeNull();
    expect(transportKeyAction(ev({ key: ' ', target: { tagName: 'SELECT', closest: () => null } }))).toBeNull();
    expect(transportKeyAction(ev({
      key: ' ',
      target: { tagName: 'DIV', isContentEditable: true, closest: () => null },
    }))).toBeNull();
    expect(transportKeyAction(ev({ key: ' ', target: { tagName: 'BUTTON', closest: () => null } }))).toBeNull();
    expect(transportKeyAction(ev({
      key: ' ',
      target: { tagName: 'DIV', closest: (sel) => (sel === '[role="tablist"]' ? {} : null) },
    }))).toBeNull();
  });

  test('ignores modified chords and a key the upload zone already handled', () => {
    expect(transportKeyAction(ev({ key: ' ', ctrlKey: true }))).toBeNull();
    expect(transportKeyAction(ev({ key: ' ', metaKey: true }))).toBeNull();
    expect(transportKeyAction(ev({ key: ' ', defaultPrevented: true }))).toBeNull();
  });

  test('arrows scrub', () => {
    expect(transportKeyAction(ev({ key: 'ArrowLeft' }))).toBe('seek-back');
    expect(transportKeyAction(ev({ key: 'ArrowRight' }))).toBe('seek-forward');
  });
});

describe('landing wires Space and the decoded duration', () => {
  const landing = read('public/landing.js');
  const html = read('public/index.html');
  const engineer = read('public/app/index.html');

  test('the page handler uses the shared policy and still labels Play (Space)', () => {
    expect(landing).toContain("import { transportKeyAction } from '/src/core/TransportKeys.js'");
    expect(landing).toContain('const action = transportKeyAction(event)');
    expect(landing).toContain("action === 'play'");
    expect(html).toContain('aria-label="Play (Space)"');
    expect(html).toMatch(/id="playBtn"[^>]*disabled[^>]*aria-disabled="true"/);
    expect(engineer).toMatch(/id="tpPlay"[^>]*disabled[^>]*aria-disabled="true"/);
  });

  test('a non-chunked import writes the decoded duration onto the transport', () => {
    expect(landing).toMatch(/writeTimeReadout\(0,\s*decodedSeconds\)/);
  });
});

describe('disabled play paint', () => {
  const fit = read('public/mobile-fit.css');
  const skin = read('public/app/neural-console.css');
  const pac = read('public/app/premium-audio-control.css');

  test('the red pill is the enabled state, and disabled is a muted control', () => {
    expect(fit).toMatch(/#playBtn\.v3-play:disabled/);
    expect(fit).toMatch(/#tpPlay\.btn-tp-play:disabled/);
    expect(fit).toMatch(/\[aria-disabled="true"\]/);
    expect(fit).toContain('cursor: not-allowed');
    expect(skin).toMatch(/#tpPlay\.btn-tp-play:disabled/);
    expect(skin).toContain('cursor: not-allowed');
    expect(pac).not.toMatch(/\.btn-tp-play,\s*\n:is\(body\.eng-console, body\.v3\) details\.transport-card\.pac \.btn-tp-play:not\(:disabled\)/);
    expect(pac).toMatch(/\.btn-tp-play:not\(:disabled\)/);
  });

  test('collapse still zeroes the play control', () => {
    expect(fit).toMatch(/\.vip-play-slot\.is-collapsed #playBtn/);
    expect(fit).toMatch(/width:\s*0/);
    expect(skin).toMatch(/\.vip-play-slot\.is-collapsed #tpPlay \{[^}]*width:\s*0/);
  });
});
