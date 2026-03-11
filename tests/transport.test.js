const fs = require('fs');
const path = require('path');

// Read app.js and evaluate to get VoiceIsolatePro without importing ES Module in Jest Node context
const appJsPath = path.join(__dirname, '../app.js');
const appJs = fs.readFileSync(appJsPath, 'utf8');

// Use new Function to create a local scope and evaluate the code, bypassing the DOMContentLoaded listener and module system
let VoiceIsolatePro;
try {
  // Strip out the event listener at the end so it doesn't crash on document not defined
  const safeCode = appJs.replace(/document\.addEventListener\('DOMContentLoaded'[\s\S]*\}\);/, '');
  VoiceIsolatePro = new Function('window', 'document', safeCode + '; return VoiceIsolatePro;')({}, {});
} catch (e) {
  console.error("Failed to load VoiceIsolatePro from app.js", e);
}

describe('Transport Methods (Missing Buffers)', () => {
  // Mock the environment to avoid constructor setup errors
  let mockContext;

  beforeEach(() => {
    mockContext = {
      inputBuffer: null,
      outputBuffer: null,
      abMode: 'original',
      isPlaying: false,
      playOffset: 0,
      playStartTime: 0,
      ctx: { currentTime: 0 },
      dom: {
        tpSpeed: { value: 1 },
        tpCur: { textContent: '' },
        tpSeek: { value: 0 },
        tpAB: { classList: { toggle: jest.fn() } },
        tpABLabel: { textContent: '' }
      },
      play: jest.fn(),
      fmtDur: jest.fn(() => '0:00')
    };
  });

  describe('seekDelta', () => {
    it('returns early when inputBuffer is missing', () => {
      // Intentionally don't set inputBuffer
      const result = VoiceIsolatePro.prototype.seekDelta.call(mockContext, 5);

      // Verification: ensure nothing crashed and playOffset was not changed
      expect(result).toBeUndefined();
      expect(mockContext.playOffset).toBe(0);
      expect(mockContext.play).not.toHaveBeenCalled();
    });

    it('updates playOffset and DOM when not playing', () => {
      mockContext.inputBuffer = { duration: 100 };
      mockContext.playOffset = 50;
      mockContext.fmtDur.mockReturnValue('0:55');

      VoiceIsolatePro.prototype.seekDelta.call(mockContext, 5);

      expect(mockContext.playOffset).toBe(55);
      expect(mockContext.dom.tpCur.textContent).toBe('0:55');
      expect(mockContext.fmtDur).toHaveBeenCalledWith(55);
      expect(mockContext.dom.tpSeek.value).toBe((55 / 100) * 1000);
      expect(mockContext.play).not.toHaveBeenCalled();
    });

    it('clamps playOffset to 0 when seeking backwards too far', () => {
      mockContext.inputBuffer = { duration: 100 };
      mockContext.playOffset = 10;

      VoiceIsolatePro.prototype.seekDelta.call(mockContext, -20);

      expect(mockContext.playOffset).toBe(0);
    });

    it('clamps playOffset to duration when seeking forwards too far', () => {
      mockContext.inputBuffer = { duration: 100 };
      mockContext.playOffset = 90;

      VoiceIsolatePro.prototype.seekDelta.call(mockContext, 20);

      expect(mockContext.playOffset).toBe(100);
    });

    it('accounts for current playback time and restarts playback when playing', () => {
      mockContext.inputBuffer = { duration: 100 };
      mockContext.isPlaying = true;
      mockContext.playOffset = 20;
      mockContext.playStartTime = 5;
      mockContext.ctx.currentTime = 15;
      mockContext.dom.tpSpeed.value = '2'; // 10 seconds elapsed * 2 speed = 20 seconds added

      VoiceIsolatePro.prototype.seekDelta.call(mockContext, 10);

      // Initial playOffset(20) + elapsed(20) + delta(10) = 50
      expect(mockContext.playOffset).toBe(50);
      expect(mockContext.play).toHaveBeenCalled();
    });
  });

  describe('seekTo', () => {
    it('returns early when inputBuffer is missing', () => {
      // Intentionally don't set inputBuffer
      const result = VoiceIsolatePro.prototype.seekTo.call(mockContext, 0.5);

      // Verification: ensure nothing crashed and playOffset was not changed
      expect(result).toBeUndefined();
      expect(mockContext.playOffset).toBe(0);
      expect(mockContext.play).not.toHaveBeenCalled();
    });

    it('works normally when inputBuffer exists', () => {
      mockContext.inputBuffer = { duration: 100 };
      VoiceIsolatePro.prototype.seekTo.call(mockContext, 0.5);

      expect(mockContext.playOffset).toBe(50);
    });
  });

  describe('toggleAB', () => {
    it('returns early when outputBuffer is missing', () => {
      // Intentionally don't set outputBuffer
      const result = VoiceIsolatePro.prototype.toggleAB.call(mockContext);

      // Verification: ensure abMode was not toggled
      expect(result).toBeUndefined();
      expect(mockContext.abMode).toBe('original');
      expect(mockContext.dom.tpAB.classList.toggle).not.toHaveBeenCalled();
    });

    it('works normally when outputBuffer exists', () => {
      mockContext.outputBuffer = { length: 44100 };
      VoiceIsolatePro.prototype.toggleAB.call(mockContext);

      expect(mockContext.abMode).toBe('processed');
      expect(mockContext.dom.tpAB.classList.toggle).toHaveBeenCalledWith('active', true);
    });
  });
});
