# CI workflow patches

Ship path for product code is green on Vercel. Two GitHub Actions infra workflows still need a one-time patch under `.github/workflows/` (requires OAuth scope **workflow**).

| Live workflow | Source of truth in repo |
|---------------|-------------------------|
| `.github/workflows/deploy.yml` | `docs/ci-patches/deploy.yml` |
| `.github/workflows/release-build.yml` | `docs/ci-patches/release-build.yml` |

## Apply (maintainer with workflow scope)

```bash
gh auth refresh -h github.com -s workflow,repo
pnpm ci:apply-patches   # or: node scripts/apply-ci-patches.mjs
git checkout -b fix/ci-android-electron-skip-and-deploy
git add .github/workflows/
git commit -m "fix(ci): unbreak deploy.yml and Android release install"
git push -u origin HEAD
gh pr create --base main --fill && gh pr merge --squash
```

## What the patches fix

1. **deploy.yml** — job-level `if: secrets.VERCEL_TOKEN != ''` caused *workflow file issue* with zero jobs. Gate on event/ref only.
2. **release-build.yml** — `ELECTRON_SKIP_BINARY_DOWNLOAD=1` so Android CI does not download Electron during `pnpm install`.

## Verify patches are in sync

```bash
pnpm ci:check-patches
```
