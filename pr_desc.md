🎯 **What:** The `pause()` method in `app.js` was missing unit test coverage. Added comprehensive test cases in `tests/transport.test.js` to ensure the correct behavior of the playback pausing logic.

📊 **Coverage:**
- Added test verifying early return when `isPlaying` is false.
- Added test verifying accurate calculation and update of `playOffset` considering `currentTime` and playback speed.
- Added test verifying state cleanup operations (`teardownChain` and `stopSpectro`) and setting `isPlaying` back to false.
- Added test verifying conditional pausing of the internal video element if `isVideo` is true.

✨ **Result:** Improved test reliability by confirming `pause()` calculates exact audio offsets and triggers side effects safely without crashing, catching potential regressions.
