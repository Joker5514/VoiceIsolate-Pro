# TODO — vip-fixes.js merge-back audit

- `patchTransport(app)` → merge into `/tmp/workspace/Joker5514/VoiceIsolate-Pro/public/app/app.js` transport bindings and playback state management.
- `patchAB(app)` → merge into `/tmp/workspace/Joker5514/VoiceIsolate-Pro/public/app/app.js` A/B label rendering, toggle state, and runPipeline finally-guard logic.
- `patchSliders(app)` → merge into `/tmp/workspace/Joker5514/VoiceIsolate-Pro/public/app/app.js` slider input binding / live parameter dispatch path.
- `patchSliderSearch()` → merge into `/tmp/workspace/Joker5514/VoiceIsolate-Pro/public/app/app.js` slider search filtering.
- `patchPresetSelect(app)` → merge into `/tmp/workspace/Joker5514/VoiceIsolate-Pro/public/app/app.js` preset selector change handler.
- `patchAccordions()` → merge into `/tmp/workspace/Joker5514/VoiceIsolate-Pro/public/app/app.js` (or an explicit UI module) so accordion header behavior is first-party rather than DOM-cloned at runtime.
- `VIP_DEBUG_REPORT()` → decide whether the debug snapshot belongs in `/tmp/workspace/Joker5514/VoiceIsolate-Pro/public/app/app.js` or a dedicated diagnostics module.
