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

describe('Transport Methods', () => {
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

    describe('pause', () => {
    beforeEach(() => {
      mockContext.teardownChain = jest.fn();
      mockContext.stopSpectro = jest.fn();
      mockContext.isVideo = false;
      mockContext.dom.videoPlayer = { pause: jest.fn() };
    });

    it('returns early if not playing', () => {
      mockContext.isPlaying = false;
      VoiceIsolatePro.prototype.pause.call(mockContext);

      expect(mockContext.teardownChain).not.toHaveBeenCalled();
      expect(mockContext.stopSpectro).not.toHaveBeenCalled();
      expect(mockContext.isPlaying).toBe(false);
    });

    it('updates playOffset based on currentTime and speed', () => {
      mockContext.isPlaying = true;
      mockContext.playStartTime = 10;
      mockContext.ctx.currentTime = 15;
      mockContext.playOffset = 5;
      mockContext.dom.tpSpeed.value = '1.5';

      VoiceIsolatePro.prototype.pause.call(mockContext);

      // (15 - 10) * 1.5 = 7.5. Added to initial playOffset (5) = 12.5.
      expect(mockContext.playOffset).toBe(12.5);
    });

    it('cleans up state and stops processing', () => {
      mockContext.isPlaying = true;

      VoiceIsolatePro.prototype.pause.call(mockContext);

      expect(mockContext.teardownChain).toHaveBeenCalled();
      expect(mockContext.stopSpectro).toHaveBeenCalled();
      expect(mockContext.isPlaying).toBe(false);
    });

    it('pauses video if isVideo is true', () => {
      mockContext.isPlaying = true;
      mockContext.isVideo = true;

      VoiceIsolatePro.prototype.pause.call(mockContext);

      expect(mockContext.dom.videoPlayer.pause).toHaveBeenCalled();
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

    it('works normally when inputBuffer exists and is playing (accumulates playOffset)', () => {
      mockContext.inputBuffer = { duration: 100 };
      mockContext.isPlaying = true;
      mockContext.playOffset = 10;
      mockContext.ctx.currentTime = 5;
      mockContext.playStartTime = 2;
      mockContext.dom.tpSpeed.value = 2; // speed = 2

      VoiceIsolatePro.prototype.seekTo.call(mockContext, 0.5);

      // (5 - 2) * 2 = 6, playOffset becomes 10 + 6 = 16 temporarily, but then is overwritten by frac * duration
      // The old behavior of accumulating playOffset before overwriting it is technically a bit redundant in the code,
      // but let's test that play() gets called and the new playOffset is frac * duration.
      expect(mockContext.playOffset).toBe(50);
      expect(mockContext.play).toHaveBeenCalled();
      expect(mockContext.fmtDur).not.toHaveBeenCalled();
    });

    it('works normally when inputBuffer exists and is not playing (updates UI)', () => {
      mockContext.inputBuffer = { duration: 100 };
      mockContext.isPlaying = false;
      mockContext.fmtDur.mockReturnValue('0:50');

      VoiceIsolatePro.prototype.seekTo.call(mockContext, 0.5);

      expect(mockContext.playOffset).toBe(50);
      expect(mockContext.play).not.toHaveBeenCalled();
      expect(mockContext.fmtDur).toHaveBeenCalledWith(50);
      expect(mockContext.dom.tpCur.textContent).toBe('0:50');
    });

    it('handles missing or invalid speed value gracefully', () => {
      mockContext.inputBuffer = { duration: 100 };
      mockContext.isPlaying = true;
      mockContext.playOffset = 10;
      mockContext.ctx.currentTime = 5;
      mockContext.playStartTime = 2;
      mockContext.dom.tpSpeed.value = 'invalid'; // should fallback to 1

      VoiceIsolatePro.prototype.seekTo.call(mockContext, 0.5);

      expect(mockContext.playOffset).toBe(50);
      expect(mockContext.play).toHaveBeenCalled();
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

    it('works normally when outputBuffer exists and is not playing', () => {
      mockContext.outputBuffer = { length: 44100 };
      VoiceIsolatePro.prototype.toggleAB.call(mockContext);

      expect(mockContext.abMode).toBe('processed');
      expect(mockContext.dom.tpAB.classList.toggle).toHaveBeenCalledWith('active', true);
      expect(mockContext.dom.tpABLabel.textContent).toBe('Processed');
      expect(mockContext.play).not.toHaveBeenCalled();
    });

    it('works normally when outputBuffer exists and is playing', () => {
      mockContext.outputBuffer = { length: 44100 };
      mockContext.isPlaying = true;
      mockContext.ctx.currentTime = 10;
      mockContext.playStartTime = 5;
      mockContext.playOffset = 2;
      mockContext.dom.tpSpeed.value = '1.5';

      VoiceIsolatePro.prototype.toggleAB.call(mockContext);

      expect(mockContext.abMode).toBe('processed');
      expect(mockContext.dom.tpAB.classList.toggle).toHaveBeenCalledWith('active', true);
      // playOffset += (currentTime - playStartTime) * speed -> 2 + (10 - 5) * 1.5 = 9.5
      expect(mockContext.playOffset).toBe(9.5);
      expect(mockContext.play).toHaveBeenCalled();
      expect(mockContext.dom.tpABLabel.textContent).toBe('Processed');
    });

    it('toggles back to original correctly', () => {
      mockContext.outputBuffer = { length: 44100 };
      mockContext.abMode = 'processed';

      VoiceIsolatePro.prototype.toggleAB.call(mockContext);

      expect(mockContext.abMode).toBe('original');
      expect(mockContext.dom.tpAB.classList.toggle).toHaveBeenCalledWith('active', false);
      expect(mockContext.dom.tpABLabel.textContent).toBe('Original');
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

});
