# Release runbook (owner actions)

These steps need account access or signing keys, so no automated contributor
can do them. Code-side readiness is tracked in [PLATFORM_SYNC.md](PLATFORM_SYNC.md).

## 1. Unblock GitHub Actions

Every job on every branch fails within about 2 s with no runner assigned
(`runner_id: 0`, no steps run). The repository is public, so GitHub-hosted
`ubuntu-latest` runners are free; minutes, matrix size and workflow edits are
not the cause. This is an account-level hold, usually a failed payment or a
spending-limit lock. Fix it under **GitHub → Settings → Billing and plans**
(clear the failed payment or the lock), then re-run any workflow.

A self-hosted runner is not recommended here: on a public repository it runs
code from fork pull requests on your machine.

`pnpm prod:verify` is the gate either way; until CI runs, run it locally:
`xvfb-run -a pnpm prod:verify --network --desktop`.

## 2. Android release signing

The release workflow (`.github/workflows/release-build.yml`, job
`bundle-release`) already builds a signed AAB. It needs four repository
secrets (**Settings → Secrets and variables → Actions**):

| Secret | Value |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | `base64 -w0 release-keystore.jks` |
| `ANDROID_KEYSTORE_PASSWORD` | keystore password |
| `ANDROID_KEY_ALIAS` | key alias |
| `ANDROID_KEY_PASSWORD` | key password |

Create a keystore once and keep it backed up offline; losing it means you can
never update the app under the same signature:

```bash
keytool -genkeypair -v -keystore release-keystore.jks -alias voiceisolate \
  -keyalg RSA -keysize 4096 -validity 10000
```

Local signed build: export `ANDROID_KEYSTORE_PATH`,
`ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD`
(`android/app/build.gradle` reads them), then `pnpm android:release` (APK)
or `pnpm android:bundle` (AAB).

An unsigned release APK is not an option: Android refuses to install it. Until
a keystore exists the published asset stays the debug APK. Backup and device
transfer are now disabled in the manifest (`allowBackup="false"` plus
`data_extraction_rules.xml`), but the debug build is still debuggable.

When the release APK replaces the debug one, rename the asset in
`vercel.json` redirects, `scripts/validate-download-links.mjs`,
`docs/DOWNLOADS.md` and this folder in the same change.

## 3. Cut a correctly versioned release

The current `latest` release is tagged `v25.0.3` but carries
`VoiceIsolate-Pro-25.0.2-win-x64.exe` and a debug APK, so
`pnpm downloads:validate` fails against it. Cut a new version rather than
editing that release.

Order matters. CI's network tier (`prod:verify --network`, which
`release-build.yml` also runs as its gate) checks that the **published**
`latest` release matches `package.json`. So the release must exist, with its
assets, before the version bump reaches `main` or a tag is pushed; otherwise
both the PR gate and the release workflow's gate fail.

1. On a branch, bump the version everywhere `pnpm version:check` reads it:
   - `package.json` `"version": "25.1.0"`, then `pnpm mobile:sync-version`
     (Android, iOS, Capacitor user agents, PWA manifest);
   - `api-routes/index.js` (`version: '25.1.0'`);
   - `public/download/index.html` (`v25.1.0` and
     `VoiceIsolate-Pro-25.1.0-win-x64.exe`);
   - versioned download names in `vercel.json` and `docs/DOWNLOADS.md`.

   Then `pnpm version:check` and `xvfb-run -a pnpm prod:verify --desktop`
   (no `--network` yet: the release does not exist).
2. Build the artifacts from that commit: `pnpm android:bundle` (or
   `pnpm android:release` for an APK) with the signing variables from §2, and
   `pnpm build:electron` (Windows, or Linux with `wine` + `wine32`).
3. Publish GitHub release `v25.1.0` at that commit, marked latest, with
   `VoiceIsolate-Pro-25.1.0-win-x64.exe` and an APK named exactly
   `VoiceIsolate-Pro-android-debug.apk`: `scripts/validate-download-links.mjs`
   and the `/download/*.apk` redirects require that name (attach the AAB too
   if you like). Shipping a signed release APK under its own name needs the
   rename described in §2 first.
4. On the bump branch, update `docs/releases/release-provenance.json` before
   merging: `productVersion` `25.1.0`, `tag` `v25.1.0`, and the Android and
   Windows records from the assets you just published (SHA-256, URL, source
   SHA, build time). `downloads:validate` compares these against the release,
   so CI's network tier fails without them. Then merge; a tag push now also
   passes `release-build.yml`'s gate (the workflow cannot build a release
   that does not exist yet, because its gate validates the published one).
5. After Vercel deploys that commit, record the Web platform from the
   production deployment (`verification.method: "vercel-deployment"` with
   the deployment id/URL as evidence; strict mode refuses a Web record
   inferred from git HEAD). Then:

```bash
pnpm provenance:validate:strict
pnpm downloads:validate
```
