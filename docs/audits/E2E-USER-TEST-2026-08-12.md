# E2E user test — 2026-08-12 (post enrollment UI)

## Surfaces exercised

| Surface | How | Result |
|---------|-----|--------|
| Landing Stem-Split | Local server + Chrome DevTools + `pnpm test:landing` | **PASS** |
| Engineer Mode | `pnpm test:live`, `pnpm test:engineer`, browser open `/app/` | **PASS** |
| Download hub | `http://127.0.0.1:3000/download/` + production HEAD | **PASS** |
| Android / Electron | Same web shell after `pnpm sync:src` / build (shared modules) | Parity via shared `src/` |

## Landing manual path

1. Upload synthetic speech-like WAV (3 s) → auto stem split  
2. Status: `Stems ready · calibrated: balanced`  
3. Backend: `WebGPU · Fast/Balanced/Max · 100% local`  
4. Speakers: `1 speaker detected · spectral fingerprint`  
5. **Focus on one voice** panel visible with 4 how-to steps  
6. Enroll 0–2 s → `24-D local voiceprint · speech ~99%`  
7. Isolate → matched diarization `S1` (sim 1.00)  
8. Play → mixer `isPlaying` true  

## Automated

- `pnpm test:landing` — ALL CHECKS PASSED  
- `pnpm test:live` — peak 0.388, nan 0, PASS  
- `pnpm test:engineer` — RT sliders PASS  
- `pnpm validate` + `pnpm check:cloud-audio` PASS  

## Issues found & fixed this session

| Issue | Severity | Fix |
|-------|----------|-----|
| Target enrollment UI was bare (times + 2 buttons only) | UX | Redesigned step-by-step UI with tips, quick-fill, status |
| Target enrollment missing on Landing | Gap | Mount shared `TargetSpeakerUI` after stems/speakers |
| `loadStems` cleared diarization after isolate | Bug | Preserve speaker segments on Landing isolate |
| Docs lagged enrollment / Clear Local Data | Docs | README + PRODUCTION_PIPELINE + docs index |

## Non-blocking notes

- ONNX Runtime may log EP assignment warnings (WebGPU + CPU ops) — expected, not a product failure.  
- Programmatic File injection does not update the OS “file chosen” label on the input (browser limitation).  
- Synthetic tones are not real multi-talker speech; production quality still depends on content.