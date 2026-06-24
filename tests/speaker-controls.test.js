/**
 * @jest-environment jsdom
 *
 * VoiceIsolate Pro — SpeakerControls (Layer 4) DOM tests.
 *
 * Verifies the per-speaker cards render from mixer state and that every
 * interaction routes exclusively through PlaybackMixer's per-speaker API
 * (the CLAUDE.md §1.1 contract: presentation → AudioParams only).
 */

'use strict';

/* global document -- provided by the jsdom test environment */

let SpeakerControls;

beforeAll(async () => {
  ({ SpeakerControls } = await import('../src/presentation/SpeakerControls.js'));
});

/** Minimal mixer double exposing only the per-speaker surface.
 *  volume is a 0–100 percentage on both getter and setter (mixer contract). */
function mockMixer(ids = ['S1', 'S2']) {
  const state = new Map(ids.map((id) => [id, { volume: 100, muted: false }]));
  let solo = null;
  return {
    speakerIds: jest.fn(() => [...state.keys()]),
    getSpeakerState: jest.fn((id) => {
      const s = state.get(id);
      return s ? { ...s, solo: solo === id } : null;
    }),
    setSpeakerVolume: jest.fn((id, pct) => { state.get(id).volume = pct; }),
    setSpeakerMuted: jest.fn((id, muted) => { state.get(id).muted = muted; }),
    setSpeakerSolo: jest.fn((id) => { solo = id; }),
  };
}

describe('SpeakerControls', () => {
  let mixer;
  let container;
  let controls;

  beforeEach(() => {
    mixer = mockMixer();
    container = document.createElement('div');
    controls = new SpeakerControls(mixer, container);
  });

  test('requires a mixer and a container', () => {
    expect(() => new SpeakerControls(null, container)).toThrow(TypeError);
    expect(() => new SpeakerControls(mixer, null)).toThrow(TypeError);
  });

  test('renders one card per speaker with label and talk time', () => {
    const count = controls.render([
      { speakerId: 'S1', label: 'Speaker S1', talkTime: 12.34 },
      { speakerId: 'S2', label: 'Speaker S2', talkTime: 5.6 },
    ]);
    expect(count).toBe(2);
    const cards = container.querySelectorAll('.speaker-card');
    expect(cards).toHaveLength(2);
    expect(cards[0].textContent).toContain('Speaker S1');
    expect(cards[0].textContent).toContain('12.3s');
    expect(cards[1].dataset.speakerId).toBe('S2');
  });

  test('renders an empty notice when no speakers exist', () => {
    mixer = mockMixer([]);
    controls = new SpeakerControls(mixer, container);
    expect(controls.render([])).toBe(0);
    expect(container.querySelector('.speaker-empty')).not.toBeNull();
  });

  test('mute button toggles through mixer.setSpeakerMuted and repaints', () => {
    controls.render();
    const card = container.querySelector('[data-speaker-id="S1"]');
    const muteBtn = card.querySelector('.speaker-mute-btn');
    expect(muteBtn.textContent).toBe('Mute');

    muteBtn.click();
    expect(mixer.setSpeakerMuted).toHaveBeenCalledWith('S1', true);
    expect(muteBtn.textContent).toBe('Muted');
    expect(muteBtn.getAttribute('aria-pressed')).toBe('true');
    expect(card.classList.contains('speaker-card-muted')).toBe(true);

    muteBtn.click();
    expect(mixer.setSpeakerMuted).toHaveBeenLastCalledWith('S1', false);
    expect(muteBtn.textContent).toBe('Mute');
  });

  test('solo button is exclusive: soloing S1 repaints S2, re-click clears', () => {
    controls.render();
    const soloS1 = container.querySelector('[data-speaker-id="S1"] .speaker-solo-btn');
    const soloS2 = container.querySelector('[data-speaker-id="S2"] .speaker-solo-btn');

    soloS1.click();
    expect(mixer.setSpeakerSolo).toHaveBeenCalledWith('S1');
    expect(soloS1.textContent).toBe('Soloed');
    expect(soloS2.textContent).toBe('Solo');

    soloS2.click();
    expect(mixer.setSpeakerSolo).toHaveBeenLastCalledWith('S2');
    expect(soloS1.textContent).toBe('Solo');
    expect(soloS2.textContent).toBe('Soloed');

    soloS2.click(); // re-click clears solo
    expect(mixer.setSpeakerSolo).toHaveBeenLastCalledWith(null);
  });

  test('volume slider drives mixer.setSpeakerVolume and the readout', () => {
    controls.render();
    const card = container.querySelector('[data-speaker-id="S2"]');
    const slider = card.querySelector('input[type="range"]');
    slider.value = '35';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    expect(mixer.setSpeakerVolume).toHaveBeenCalledWith('S2', 35);
    expect(card.querySelector('.slider-val').textContent).toBe('35%');
  });

  test('clear() empties the grid', () => {
    controls.render();
    controls.clear();
    expect(container.children).toHaveLength(0);
  });

  // ── PR changes: volume range extended to 0–200 (ENHANCE / boost) ────────────

  test('volume slider max is "200" (ENHANCE range, not the old 100)', () => {
    controls.render();
    const card = container.querySelector('[data-speaker-id="S1"]');
    const slider = card.querySelector('input[type="range"]');
    expect(slider.getAttribute('max')).toBe('200');
  });

  test('volume slider min remains "0"', () => {
    controls.render();
    const slider = container.querySelector('[data-speaker-id="S1"] input[type="range"]');
    expect(slider.getAttribute('min')).toBe('0');
  });

  test('volume slider at 175 calls setSpeakerVolume with 175 (+~4.9 dB boost)', () => {
    controls.render();
    const card = container.querySelector('[data-speaker-id="S1"]');
    const slider = card.querySelector('input[type="range"]');
    slider.value = '175';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    expect(mixer.setSpeakerVolume).toHaveBeenCalledWith('S1', 175);
  });

  test('volume slider at 200 calls setSpeakerVolume with 200 (maximum ENHANCE)', () => {
    controls.render();
    const card = container.querySelector('[data-speaker-id="S2"]');
    const slider = card.querySelector('input[type="range"]');
    slider.value = '200';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    expect(mixer.setSpeakerVolume).toHaveBeenCalledWith('S2', 200);
  });

  test('readout shows "200%" when slider is at max boost', () => {
    controls.render();
    const card = container.querySelector('[data-speaker-id="S1"]');
    const slider = card.querySelector('input[type="range"]');
    const readout = card.querySelector('.slider-val');
    slider.value = '200';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    expect(readout.textContent).toBe('200%');
  });

  // ── PR change: aria-label mentions boost hint ─────────────────────────────

  test('volume slider aria-label contains "(above 100% boosts)"', () => {
    controls.render([{ speakerId: 'S1', label: 'Speaker S1' }]);
    const card = container.querySelector('[data-speaker-id="S1"]');
    const slider = card.querySelector('input[type="range"]');
    expect(slider.getAttribute('aria-label')).toContain('(above 100% boosts)');
  });

  test('volume slider aria-label references the speaker label', () => {
    controls.render([{ speakerId: 'S1', label: 'Speaker S1' }]);
    const slider = container.querySelector('[data-speaker-id="S1"] input[type="range"]');
    expect(slider.getAttribute('aria-label')).toContain('Speaker S1');
  });
});
