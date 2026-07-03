# CI workflow sync

These files mirror `.github/workflows/` fixes that require the `workflow` OAuth scope to push directly.

After merging this PR, copy them into place (or run `pnpm run workflows:sync` if you have workflow scope):

```bash
cp contrib/github-workflows/ci.yml .github/workflows/ci.yml
cp contrib/github-workflows/deploy.yml .github/workflows/deploy.yml
```

Or refresh GitHub CLI auth once:

```bash
gh auth refresh -h github.com -s workflow
git checkout feat/fix-vercel-ci-workflows
git push origin feat/fix-vercel-ci-workflows
```