#!/usr/bin/env bash
# Vercel install hook — always use pnpm (never npm).
# npm install fails on this repo: pnpm-only lockfile, no package-lock.json.
set -euo pipefail
corepack enable
corepack prepare pnpm@10.0.0 --activate
pnpm install --frozen-lockfile