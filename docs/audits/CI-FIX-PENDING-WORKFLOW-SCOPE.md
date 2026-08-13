# CI fixes ready (blocked push ΓÇö needs `workflow` OAuth scope)

Branch (local): `fix/ci-android-electron-skip-and-deploy` @ 3bc5c8e

GitHub rejected push of `.github/workflows/*` because the active token scopes are only:
`gist, read:org, repo` (missing `workflow`).

To publish:

```bash
# Interactive ΓÇö grant workflow scope once
gh auth refresh -h github.com -s workflow,repo

cd C:\Users\randy\VoiceIsolate-Pro-remediation
git checkout fix/ci-android-electron-skip-and-deploy
git push -u origin HEAD
gh pr create --base main --fill
gh pr merge --squash
```

## What the commit fixes

1. **deploy.yml** ΓÇö job-level `if: secrets.VERCEL_TOKEN != ''` caused "workflow file issue" with **zero jobs**. Gate on `push`/`pull_request` only; skip Vercel CLI steps when token empty.
2. **release-build.yml** ΓÇö `ELECTRON_SKIP_BINARY_DOWNLOAD=1` so Android CI does not download Electron; pnpm 11.3.0 + frozen lockfile.

## Production already green

Vercel Git integration already deployed #751. Live enrollment verified on production.
