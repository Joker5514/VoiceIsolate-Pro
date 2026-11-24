# Google Drive import / export

Optional **Open from Drive** and **Save to Drive** on Landing + Engineer (Web, Electron, Android WebView).

**Processing never uses Google Drive.** Files leave the device only when you tap **Save to Drive**. If the Drive env vars are unset, the buttons stay hidden and the rest of the upload/export UI is unchanged.

Auth uses the [Google Identity Services token client](https://developers.google.com/identity/oauth2/web/guides/use-token-model) (`google.accounts.oauth2.initTokenClient`) with **only** the `https://www.googleapis.com/auth/drive.file` scope. File picking uses the [Google Picker API](https://developers.google.com/workspace/drive/picker/guides/web-picker). Uploads follow [Drive API v3 upload types](https://developers.google.com/workspace/drive/api/guides/manage-uploads): multipart at or under 5 MB, resumable above 5 MB.

## Google Cloud setup

Do this once in the Google Cloud project that already hosts (or will host) the VoiceIsolate Pro OAuth client.

### 1. Project

1. Open [Google Cloud Console](https://console.cloud.google.com/).
2. Select the existing project, or create one (for example `voiceisolate-pro`).
3. Note the **project number** (APIs & Services → Dashboard, or Project settings). This is `GOOGLE_APP_ID` — digits only, used by Picker `setAppId`.

### 2. Enable APIs

In **APIs & Services → Library**, enable:

- **Google Drive API**
- **Google Picker API**

### 3. OAuth consent screen

1. **APIs & Services → OAuth consent screen** (Google Auth platform).
2. User type: **External** is fine for a public web app. Start in **Testing**.
3. App name, user support email, and developer contact: use Randy's.
4. Scopes: add only `https://www.googleapis.com/auth/drive.file` (non-sensitive; "See, edit, create, and delete only the specific Google Drive files you use with this app"). Do not add `drive`, `drive.readonly`, or `drive.metadata`.
5. **Test users:** while the app is in Testing, add every Google account that should try Drive import/export (including Randy's).
6. Publishing for production requires Google's verification if you leave Testing. `drive.file` is a non-sensitive scope, so verification is the lighter path. Do not add broader Drive scopes to avoid a restricted-scope review.

### 4. OAuth Web client

1. **Google Auth platform → Clients → Create Client → Web application**.
2. Name: `VoiceIsolate Pro Web`.
3. **Authorized JavaScript origins** (no path, exact scheme + host + port):

   - `https://voice-isolate-pro.vercel.app` (production, from `package.json` `homepage`)
   - `http://127.0.0.1:3000` (local Express)
   - `http://localhost:3000` (local Express, if you use this host)
   - Any additional Vercel preview or custom domain you will actually serve the app from

   Capacitor / Electron shells need their own origins if those builds should offer Drive (`capacitor://` / `vip://` or the desktop auth domain). Add them only when those builds are in use.

4. Authorized redirect URIs are not required for the GIS **token** client (implicit token model, no redirect). Leave redirects empty unless some other Firebase/Google sign-in flow already needs them.
5. Copy the **Client ID** (`….apps.googleusercontent.com`). There is no client secret to put in the browser app; do not commit the ID to git anyway.

### 5. API key (Picker developer key)

1. **APIs & Services → Credentials → Create credentials → API key**.
2. Restrict the key:
   - **Application restrictions → HTTP referrers**:
     - `https://voice-isolate-pro.vercel.app/*`
     - `http://127.0.0.1:3000/*`
     - `http://localhost:3000/*`
     - plus any other origins you added above
   - **API restrictions → Restrict key**: allow only **Google Picker API**.
3. Copy the key. Never commit it.

### 6. Vercel environment variables

In the Vercel project for this repo, set (Production, and Preview if you want Drive on preview deploys):

| Name | Value |
|------|--------|
| `GOOGLE_OAUTH_CLIENT_ID` | the Web client ID |
| `GOOGLE_API_KEY` | the restricted API key |
| `GOOGLE_APP_ID` | the Cloud **project number** (digits only) |

Then redeploy so `/api/client-config` can read them. Locally, copy `.env.example` to `.env` and fill the same names (`.env` is gitignored).

If these variables are missing, `GET /api/client-config` still returns 200 with empty strings, and the Drive buttons stay hidden. No error is shown.

### 7. What the app does with those values

- `GET /api/client-config` returns `googleOAuthClientId`, `googleApiKey`, and `googleAppId` (browser-public, Cache-Control: no-store).
- Landing and Engineer load that config on startup and unhide the Drive buttons only when the client ID and API key are both present.
- Sign-in calls `initTokenClient` with `scope: https://www.googleapis.com/auth/drive.file` and `include_granted_scopes: false`.
- Import: Picker → `files.get?alt=media` → existing `ingestFrom` / `handleFile` path (windowed ingest for large files, same as a local upload).
- Export: processed blob → default folder `VoiceIsolate Pro` via multipart or resumable upload.

## UX

| Button | Surface | Behavior |
|--------|---------|----------|
| Open from Drive | Landing + Engineer | GIS sign-in → Picker → local ingest |
| Save to Drive | Landing + Engineer | GIS sign-in → upload processed export to Drive folder `VoiceIsolate Pro` |

## Architecture

- `src/core/GoogleDriveBridge.js` — GIS token client, Picker, Drive REST
- `src/core/DriveSession.js` — in-memory access token (never on `window`)
- `api-routes/client-config.js` — env injection
- CSP: `vercel.json` + `server/securityHeaders.js` allow `https://accounts.google.com`, `https://apis.google.com`, and `https://www.googleapis.com`

See [ADR-002](../adr/002-google-drive-file-io.md).
