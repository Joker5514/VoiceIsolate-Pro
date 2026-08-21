# ADR-002: Optional Google Drive file import/export

**Date:** 2026-08-21  
**Status:** Accepted  
**Deciders:** VoiceIsolate Pro core team

---

## Context

Users asked for Google Drive on Web, Electron, and Android. Product rules require **100% local audio processing** (no cloud inference). Firebase Google sign-in already exists as ADR-001 for auth/presets.

## Decision

Add **user-initiated** Google Drive **import** and **export** only:

- Auth via Firebase `GoogleAuthProvider` with `drive.file` scope (least privilege).
- Import: Google Picker → download bytes → existing local decode/Process path.
- Export: local WAV/export Blob → Drive multipart upload into a `VoiceIsolate Pro` folder.
- Shared module: `src/core/GoogleDriveBridge.js`.
- Never called from AudioWorklet, MLWorker, StemSeparation, or automatic Process completion.

## Consequences

**Positive:** Cross-device file handoff without weakening local processing.  
**Negative:** Requires Firebase + Google Drive/Picker APIs configured; OAuth popups need CSP/Electron allowlists.

## Non-goals

Background library sync, auto-upload after Process, Drive-hosted inference.
