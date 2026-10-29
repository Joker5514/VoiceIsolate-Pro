# Android — Capacitor package

VoiceIsolate Pro uses Capacitor 8 to package the shared web product shell for Android. The app opens the Landing surface at `/` and the same Engineer Console used on desktop browsers, Android browsers, and Electron at `/app/`. Android Chrome uses the production website. The APK is a separate package of that shell and is not the website deployment.

## Current download

- Latest APK: https://github.com/Joker5514/VoiceIsolate-Pro/releases/latest/download/VoiceIsolate-Pro-android-debug.apk
- Pinned `v25.0.3`: https://github.com/Joker5514/VoiceIsolate-Pro/releases/download/v25.0.3/VoiceIsolate-Pro-android-debug.apk
- Download hub: https://voice-isolate-pro.vercel.app/download/

Published `v25.0.3` APK metadata (repository package version remains `25.0.2`):

- File: `VoiceIsolate-Pro-android-debug.apk`
- Size: `101650376` bytes
- SHA-256: `70317aaa84c3f2ca286115a878fd79978de80e8df0a2cc9538201bf9bf7dc626`
- GitHub asset updated: `2026-09-09T23:31:41Z`
- Channel: **debug/sideload**, not a Play Store production artifact

Install:

1. Enable **Install unknown apps** for your browser or Files app.
2. Open the APK and install it.
3. When replacing a problematic older debug build, uninstalling the old APK first can clear stale native/web state.

## Offline and privacy behavior

Core isolation is local and packaged to work without a network connection after required application/model assets are present. Optional Google Drive file I/O, release downloads, and other explicitly networked features require connectivity. User audio is not sent to a server for processing or inference.

The Android manifest intentionally omits microphone capture. The product is upload-only.

## Build

```bash
pnpm install --frozen-lockfile
pnpm android:build:win     # Windows host + JDK 21 + Android SDK
# or
pnpm android:build         # Unix
```

Pipeline:

1. `pnpm build` → `build/`
2. `scripts/prepare-android-complete.mjs` prepares the offline web payload and validates required assets.
3. `npx cap sync android`
4. `verify-worklets` + `verify-android-complete`
5. Gradle produces the debug APK.

Release AAB:

```bash
pnpm android:bundle
```

## Runtime contract

| Topic | Behavior |
|---|---|
| Entry | Landing (`index.html`); Engineer Console at `/app/` |
| Engineer UI | Same `engineer-console.js/css` as web/desktop; Android prepare/verify requires these assets |
| Models shipped | Core packaged model set validated by `verify-android-complete` |
| Large optional models | Demucs variants are excluded from the standard APK when size/OOM constraints require it |
| Service Worker | Disabled in the native package |
| Isolation headers | `MainActivity` injects COOP/COEP and correct MIME handling for packaged JS/WASM/worklets |
| WebView debugging | `WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)` — debug APKs can use `chrome://inspect`; release builds disable it |
| Capacitor config | `webContentsDebuggingEnabled` defaults to `false`; native debug behavior is controlled by `BuildConfig.DEBUG` |
| File library | Shared FileLibrary/OPFS-or-IDB abstraction from the web codebase |
| Boot restore | Lazy hydration to avoid loading large media into memory on startup |
| Project packs | `.vippack` import/export remains the cross-surface handoff format |

Capacitor uses the virtual hostname `voiceisolatepro.app`; that hostname is an application origin, not a public website.

## Freeze-resistance requirements

Android shares the same renderer-thread safeguards as the web shell. Long post-ML/sample work must use cooperative scheduling (`src/pipeline/ui-yield.js`) instead of monopolizing the WebView main thread. Presentation-only visualizers must cancel stale work and avoid continuous idle painting.

After any shared web/Engineer change, rebuild the APK before claiming the published native package contains that fix.

## Troubleshooting

| Symptom | Check |
|---|---|
| White screen on open | Reinstall the latest APK; update Android System WebView/Chrome; confirm the packaged shell passed `verify-android-complete` |
| Browse/upload does nothing | Confirm the native `OPEN_DOCUMENT` chooser and manifest queries are present; use compact `accept="audio/*,video/*"` values for OEM compatibility |
| UI appears frozen | Verify the build includes cooperative renderer work, current Engineer assets, and current processing cancellation logic; reproduce with the browser/Engineer smoke matrix before rebuilding |
| Models fail | Verify packaged `app/models/*.onnx` assets and integrity checks |
| Worklets fail | Packaged worklet responses must use JavaScript MIME types |
| SharedArrayBuffer missing | Confirm COOP/COEP injection from `MainActivity` |
| Remote inspection unavailable | Expected on release builds; only debug builds enable WebView debugging |

## Release truth

The published APK can be older than current `main`. Consult:

- [`../DOWNLOADS.md`](../DOWNLOADS.md)
- [`../releases/release-provenance.json`](../releases/release-provenance.json)
- [`../releases/PLATFORM_SYNC.md`](../releases/PLATFORM_SYNC.md)

Validate live routes and GitHub assets with:

```bash
pnpm downloads:validate
```

## Related

- [WORKLETS.md](WORKLETS.md)
- [MODEL_DELIVERY.md](MODEL_DELIVERY.md)
- `scripts/prepare-android-complete.mjs`
- `scripts/verify-android-complete.mjs`
