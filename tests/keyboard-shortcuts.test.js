const fs = require('fs');
const path = require('path');

const appJsPath = path.join(__dirname, '../public/app/app.js');
const appJs = fs.readFileSync(appJsPath, 'utf8');

// Same lightweight loader as tests/transport.test.js — the keyboard handler
// is a plain method on the prototype, so we don't need a full DOM.
let VoiceIsolatePro;
try {
  const safeCode = appJs.replace(/document\.addEventListener\('DOMContentLoaded'[\s\S]*\}\);/, '');
  VoiceIsolatePro = new Function(
    'window', 'document',
    safeCode + '; return VoiceIsolatePro;'
  )({}, { getElementById: () => null });
} catch (e) {
  console.error('Failed to load VoiceIsolatePro from app.js', e);
}

function makeEvent(key, opts = {}) {
  return {
    key,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    target: { nodeType: 1, tagName: 'BODY', isContentEditable: false },
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
    ...opts,
  };
}

function makeInst(overrides = {}) {
  return Object.assign(Object.create(VoiceIsolatePro.prototype), {
    inputBuffer: { duration: 1 },
    outputBuffer: { duration: 1 },
    isProcessing: false,
    isPlaying: false,
    abortFlag: false,
    dom: { tpAB: { disabled: false } },
    togglePlayback: jest.fn(),
    stop: jest.fn(),
    toggleAB: jest.fn(),
  }, overrides);
}

describe('global keyboard shortcuts', () => {
  it('Space toggles playback when audio is loaded', () => {
    const inst = makeInst();
    const e = makeEvent(' ');
    inst._handleGlobalKeydown(e);
    expect(inst.togglePlayback).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
  });

  it('K (lower or upper case) toggles playback', () => {
    for (const key of ['k', 'K']) {
      const inst = makeInst();
      inst._handleGlobalKeydown(makeEvent(key));
      expect(inst.togglePlayback).toHaveBeenCalledTimes(1);
    }
  });

  it('Space is ignored when no input buffer is loaded', () => {
    const inst = makeInst({ inputBuffer: null });
    const e = makeEvent(' ');
    inst._handleGlobalKeydown(e);
    expect(inst.togglePlayback).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  it('Space is ignored while focus is in a text input', () => {
    const inst = makeInst();
    const e = makeEvent(' ', { target: { nodeType: 1, tagName: 'INPUT', isContentEditable: false } });
    inst._handleGlobalKeydown(e);
    expect(inst.togglePlayback).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  it('Space is ignored when a modifier key is held (does not interfere with browser shortcuts)', () => {
    const inst = makeInst();
    const e = makeEvent(' ', { ctrlKey: true });
    inst._handleGlobalKeydown(e);
    expect(inst.togglePlayback).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  it('Escape sets abortFlag while processing', () => {
    const inst = makeInst({ isProcessing: true });
    inst._handleGlobalKeydown(makeEvent('Escape'));
    expect(inst.abortFlag).toBe(true);
    expect(inst.stop).not.toHaveBeenCalled();
  });

  it('Escape calls stop() while playing (and not processing)', () => {
    const inst = makeInst({ isPlaying: true });
    inst._handleGlobalKeydown(makeEvent('Escape'));
    expect(inst.stop).toHaveBeenCalledTimes(1);
  });

  it('X toggles A/B compare when output is ready', () => {
    const inst = makeInst();
    inst._handleGlobalKeydown(makeEvent('x'));
    expect(inst.toggleAB).toHaveBeenCalledTimes(1);
  });

  it('X is ignored when A/B button is disabled', () => {
    const inst = makeInst({ dom: { tpAB: { disabled: true } } });
    inst._handleGlobalKeydown(makeEvent('x'));
    expect(inst.toggleAB).not.toHaveBeenCalled();
  });

  it('X is ignored when no processed output exists', () => {
    const inst = makeInst({ outputBuffer: null });
    inst._handleGlobalKeydown(makeEvent('x'));
    expect(inst.toggleAB).not.toHaveBeenCalled();
  });

  it('unrelated keys do nothing', () => {
    const inst = makeInst();
    inst._handleGlobalKeydown(makeEvent('a'));
    inst._handleGlobalKeydown(makeEvent('Enter'));
    expect(inst.togglePlayback).not.toHaveBeenCalled();
    expect(inst.stop).not.toHaveBeenCalled();
    expect(inst.toggleAB).not.toHaveBeenCalled();
  });
});
