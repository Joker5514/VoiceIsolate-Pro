# ADR-002: Optional Google Drive file import/export

**Date:** 2026-08-21  
**Updated:** 2026-11-24  
**Status:** Accepted  
**Deciders:** VoiceIsolate Pro core team

---

## Context

Users asked for Google Drive on Web, Electron, and Android. Product rules require **100% local audio processing** (no cloud inference). Earlier revisions obtained a `drive.file` token through Firebase `GoogleAuthProvider`. The current path uses Google Identity Services so Drive no longer depends on Firebase Auth, and credentials come from Vercel env via `GET /api/client-config`.

## Decision

Add **user-initiated** Google Drive **import** and **export** only:

- Auth via the [GIS OAuth token client](https://developers.google.com/identity/oauth2/web/guides/use-token-model) (`google.accounts.oauth2.initTokenClient`) with **only** `https://www.googleapis.com/auth/drive.file`.
- Import: [Google Picker](https://developers.google.com/workspace/drive/picker/guides/web-picker) → Drive API `alt=media` download → existing local decode/Process path (including windowed ingest for large files).
- Export: local WAV/export Blob → Drive [multipart or resumable upload](https://developers.google.com/workspace/drive/api/guides/manage-uploads) into a `VoiceIsolate Pro` folder (multipart ≤ 5 MB, resumable above).
- Public config (`GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_API_KEY`, optional `GOOGLE_APP_ID`) is read from env and served by `/api/client-config`. If those values are missing, Drive buttons stay hidden.
- Shared module: `src/core/GoogleDriveBridge.js`.
- Never called from AudioWorklet, MLWorker, StemSeparation, or automatic Process completion.

## Consequences

**Positive:** Cross-device file handoff without weakening local processing; least-privilege `drive.file` scope; no Firebase requirement for Drive.  
**Negative:** Requires a Google Cloud OAuth web client, Picker API, and API key configured; OAuth popups need CSP/Electron allowlists.

## Non-goals

Background library sync, auto-upload after Process, Drive-hosted inference.
