# Android — complete offline app

Capacitor 8 package: **Landing** at `/` + **Engineer Mode** at `/app/`, models and ORT WASM embedded.

## Download (users)

https://github.com/Joker5514/VoiceIsolate-Pro/releases/latest/download/VoiceIsolate-Pro-android-debug.apk

1. Enable **Install unknown apps** for your browser/Files app.
2. Open the APK and install.
3. If upgrading from a broken build, uninstall the old app first.

Web mirror: https://voice-isolate-pro.vercel.app/download/

## Build (maintainers)

```bash
pnpm android:build:win     # Windows host + JDK 21 + Android SDK
# or
pnpm android:build         # Unix
```

Pipeline:

1. `pnpm build` → `build/`
2. `scripts/prepare-android-complete.mjs` — offline landing, strip CDN fonts, require core models, **exclude Demucs**
3. `npx cap sync android`
4. `verify-worklets` + `verify-android-complete`
5. `gradlew assembleDebug` → `dist/android/VoiceIsolate-Pro-android-debug.apk`

## Runtime notes

| Topic | Behavior |
|-------|----------|
| Entry | Landing (`index.html`); Engineer at `/app/` |
| Models shipped | `bsrnn_vocals`, `rnnoise_suppressor`, `silero_vad` (+ int8 if present) |
| Not shipped | `demucs_v4_fp32`, `demucs_v4_quantized` (OOM / size) |
| Service Worker | **Disabled** on native / `vip-android.json` packages |
| Isolation | `MainActivity` injects COOP/COEP + correct MIME for JS/WASM |
| Debugging | WebView debugging enabled on sideload debug APKs (`chrome://inspect`) |
| File library | Same OPFS/IndexedDB FileLibrary as web (`src/core/FileLibrary.js`) |
| Boot restore | **Lazy** — catalog only until user opens/Analyzes (prevents WebView OOM) |
| Durable stems | Size-capped (`memory-limits.js`); oversized packs are not written |
| Project packs | `.vippack` import/export for handoff with desktop/web |

Rebuild after web changes: `pnpm android:build:win` (or `pnpm android:build`) so Capacitor picks up `build/` + `src/`.
| Origin | `https://voiceisolatepro.app` (Capacitor hostname) |

## Troubleshooting

| Symptom | Check |
|---------|--------|
| White screen on open | Uninstall old APK; reinstall latest; confirm WebView up to date |
| Models fail | APK must include `app/models/*.onnx` (run `verify-android-complete`) |
| Worklets fail | MIME must be `application/javascript` (MainActivity) |
| SharedArrayBuffer missing | COOP/COEP headers must be injected by MainActivity |

## Related

- [DOWNLOADS.md](../DOWNLOADS.md)
- [WORKLETS.md](WORKLETS.md)
- [MODEL_DELIVERY.md](MODEL_DELIVERY.md)
- `scripts/prepare-android-complete.mjs`, `scripts/verify-android-complete.mjs`
