# CI fixes ready (apply needs `workflow` OAuth scope)

Proposed YAML lives in-repo (not yet under `.github/workflows/`):

| Target | Patch file |
|--------|------------|
| `.github/workflows/deploy.yml` | [`docs/ci-patches/deploy.yml`](../ci-patches/deploy.yml) |
| `.github/workflows/release-build.yml` | [`docs/ci-patches/release-build.yml`](../ci-patches/release-build.yml) |

GitHub rejects agent pushes of `.github/workflows/*` without OAuth scope **`workflow`**.

### Apply (maintainer)

```bash
gh auth refresh -h github.com -s workflow,repo

cd VoiceIsolate-Pro
cp docs/ci-patches/deploy.yml .github/workflows/deploy.yml
cp docs/ci-patches/release-build.yml .github/workflows/release-build.yml
git checkout -b fix/ci-android-electron-skip-and-deploy
git add .github/workflows/
git commit -m "fix(ci): unbreak deploy.yml and Android release install"
git push -u origin HEAD
gh pr create --base main --fill && gh pr merge --squash
```

### What the patches fix

1. **deploy.yml** — job-level `if: secrets.VERCEL_TOKEN != ''` caused *workflow file issue* with **zero jobs**. Gate on event/ref only; skip Vercel CLI when token empty (Git-connected Vercel still deploys).
2. **release-build.yml** — `ELECTRON_SKIP_BINARY_DOWNLOAD=1` so Android CI does not flake on Electron binary download; pnpm 11.3.0 + frozen lockfile.

### Production already green

Vercel Git integration deployed #751. Live enrollment verified on https://voice-isolate-pro.vercel.app/ (2026-08-12/13).
