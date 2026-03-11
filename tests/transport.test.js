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

  describe('play', () => {
    beforeEach(() => {
      // Setup extra mocks for play()
      mockContext.stop = jest.fn();
      mockContext.ensureCtx = jest.fn();
      mockContext.buildLiveChain = jest.fn();
      mockContext.startSpectro = jest.fn();
      mockContext.startFreq = jest.fn();
      mockContext.tickTime = jest.fn();
    });

    it('returns early when there is no buffer', () => {
      mockContext.inputBuffer = null;
      mockContext.outputBuffer = null;

      const result = VoiceIsolatePro.prototype.play.call(mockContext);

      expect(mockContext.stop).toHaveBeenCalled();
      expect(mockContext.ensureCtx).toHaveBeenCalled();
      expect(result).toBeUndefined();
      expect(mockContext.buildLiveChain).not.toHaveBeenCalled();
      expect(mockContext.isPlaying).toBe(false);
    });

    it('sets up play correctly when buffer exists', () => {
      mockContext.inputBuffer = { some: 'buffer' };

      VoiceIsolatePro.prototype.play.call(mockContext);

      expect(mockContext.buildLiveChain).toHaveBeenCalledWith(mockContext.inputBuffer);
      expect(mockContext.isPlaying).toBe(true);
      expect(mockContext.playStartTime).toBe(0);
      expect(mockContext.dom.tpABLabel.textContent).toBe('Original');
      expect(mockContext.startSpectro).toHaveBeenCalled();
      expect(mockContext.startFreq).toHaveBeenCalled();
      expect(mockContext.tickTime).toHaveBeenCalled();
    });

    it('uses outputBuffer when in processed mode', () => {
      mockContext.inputBuffer = { some: 'buffer' };
      mockContext.outputBuffer = { some: 'processed buffer' };
      mockContext.abMode = 'processed';

      VoiceIsolatePro.prototype.play.call(mockContext);

      expect(mockContext.buildLiveChain).toHaveBeenCalledWith(mockContext.outputBuffer);
      expect(mockContext.dom.tpABLabel.textContent).toBe('Processed');
    });

    it('sets up video playback when isVideo is true', () => {
      mockContext.inputBuffer = { some: 'buffer' };
      mockContext.isVideo = true;
      mockContext.playOffset = 42;
      mockContext.dom.tpSpeed.value = '1.5';
      mockContext.dom.videoPlayer = {
        currentTime: 0,
        playbackRate: 1,
        muted: false,
        play: jest.fn().mockResolvedValue()
      };

      VoiceIsolatePro.prototype.play.call(mockContext);

      expect(mockContext.dom.videoPlayer.currentTime).toBe(42);
      expect(mockContext.dom.videoPlayer.playbackRate).toBe(1.5);
      expect(mockContext.dom.videoPlayer.muted).toBe(true);
      expect(mockContext.dom.videoPlayer.play).toHaveBeenCalled();
    });

    it('handles video playback rejection safely', async () => {
      mockContext.inputBuffer = { some: 'buffer' };
      mockContext.isVideo = true;
      mockContext.dom.tpSpeed.value = '1';
      mockContext.dom.videoPlayer = {
        play: jest.fn().mockRejectedValue(new Error('play blocked'))
      };

      // Should not throw
      expect(() => {
        VoiceIsolatePro.prototype.play.call(mockContext);
      }).not.toThrow();

      expect(mockContext.dom.videoPlayer.play).toHaveBeenCalled();
    });
  });

});
