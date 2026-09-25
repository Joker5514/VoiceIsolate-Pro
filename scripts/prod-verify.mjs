#!/usr/bin/env node
/**
 * Canonical production gate — `pnpm prod:verify`.
 *
 * One definition of "verified" for local runs, pull requests and releases.
 * Lower-level commands stay usable on their own; this runs them in a fixed
 * order, never stops at the first failure, and writes one report tying every
 * result to the exact commit it ran against.
 *
 * Tiers:
 *   static   repository integrity, versions, lint, unit/contract tests, DSP,
 *            privacy, model + worklet integrity, provenance, production build
 *   browser  real-Chromium journeys (Engineer, Landing, shell guards,
 *            runtime privacy) — on by default, `--no-browser` to skip
 *   network  live release/download contract — opt-in with `--network`
 *            (needs GitHub API + public download routes)
 *   desktop  Electron runtime security smoke — opt-in with `--desktop`
 *            (needs the Electron binary and a display, e.g. xvfb-run)
 *
 * Platform packaging (Android AAB, Electron NSIS) needs a JDK/Android SDK or
 * Windows and runs in release-build.yml / electron-build-win.mjs; the report
 * lists it as not verified here rather than implying it passed.
 *
 * Usage:
 *   pnpm prod:verify                      # static + browser
 *   pnpm prod:verify -- --no-browser      # static only
 *   pnpm prod:verify -- --network         # adds downloads:validate
 *   pnpm prod:verify -- --only lint,test  # named steps only
 *   pnpm prod:verify -- --fail-fast
 */
import { spawnSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const onlyArg = args.find((a) => a.startsWith('--only'));
const only = onlyArg
  ? (onlyArg.includes('=') ? onlyArg.split('=')[1] : args[args.indexOf(onlyArg) + 1] || '').split(',').filter(Boolean)
  : null;
const includeBrowser = !flag('--no-browser');
const includeNetwork = flag('--network');
const includeDesktop = flag('--desktop');
const failFast = flag('--fail-fast');

const node = (script, ...rest) => [process.execPath, [script, ...rest]];
const pnpm = (script) => [process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['run', '--silent', script]];

/** [id, tier, area, command] — order matters: build precedes build-dependent checks. */
const STEPS = [
  ['ci-patches', 'static', 'repository integrity', node('scripts/apply-ci-patches.mjs', '--check')],
  ['validate', 'static', 'repository integrity', node('scripts/validate.js')],
  ['duplicate-keys', 'static', 'repository integrity', node('scripts/check-duplicate-keys.js')],
  ['version', 'static', 'version synchronization', node('scripts/check-version-sync.cjs')],
  // lint/test go through package.json so their file lists and flags have one source.
  ['lint', 'static', 'lint', pnpm('lint')],
  ['test', 'static', 'unit / contract / integration tests', pnpm('test')],
  ['dsp-isolation', 'static', 'DSP', node('scripts/check-dsp-isolation.js')],
  ['privacy-static', 'static', 'privacy', node('scripts/check-privacy-invariants.js')],
  ['no-cloud-audio', 'static', 'privacy', node('scripts/check-no-cloud-audio.js')],
  ['models', 'static', 'model integrity', node('scripts/validate-model-integrity.mjs')],
  ['model-delivery', 'static', 'model integrity', node('scripts/validate-onnx-models.js')],
  ['worklets', 'static', 'worklet integrity', node('scripts/verify-worklets.js')],
  ['provenance', 'static', 'provenance', node('scripts/validate-release-provenance.mjs')],
  ['build', 'static', 'production build', node('scripts/build.mjs')],
  ['build-sam', 'static', 'production build', node('scripts/ensure-sam-in-build.mjs')],
  ['worklets-build', 'static', 'worklet integrity', node('scripts/verify-worklets.js', '--require-build')],
  ['e2e-live', 'browser', 'browser E2E', node('scripts/live-smoke.cjs')],
  ['e2e-engineer-rt', 'browser', 'Engineer E2E', node('scripts/engineer-rt-smoke.cjs')],
  ['e2e-engineer-upload', 'browser', 'Engineer E2E', node('scripts/engineer-upload-smoke.cjs')],
  ['e2e-calibration', 'browser', 'Engineer E2E', node('scripts/engineer-calibration-smoke.cjs')],
  ['e2e-tier-picker', 'browser', 'Engineer E2E', node('scripts/tier-picker-smoke.cjs')],
  ['e2e-ui', 'browser', 'browser E2E', node('scripts/precision-studio-ui-smoke.cjs')],
  ['e2e-landing', 'browser', 'landing E2E', node('scripts/landing-smoke.cjs')],
  ['e2e-quick-clean', 'browser', 'landing E2E', node('scripts/quick-clean-smoke.cjs')],
  ['e2e-shell-qa', 'browser', 'browser E2E', node('scripts/shell-qa-smoke.cjs')],
  ['privacy-runtime', 'browser', 'privacy', node('scripts/privacy-runtime-smoke.cjs')],
  ['downloads', 'network', 'provenance', node('scripts/validate-download-links.mjs')],
  // Needs the Electron binary and a display (xvfb-run on Linux).
  ['electron-security', 'desktop', 'security', node('scripts/electron-security-smoke.cjs')],
];

const NOT_RUN_HERE = [
  ['android-package', 'platform packaging', 'Android AAB: .github/workflows/release-build.yml (JDK 21 + signing secrets)'],
  ['electron-package', 'platform packaging', 'Electron NSIS: pnpm build:electron on Windows'],
];

function gitSha() {
  try { return execSync('git rev-parse HEAD', { cwd: root, encoding: 'utf8' }).trim(); } catch { return 'unknown'; }
}
function gitDirty() {
  try { return execSync('git status --porcelain', { cwd: root, encoding: 'utf8' }).trim().length > 0; } catch { return null; }
}

const selected = STEPS.filter(([id, tier]) => {
  if (only) return only.includes(id);
  if (tier === 'browser') return includeBrowser;
  if (tier === 'network') return includeNetwork;
  if (tier === 'desktop') return includeDesktop;
  return true;
});
if (only) {
  const unknown = only.filter((id) => !STEPS.some(([s]) => s === id));
  if (unknown.length) {
    console.error(`[prod:verify] unknown step(s): ${unknown.join(', ')}`);
    process.exit(2);
  }
}

const env = { ...process.env, ELECTRON_SKIP_BINARY_DOWNLOAD: '1' };
// server.js skips listen() under NODE_ENV=test; the browser smokes need a server.
if (env.NODE_ENV === 'test') env.NODE_ENV = 'development';
// Never let a verification run push local models to Vercel Blob.
delete env.BLOB_READ_WRITE_TOKEN;

const sha = gitSha();
const results = [];
console.log(`[prod:verify] ${selected.length} step(s) at ${sha}${gitDirty() ? ' (+ uncommitted changes)' : ''}\n`);

for (const [id, tier, area, [cmd, cmdArgs]] of selected) {
  const started = Date.now();
  console.log(`── ${id} (${area}) ${'─'.repeat(Math.max(0, 50 - id.length - area.length))}`);
  const run = spawnSync(cmd, cmdArgs, { cwd: root, env, stdio: 'inherit' });
  const status = run.status === 0 ? 'PASS' : 'FAIL';
  const durationMs = Date.now() - started;
  results.push({ id, tier, area, status, exitCode: run.status, signal: run.signal, durationMs });
  console.log(`   ${status} ${id} in ${(durationMs / 1000).toFixed(1)} s\n`);
  if (status === 'FAIL' && failFast) break;
}

for (const [id, tier] of STEPS) {
  if (!results.some((r) => r.id === id)) {
    results.push({ id, tier, status: 'NOT RUN', reason: only ? 'not selected' : `${tier} tier not enabled` });
  }
}
for (const [id, area, reason] of NOT_RUN_HERE) results.push({ id, tier: 'platform', area, status: 'NOT VERIFIED', reason });

const failed = results.filter((r) => r.status === 'FAIL');
const report = {
  generatedAt: new Date().toISOString(),
  commit: sha,
  dirty: gitDirty(),
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  ci: Boolean(process.env.CI),
  tiers: { static: true, browser: includeBrowser, network: includeNetwork, desktop: includeDesktop },
  verdict: failed.length ? 'FAIL' : 'PASS',
  results,
};
const outDir = path.join(root, 'output', 'prod-verify');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);

console.log('| Step | Tier | Status | Time |');
console.log('|---|---|---|---|');
for (const r of results) {
  const time = r.durationMs === undefined ? '-' : `${(r.durationMs / 1000).toFixed(1)} s`;
  console.log(`| ${r.id} | ${r.tier} | ${r.status}${r.reason ? ` (${r.reason})` : ''} | ${time} |`);
}
console.log(`\n[prod:verify] ${report.verdict} at ${sha} — report: output/prod-verify/report.json`);
process.exit(failed.length ? 1 : 0);
