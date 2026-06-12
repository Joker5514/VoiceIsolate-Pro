# ADR-001: Firebase as Intentional Cloud Exception

**Date:** 2026-05-20
**Status:** Accepted
**Deciders:** VoiceIsolate Pro core team

---

## Context

VoiceIsolate Pro is designed as a **privacy-first, 100% local audio processing** platform. The core architecture constraint is that no audio data ever leaves the browser. All DSP, ML inference, and spectral processing runs on-device via Web Audio API, AudioWorklet, and ONNX Runtime Web.

However, a commercial product requires:
1. User identity (to gate tier features and prevent abuse)
2. Optional cloud sync for user-created presets
3. Session telemetry for billing and enforcement

The question was whether to satisfy these needs with a cloud service or a purely local mechanism.

---

## Decision

**Firebase (Auth + Firestore) is used as the sole cloud service** in VoiceIsolate Pro.

It is used exclusively for:
- **Authentication:** Firebase Auth with Google Sign-In and Email/Password (`firebase-config.js`)
- **Preset sync:** Optional, user-initiated cloud save/load of presets (`savePreset`, `getUserPresets`)
- **Session logging:** Billing/tier enforcement (`logSession`)

Firebase is loaded only in `public/app/firebase-config.js` and is **never imported** from:
- `dsp-processor.js` (AudioWorklet — no network allowed)
- `ml-worker.js` (ML inference worker)
- `dsp-worker.js` (DSP offline worker)
- `dsp-core.js`, `dsp-stages.js`, `fft-bridge.js` (pure DSP math)
- Any other audio pipeline file

Audio data (PCM samples, spectral frames, model inputs/outputs) is **never sent to Firebase**.

---

## Consequences

**Positive:**
- Mature, well-maintained auth and realtime-database solution with multiple sign-in methods
- Non-Google users can create accounts and sign in via email/password
- Session logging enables accurate billing and tier enforcement
- Cloud preset sync adds value for multi-device users

**Negative:**
- Introduces a runtime dependency on Google infrastructure for auth flows
- Firebase SDK is loaded from `gstatic.com` CDN — an exception to the local-library rule (acceptable because it is UI-layer only, not audio-processing layer)

---

## Alternatives Considered

### Option A: Supabase (PostgreSQL + Auth)
- Self-hostable, open-source alternative
- More complex to configure; Google Sign-In requires additional setup
- Rejected: higher operational burden for a small team; Firebase's zero-config Google Auth is a strong advantage

### Option B: Local-only (IndexedDB presets, no cloud auth)
- Fully private; zero cloud dependency
- No tier enforcement possible without a server
- Rejected: business model requires gating Pro/Studio features; local-only cannot prevent abuse

### Option C: Custom JWT server (existing `api/auth.js`)
- VoiceIsolate Pro ships `api/auth.js` (Vercel serverless) for license JWT issuance
- Could be extended to be the sole auth layer
- Rejected as primary auth: Firebase reduces maintenance burden for auth flows (password reset, OAuth, session management) that are complex to implement securely from scratch

---

## Implementation Notes

- Firebase credentials are injected at runtime via `window.FIREBASE_*` variables (set by the Vercel environment or the service worker) — never hardcoded in source
- `firebase-config.js` exports `auth`, `db`, and helper functions — callers must guard against Firebase being unavailable in non-authenticated sessions
- The CSP in `vercel.json` must explicitly allow Firebase network endpoints in `connect-src` (for example `https://identitytoolkit.googleapis.com`, `https://securetoken.googleapis.com`, and `https://firestore.googleapis.com` as used by Auth and Firestore); `'self'` does **not** cover these third-party origins. If the Firebase SDK is loaded from the `gstatic.com` CDN, `script-src` must also allow `https://www.gstatic.com`.
