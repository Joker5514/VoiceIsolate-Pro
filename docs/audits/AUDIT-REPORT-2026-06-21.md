# VoiceIsolate-Pro — Up-to-Date Comprehensive Audit

**Date**: June 21, 2026
**Scope**: Architecture compliance (CLAUDE.md), security, dependency CVEs, build/test/lint health, model integrity
**Branch audited**: `claude/sharp-darwin-w1vdxz` (HEAD `7e4caf8`)
**Supersedes**: `docs/audits/AUDIT-REPORT-2026-05-30.md` (which found 18 criticals; all major paths have since been remediated)

---

## EXECUTIVE SUMMARY

The repository is in **strong health**. Every automated quality gate is green and the
codebase is **compliant with the CLAUDE.md "Stem-Split & Live-Mix" source of truth**.
This is a marked improvement over the May 30 audit (which declared the repo
"NOT production-ready" with 18 critical issues).

| Gate | Result |
|---|---|
| `pnpm validate` (structural invariants) | ✅ All checks pass |
| `pnpm test` (Jest) | ✅ **67 suites / 1836 tests pass** |
| `pnpm lint` (ESLint) | ✅ **0 errors** / 24 warnings (pre-existing, legacy `app.js` + `landing.js`) |
| Model SHA-256 integrity | ✅ Both `.onnx` files hash-match the manifest **exactly** (recomputed) |
| Architecture / layer purity | ✅ No upward, sideways, or legacy-reaching imports |
| Hard prohibitions (CLAUDE.md §1.1) | ✅ None violated |
| Server-side security surface | ✅ Hardened (timing-safe HMAC, webhook sig + idempotency, rate limits, input validation) |
| Secrets hygiene | ✅ `.env*` gitignored & untracked; no shipped fallback secrets |

**Only one material finding:** two **moderate** transitive dependency CVEs (`qs`, `ip-address`),
both with **low real-world exploitability** in this app and both fixable with a one-line
`pnpm.overrides` pin — consistent with the repo's existing override practice. The remaining
items are low-severity code/doc hygiene.

---

## VERIFIED COMPLIANT (evidence)

### Architecture — "Stem-Split & Live-Mix" (CLAUDE.md §1–§2)
- **4-layer purity holds.** `src/core/` imports nothing outside core (`BufferPool`→`audio-config`,
  `SpectralCleanup`→`audio-config` only). No `src/presentation/` → `src/workers/` import. No
  `src/` file reaches up into `public/app/` legacy code. (`grep` sweeps clean.)
- **ORT is vendored, never CDN.** Both `public/app/ml-worker.js` and `src/workers/MLWorker.js`
  load ONNX Runtime via `importScripts('/lib/ort.min.js')`. `public/lib/ort.min.js` (360 KB) and
  the `ort-wasm-simd-threaded.*` files are committed to git. No worker imports a CDN URL.
- **Worklets are allowlisted.** The only `audioWorklet.addModule()` calls (in
  `src/pipeline/PlaybackMixer.js`) load `GateProcessor.js` and `DeEsserProcessor.js` — exactly the
  two playback-only worklets allowlisted by `scripts/validate.js`.
- **No live-mic, no SAB regression.** No `getUserMedia` call exists anywhere (only forbidding
  comments, tests, and the validator). No `SharedArrayBuffer` in `src/` (only a comment in
  `EngineerModeBridge.js` confirming its absence).
- **Legacy deletions stay deleted.** `pipeline-orchestrator.js` and `api-routes/auth.js` are absent
  (validator confirms).

### Model integrity (CLAUDE.md §3–§4)
Recomputed SHA-256 of the shipped binaries against `src/core/ModelManifest.js`:

| Model | Manifest SHA-256 | Actual | Size |
|---|---|---|---|
| `rnnoise_suppressor.onnx` | `0bc4319f…3b62b6` | **match** | 2,027,576 = manifest |
| `bsrnn_vocals.onnx` | `7edd7c51…a39c8141` | **match** | 3,870,554 = manifest |

