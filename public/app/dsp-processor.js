/* ============================================
   TOMBSTONE — dsp-processor.js is DEPRECATED
   ============================================
   This file is NOT loaded anywhere and must NOT be loaded.
   It registered 'voice-isolate-processor' — the same name as
   public/app/voice-isolate-processor.js — causing duplicate
   worklet registration (InvalidStateError in Chrome 110+).

   The canonical AudioWorklet is: public/app/voice-isolate-processor.js
   It is loaded exclusively by: PipelineOrchestrator.initWorklet()

   DO NOT import or addModule() this file.
   It is kept only for git history. Delete on next cleanup.
   ============================================ */
throw new Error('dsp-processor.js is deprecated. Use voice-isolate-processor.js instead.');
