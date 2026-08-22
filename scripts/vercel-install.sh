#!/usr/bin/env bash
# Vercel install hook — always use pnpm (never npm).
# Bare npm fails on this repo: pnpm-only lockfile, no package-lock.json.
set -euo pipefail

HAD_NODE=1
NODE_BIN="node"
if ! command -v "${NODE_BIN}" >/dev/null 2>&1 && command -v node.exe >/dev/null 2>&1; then
  HAD_NODE=0
  NODE_SHIM_DIR="$(mktemp -d)"
  printf '#!/usr/bin/env sh\nexec node.exe "$@"\n' > "${NODE_SHIM_DIR}/node"
  chmod +x "${NODE_SHIM_DIR}/node"
  export PATH="${NODE_SHIM_DIR}:${PATH}"
fi

PNPM_VERSION="$("${NODE_BIN}" -p "require('./package.json').packageManager.split('@')[1]")"

if command -v corepack >/dev/null 2>&1; then
  corepack enable
  corepack prepare "pnpm@${PNPM_VERSION}" --activate
elif command -v corepack.cmd >/dev/null 2>&1; then
  corepack.cmd enable
  corepack.cmd prepare "pnpm@${PNPM_VERSION}" --activate
else
  echo "corepack not found; using pinned pnpm fallback"
fi

if [ "${HAD_NODE}" = "1" ] && command -v pnpm >/dev/null 2>&1; then
  pnpm install --frozen-lockfile
elif command -v npx >/dev/null 2>&1; then
  npx --yes "pnpm@${PNPM_VERSION}" install --frozen-lockfile
else
  echo "pnpm fallback unavailable" >&2
  exit 1
fi