Both hashes are non-null and pinned; `isValidEntry()` enforces same-origin relative URLs and a
64-hex hash shape.

### Security (CLAUDE.md §3)
- **Headers** (`server/securityHeaders.js`, `app.use()`d first in `server.js`): COOP `same-origin`,
  COEP `require-corp`, CORP `same-origin`, strict CSP (no `'unsafe-inline'` in `script-src` outside
  the scoped `/app`,`/blueprint`,`/docs` legacy exception), `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, `Permissions-Policy: microphone=(), camera=(), geolocation=()`, HSTS in prod.
- **License/JWT handling** (`api-routes/monetization.js`, `sync.js`): HMAC-SHA256 verification uses
  `crypto.timingSafeEqual` with a length guard (no timing oracle); tokens are discriminated by
  `source: 'stripe'`; secrets follow the **throw-in-production / random-dev-secret-with-warning**
  pattern — no hardcoded fallback ships.
- **Stripe webhook**: raw-body signature verification (`express.raw` mounted before `express.json`),
  plus a 24 h idempotency cache so retried events don't double-issue licenses.
- **Abuse controls**: per-endpoint in-memory rate limiters (+ `express-rate-limit` on `/checkout`),
  per-user sync rate limit, 10 MB/user storage quota, depth-limited & size-capped input sanitizers,
  ReDoS-safe email normalization, same-origin safe-redirect validation, and a terminal error handler
  that never leaks stack traces in production.
- **Secrets hygiene**: `.gitignore` covers `.env*`; `.env` is not tracked.

---

## FINDINGS

### 1. [Moderate] Two transitive dependency CVEs — pin via `pnpm.overrides`
`pnpm audit --prod` reports 2 moderate advisories, both pulled in transitively through
`express` / `express-rate-limit`:

| Package | Installed | Advisory | Fixed in | Path |
|---|---|---|---|---|
| `qs` | 6.14.2 | GHSA-q8mj-m7cp-5q26 — DoS in `qs.stringify` (comma-format arrays + `encodeValuesOnly`) | ≥ 6.15.2 | `express` → `qs`; `express` → `body-parser` → `qs` |
| `ip-address` | 10.1.0 | GHSA-v2v4-37r5-5v8g — XSS in `Address6` HTML-emitting methods | ≥ 10.1.1 | `express-rate-limit` → `ip-address` |

**Real-world exposure is low here:** the `qs` flaw is in *outbound* `qs.stringify` (Express parses
inbound query strings with `qs.parse`; the app does not call `stringify` with that config), and the
`ip-address` flaw is in HTML-rendering helpers that `express-rate-limit` does not invoke (it uses the
library for IPv6 normalization). Still, both are trivial to remediate and the repo already pins ~30
transitive deps in `pnpm.overrides`.

**Recommended fix** (consistent with existing practice) — add to `pnpm.overrides` in `package.json`:
```jsonc
"qs": ">=6.15.2",
"ip-address": ">=10.1.1"
```
then `pnpm install` and re-run `pnpm audit --prod` (expect 0 vulnerabilities).

### 2. [Low] `public/lib/ort-loader.js` — unused shim with a stale, misleading docstring
- The file's **code** correctly has **no CDN fallback** (local-only `importScripts('/lib/ort.min.js')`).
- But its **header docstring** still says it will "fall back to CDN," it declares an **unused
  `CDN_URL`** constant pointing at `cdn.jsdelivr.net`, and it pins a **stale ORT version (1.17.3)**
  while `package.json` ships `onnxruntime-web@1.25.1`.
- **It is not imported by any worker** (`ml-worker.js` and `MLWorker.js` reference `/lib/ort.min.js`
  directly) — it is dead code.
- `scripts/validate.js` only scans `public/app/` and `src/` for CDN/`getUserMedia` offenders, **not
  `public/lib/`**, so a real CDN reference here would pass validation.

**Recommendation:** delete `public/lib/ort-loader.js` (it is unused), **or** fix the docstring and
drop the `CDN_URL` constant. Either way, extend the `validate.js` offender scan to include
`public/lib/` so the "never CDN" guarantee is enforced there too.

### 3. [Low] Documentation drift — secret names in CLAUDE.md §3 / `.env.example` don't match code
CLAUDE.md §3 and `.env.example` name `ADMIN_SECRET`, `JWT_SECRET`, and `WEBHOOK_IDEMPOTENCY_KEY` as
the server secrets, but **none of those three are referenced by any code**. The running code uses
`LICENSE_JWT_SECRET` and `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` (webhook idempotency keys off
`event.id`, not `WEBHOOK_IDEMPOTENCY_KEY`). `.env.example` already bridges this with a back-compat
note for `LICENSE_JWT_SECRET`.

**Recommendation:** reconcile the docs to the implementation — either retire the unused names from
CLAUDE.md §3 / `.env.example`, or wire them if they are intended future controls (e.g. an
`ADMIN_SECRET`-gated admin route does not currently exist).

### 4. [Low / Informational] Dev ↔ prod CSP divergence is wider than "mirrors"
`server/securityHeaders.js` states "Production (Vercel) mirrors these," but `vercel.json` is
deliberately **broader** than the dev CSP:
- `script-src` adds the `www.gstatic.com` origin and `/_vercel/insights/` (third-party script origins).
- `connect-src` adds Vercel Blob (`*.public.blob.vercel-storage.com`), Firebase
  (`identitytoolkit` / `firestore` / `securetoken`), and `api.revenuecat.com`.

These are legitimate (analytics, Firebase, RevenueCat IAP, Blob-hosted model delivery), and audio
still never leaves the device. But it is not a 1:1 mirror, and `gstatic.com` slightly relaxes the
"no third-party script origins" stance.

**Recommendation:** update the `securityHeaders.js` comment to say production *extends* the dev policy
with explicitly-scoped analytics/IAP/Firebase origins, and document each added origin's purpose so a
future reviewer doesn't read it as drift.

### 5. [Informational] Open follow-ups carried from `AUDIT-RESULTS.md`
- Some non-runtime docs still mention the removed `voice-isolate-processor.js`.
- `vercel.json` allows Vercel-Blob `connect-src` origins for model delivery even though the manifest
  fetches models same-origin from `/app/models/` — harmless but worth a deliberate "same-origin only
  vs blob-routed" product decision.

### 6. [Informational] Jest does not exit gracefully
The suite passes but logs "A worker process has failed to exit gracefully" and relies on `forceExit`.
A leaked timer/handle is being masked. Cosmetic, but `--detectOpenHandles` would localize it for a
cleaner CI signal.

---

## SEVERITY ROLL-UP

| Severity | Count | Items |
|---|---|---|
| Critical | 0 | — |
| High | 0 | — |
| Moderate | 2 | `qs`, `ip-address` transitive CVEs (Finding 1) |
| Low | 3 | ort-loader stale shim (2), secret-name doc drift (3), CSP "mirrors" comment (4) |
| Informational | 3 | doc references (5), blob CSP (5), Jest open handle (6) |

## RECOMMENDED ORDER OF OPERATIONS
1. Pin `qs` ≥ 6.15.2 and `ip-address` ≥ 10.1.1 in `pnpm.overrides`; re-audit to 0. *(Finding 1)*
2. Delete or de-stale `public/lib/ort-loader.js` and extend the `validate.js` CDN scan to `public/lib/`. *(Finding 2)*
3. Reconcile secret names across CLAUDE.md §3 / `.env.example` / code. *(Finding 3)*
4. Clarify the dev/prod CSP comment and document prod-only origins. *(Finding 4)*

*All four are low-risk and independently shippable. No architectural change is implied or recommended —
the Stem-Split & Live-Mix architecture is intact and compliant.*
