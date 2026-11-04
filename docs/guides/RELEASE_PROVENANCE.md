# Release provenance (VIP-038)

Two different provenance layers exist in this repo — do not confuse them:

- **Export provenance** (schema `vip-provenance`): per-audio-file
  sidecars recording source/output hashes for forensic exports.
- **Artifact provenance** (schema `vip-artifact-provenance`, this
  document): per-build sidecars binding a built artifact to its exact
  source commit, toolchain, dependency/model bindings, and checksum.
- **Release status** (`docs/releases/release-provenance.json`):
  per-platform status (`current` / `stale` / `unknown`) validated by
  `scripts/validate-release-provenance.mjs`. A `current` claim for a
  platform should rest on an artifact sidecar for that platform's
  build — the status file alone is not evidence.

## Generating and verifying

```sh
node scripts/build.mjs
node scripts/provenance/generate-provenance.mjs --artifact build/ --platform web
node scripts/provenance/verify-provenance.mjs --sidecar build/provenance.sidecar.json
```

For Android/desktop, pass the real built artifact path and platform
(`--platform android|windows`) plus `--workflow` / `--run` when a CI
run produced it. The generator refuses to run without an exact git
commit, and records workflow/run as `unknown` when the caller does not
supply them — it never invents them.

The verifier fails closed: malformed sidecar, missing artifact,
checksum or manifest mismatch, unrecorded or missing files, missing
bindings, or a lockfile/model-manifest binding that no longer
matches the repo all exit 1. (The sidecar itself lives inside a
directory artifact by default and is excluded from its own manifest
— it did not exist when the manifest was computed.)

## Demonstrated (web, this repo state)

- `build/` at commit `937e9626` (build id `vip-app-e14e27c53124`,
  289 precached): sidecar generated, verification PASSED.
- Fail-closed demonstrated: a sidecar with one flipped checksum
  fails (checksum + manifest-root mismatch), and a missing artifact
  fails. Both exit 1.

## What is and is not signed or independently attestable

- **Signed by the project: nothing.** No signing keys, no Sigstore,
  no code-signing certificate is part of this scheme. A sidecar is
  an integrity binding (recompute-and-compare), not a signature.
  Anyone with write access to the artifact directory can regenerate
  a matching sidecar — the sidecar proves the artifact matches its
  record, not who built it.
- **Independently attestable (when CI runs):** GitHub Actions
  artifact attestations and Vercel deployment records bind a build
  to a commit outside this repo's control. Comparing a sidecar's
  recorded commit to the deployment's recorded commit is the
  available independent check; wiring CI to publish sidecars
  alongside artifacts is future work, not done here.
- **Not covered here:** Android and desktop artifacts — no such
  builds are produced in this environment (Capacitor sync needs an
  Android SDK; Electron packaging needs its binary and a display),
  so no sidecar exists for them. The generator supports them; the
  builds do not exist yet.

## Limits

- A sidecar verifies the artifact it was generated for. It says
  nothing about the artifact's quality, and a regenerated sidecar
  after tampering would verify too — which is why sidecars belong
  in CI artifacts / release attachments, not only beside the build.
- Directory manifests hash file contents, not permissions,
  timestamps, or symlinks (symlinked model caches are resolved to
  their targets by the build step before hashing).
