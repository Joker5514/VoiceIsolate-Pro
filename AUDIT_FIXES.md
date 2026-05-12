# Repo Audit Fixes — May 2026

This PR addresses all 6 items identified in the May 12, 2026 repository audit.

## Fix 1 — Dual Service Worker Conflict ✅

**Problem:** Two SW files existed at different scope levels:
- `public/sw.js` (root scope)
- `public/app/sw.js` (app scope — canonical)

This caused browser scope conflicts and unpredictable caching.

**Fix:** `public/sw.js` replaced with a no-op stub that immediately activates
and claims clients, then defers all caching to `public/app/sw.js`.
The stub prevents 404s during the client transition period.

---

## Fix 2 — ONNX Model Delivery Documentation ✅

**Problem:** `public/app/models/` directory exists but `.onnx` files are not in
the repo. No documentation explained the download-on-first-use strategy.

**Fix:** Added `docs/MODEL_DELIVERY.md` documenting the full CDN waterfall
architecture: SW Cache → Vercel Blob → Cloudflare R2 → HuggingFace Hub.

---

## Fix 3 — model-cdn-loader.js Constraint Compliance ✅

**Problem:** The file name "cdn-loader" suggested a possible violation of the
100% local processing constraint.

**Fix:** Added a prominent compliance comment block at the top of
`public/app/model-cdn-loader.js` explaining that only *model weights* (not user
audio) are fetched, and that SW caching makes all repeat sessions fully offline.

---

## Fix 4 — RevenueCat Isolation Documentation ✅

**Problem:** `revenuecat.js` makes external network requests. Without explicit
documentation, future contributors could accidentally call billing code from
DSP paths.

**Fix:** Added `docs/REVENUECAT_ISOLATION.md` listing exactly which files are
allowed to call RevenueCat and which are forbidden, with a TODO for a CI lint rule.

---

## Fix 5 — vip-slider-patch.js Refactor Plan ✅

**Problem:** `vip-slider-patch.js` grew to 37KB — near parity with primary modules.
This is accumulated multi-AI hotfix debt masquerading as a patch file.

**Fix:** Added `docs/SLIDER_PATCH_REFACTOR.md` with a complete migration table,
step-by-step instructions, and acceptance criteria for folding its logic back
into `slider-map.js`, `app.js`, `visuals.js`, and `debug-audit.js`.

**Note:** The file itself is NOT deleted in this PR. Deletion requires the full
migration to be completed and `VIP_runAudit()` to pass ≥18/20 first.

---

## Fix 6 — .Jules / .jules Directory Deduplication ✅

**Problem:** Both `.Jules/` and `.jules/` existed at repo root, a macOS
case-insensitivity artifact. On Linux/Docker these are two separate directories.

**Fix:** Added `.Jules/README.md` marking the uppercase variant as deprecated
and pointing to `.jules/` as the canonical configuration directory.

---

## Vercel.json Headers — Already Correct ✅

The audit also flagged vercel.json as needing verification. Confirmed present:
- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Embedder-Policy: require-corp`

No changes needed. `SharedArrayBuffer` and Live mode are correctly enabled.
