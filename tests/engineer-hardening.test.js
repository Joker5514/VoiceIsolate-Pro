const fs = require('fs');
const path = require('path');
const getAppCode = require('./helpers/get-app-code');

const APP_JS = getAppCode();
const VIP_FIXES = fs.readFileSync(path.join(__dirname, '..', 'public', 'app', 'vip-fixes.js'), 'utf8');
const VISUALS_BOOT = fs.readFileSync(path.join(__dirname, '..', 'public', 'app', 'visuals-bootstrap.js'), 'utf8');
const STEM_SEP = fs.readFileSync(path.join(__dirname, '..', 'src', 'pipeline', 'StemSeparation.js'), 'utf8');
const DIAR_TIMELINE = fs.readFileSync(path.join(__dirname, '..', 'public', 'app', 'diarization-timeline.js'), 'utf8');

let VoiceIsolatePro;
try {
  const safeCode = APP_JS.replace(/document\.addEventListener\('DOMContentLoaded'[\s\S]*?\}\);/, '');
  VoiceIsolatePro = new Function('window', 'document', safeCode + '; return VoiceIsolatePro;')({}, {});
} catch (e) {
  throw new Error('Failed to load VoiceIsolatePro: ' + e.message);
}

describe('Engineer Mode hardening', () => {
  test('StemSeparation terminates worker on processing timeout', () => {
    expect(STEM_SEP).toMatch(/setTimeout[\s\S]*resetStemSeparation\(\)/);
  });

  test('app.js guards duplicate tpSeek handlers when vip-fixes owns transport', () => {
    expect(APP_JS).toMatch(/tpSeek[\s\S]*_fixTransportPatched[\s\S]*return/);
  });

  test('app.js skips X-key toggleAB when vip-fixes owns A/B', () => {
    expect(APP_JS).toMatch(/e\.key === 'x'[\s\S]*_fixABPatched[\s\S]*return/);
  });

  test('app.js seekTo does not replay when vip-fixes owns transport', () => {
    expect(APP_JS).toMatch(/wasPlaying && !this\._fixTransportPatched/);
  });

  test('app.js abort resets ML worker and extends idle wait', () => {
    expect(APP_JS).toMatch(/resetStemSeparation[\s\S]*_waitForPipelineIdle\(90000\)/);
    expect(APP_JS).toMatch(/Pipeline idle wait timed out[\s\S]*resetStemSeparation/);
  });

  test('vip-fixes A/B toggle preserves transport position', () => {
    expect(VIP_FIXES).toContain('restartAt(offsetSec)');
    expect(VIP_FIXES).toMatch(/function _toggleAB[\s\S]*restartAt\(pos\)/);
    expect(VIP_FIXES).not.toMatch(/function _toggleAB[\s\S]*resetOffset\(\)/);
  });

  test('vip-fixes refreshes isolation confirm after processingDone', () => {
    expect(VIP_FIXES).toMatch(/vip:processingDone[\s\S]*_pendingIsolation[\s\S]*_showIsoConfirm/);
  });

  test('vip-fixes seek sets app._transportSeeking and paints playheads while scrubbing', () => {
    expect(VIP_FIXES).toContain('app._transportSeeking = true');
    expect(VIP_FIXES).toContain('VIP_VISUALS.paintPlayheads');
  });

  test('visuals-bootstrap uses transport tick only for playhead (not main RAF loop)', () => {
    expect(VISUALS_BOOT).toContain("'vip:transportTick'");
    expect(VISUALS_BOOT).toContain('paintPlayheads');
    expect(VISUALS_BOOT).not.toMatch(/function _loop[\s\S]*_drawPlayhead\(\$\('waveCanvas'\)/);
    expect(VISUALS_BOOT).not.toMatch(/dispatchEvent\(new CustomEvent\('vip:fileLoaded'\)\)/);
  });

  test('diarization-timeline debounces ResizeObserver', () => {
    expect(DIAR_TIMELINE).toMatch(/ResizeObserver[\s\S]*requestAnimationFrame[\s\S]*_resize\(\)/);
  });

  test('toggleAB early-returns when vip-fixes patched', () => {
    const ctx = {
      _fixABPatched: true,
      outputBuffer: { length: 1 },
      abMode: 'original',
      isPlaying: false,
      play: jest.fn(),
    };
    VoiceIsolatePro.prototype.toggleAB.call(ctx);
    expect(ctx.abMode).toBe('original');
    expect(ctx.play).not.toHaveBeenCalled();
  });
});