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


  describe('stop', () => {
    it('resets transport state correctly when isVideo is false', () => {
      mockContext.isPlaying = true;
      mockContext.playOffset = 5;
      mockContext.isVideo = false;
      mockContext.teardownChain = jest.fn();
      mockContext.stopSpectro = jest.fn();

      VoiceIsolatePro.prototype.stop.call(mockContext);

      expect(mockContext.teardownChain).toHaveBeenCalled();
      expect(mockContext.isPlaying).toBe(false);
      expect(mockContext.playOffset).toBe(0);
      expect(mockContext.stopSpectro).toHaveBeenCalled();
      expect(mockContext.dom.tpCur.textContent).toBe('0:00');
      expect(mockContext.dom.tpSeek.value).toBe(0);
    });

    it('resets transport state and pauses video when isVideo is true', () => {
      mockContext.isPlaying = true;
      mockContext.playOffset = 5;
      mockContext.isVideo = true;
      mockContext.dom.videoPlayer = {
        pause: jest.fn(),
        currentTime: 5
      };
      mockContext.teardownChain = jest.fn();
      mockContext.stopSpectro = jest.fn();

      VoiceIsolatePro.prototype.stop.call(mockContext);

      expect(mockContext.dom.videoPlayer.pause).toHaveBeenCalled();
      expect(mockContext.dom.videoPlayer.currentTime).toBe(0);
      expect(mockContext.teardownChain).toHaveBeenCalled();
      expect(mockContext.isPlaying).toBe(false);
      expect(mockContext.playOffset).toBe(0);
      expect(mockContext.stopSpectro).toHaveBeenCalled();
      expect(mockContext.dom.tpCur.textContent).toBe('0:00');
      expect(mockContext.dom.tpSeek.value).toBe(0);
    });
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

    it('works normally when inputBuffer exists', () => {
      mockContext.inputBuffer = { duration: 100 };
      VoiceIsolatePro.prototype.seekDelta.call(mockContext, 5);

      expect(mockContext.playOffset).toBe(5);
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
