# Google Drive import / export

Optional **Open from Drive** and **Save to Drive** on Landing + Engineer (Web, Electron, Android WebView).

**Processing never uses Google Drive.** Files leave the device only when you tap **Save to Drive**.

## Enable in Google Cloud / Firebase

1. Use the existing Firebase project (ADR-001).
2. Enable **Google Drive API** and **Google Picker API**.
3. OAuth consent screen: add scope `https://www.googleapis.com/auth/drive.file`.
4. Authorized JavaScript origins (examples):
   - `https://voice-isolate-pro.vercel.app`
   - `http://127.0.0.1:3000` (dev)
   - Capacitor virtual origin (e.g. `voiceisolatepro.app`; not a public URL)
   - Electron: your `vip://` / localhost dev URL as configured
5. Inject at runtime (never commit real secrets):

```js
window.FIREBASE_API_KEY = '…';
window.FIREBASE_AUTH_DOMAIN = '….firebaseapp.com';
window.FIREBASE_PROJECT_ID = '…';
window.FIREBASE_APP_ID = '…';
window.GOOGLE_API_KEY = window.FIREBASE_API_KEY; // Picker developer key
// Optional explicit OAuth web client:
// window.GOOGLE_OAUTH_CLIENT_ID = '….apps.googleusercontent.com';
```

## UX

| Button | Surface | Behavior |
|--------|---------|----------|
| Open from Drive | Landing + Engineer | Sign-in → Picker → local ingest |
| Save to Drive | Landing + Engineer | Sign-in → upload processed WAV to Drive folder `VoiceIsolate Pro` |

## Architecture

- `src/core/GoogleDriveBridge.js` — REST + Picker helpers
- `public/app/firebase-config.js` — `signInWithGoogleDrive()` + Drive scope
- Electron allows Google auth popups in `electron/main.cjs`
- CSP: `vercel.json` + `server/securityHeaders.js`

See [ADR-002](../adr/002-google-drive-file-io.md).
