'use strict';

/**
 * One production gate decides "verified"; deploys and releases consume it.
 * These pins keep a later edit from quietly reintroducing a second, weaker
 * definition of success or a deploy path that skips the gate.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('production gate', () => {
  const pkg = JSON.parse(read('package.json'));
  const gate = read('scripts/prod-verify.mjs');

  test('pnpm prod:verify is the aggregate entry point', () => {
    expect(pkg.scripts['prod:verify']).toBe('node scripts/prod-verify.mjs');
  });

  test.each([
    'scripts/validate.js', 'scripts/check-version-sync.cjs', "pnpm('lint')", "pnpm('test')",
    'scripts/check-dsp-isolation.js', 'scripts/check-privacy-invariants.js', 'scripts/check-no-cloud-audio.js',
    'scripts/validate-model-integrity.mjs', 'scripts/verify-worklets.js', 'scripts/validate-release-provenance.mjs',
    'scripts/build.mjs', 'scripts/shell-qa-smoke.cjs', 'scripts/landing-smoke.cjs', 'scripts/quick-clean-smoke.cjs',
    'scripts/engineer-calibration-smoke.cjs', 'scripts/privacy-runtime-smoke.cjs', 'scripts/validate-download-links.mjs',
  ])('gate runs %s', (needle) => {
    expect(gate).toContain(needle);
  });

  test('gate reports failure through its exit code and never stops silently', () => {
    expect(gate).toMatch(/process\.exit\(failed\.length \? 1 : 0\)/);
  });

  test('every package.json browser smoke runs inside the gate', () => {
    for (const [name, cmd] of Object.entries(pkg.scripts)) {
      if (!name.startsWith('test:') || !/scripts\/[\w-]+-smoke\.cjs/.test(cmd)) continue;
      const script = cmd.match(/scripts\/[\w-]+-smoke\.cjs/)[0];
      expect({ name, inGate: gate.includes(script) }).toEqual({ name, inGate: true });
    }
  });
});

describe('CI workflows', () => {
  const ci = read('.github/workflows/ci.yml');
  const deploy = read('.github/workflows/deploy.yml');
  const release = read('.github/workflows/release-build.yml');

  test('ci runs every gate tier on PRs and main and is callable', () => {
    expect(ci).toMatch(/pull_request:/);
    expect(ci).toMatch(/workflow_call:/);
    expect(ci).toContain('xvfb-run -a node scripts/prod-verify.mjs --network --desktop');
    // The desktop tier needs the real Electron binary the dependency install skips.
    expect(ci).toMatch(/ELECTRON_SKIP_BINARY_DOWNLOAD: ''\s*\n\s*run: node node_modules\/electron\/install\.js/);
  });

  test('no workflow suppresses a required failure', () => {
    for (const wf of [ci, deploy, release]) {
      // YAML 1.1 accepts True/TRUE/yes/on as booleans; the shell no-op `:` suppresses like `true`.
      expect(wf).not.toMatch(/continue-on-error:\s*['"]?(?:true|yes|on)\b/i);
      expect(wf).not.toMatch(/\|\|\s*(?:true\b|:(?:\s|$))/i);
    }
  });

  test('production deploys start only after a successful main gate and use its exact SHA', () => {
    expect(deploy).toMatch(/workflow_run:\s*\n\s*workflows: \[ci\]/);
    expect(deploy).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(deploy).toContain("github.event.workflow_run.event == 'push'");
    expect(deploy).toContain('ref: ${{ github.event.workflow_run.head_sha }}');
  });

  test('production deploys are serialized and never roll main back', () => {
    expect(deploy).toMatch(/concurrency:\s*\n\s*group: deploy-production\s*\n\s*cancel-in-progress: false/);
    // A failed lookup must fail the job rather than read as "superseded".
    expect(deploy).toMatch(/set -euo pipefail\s*\n[^\n]*\n\s*tip="\$\(git ls-remote --exit-code origin refs\/heads\/main \| cut -f1\)"/);
    expect(deploy).toContain('if [ -z "$tip" ]; then');
    expect(deploy).toMatch(/Deploy Production\s*\n\s*if: steps\.tip\.outputs\.current == 'true'/);
  });

  test('the privileged workflow_run never builds or deploys pull-request code', () => {
    expect(deploy).not.toMatch(/event == 'pull_request'/);
    expect(deploy).not.toContain('--environment=preview');
  });

  test('Android release is built only from a gated, immutable SHA with a hash manifest', () => {
    expect(release).toContain('uses: ./.github/workflows/ci.yml');
    expect(release).toMatch(/needs: \[resolve, gate\]/);
    expect(release).toContain('ref: ${{ inputs.tag || github.sha }}');
    expect(release).not.toContain('github.ref }}');
    expect(release).toContain('ref: ${{ needs.resolve.outputs.sha }}');
    expect(release).toContain('SHA256SUMS');
    expect(release).toContain('release-manifest.json');
  });

  test('gate, deploy and release pin third-party actions to commit SHAs', () => {
    for (const wf of [ci, deploy, release]) {
      const refs = [...wf.matchAll(/uses:\s*([^\s#]+)/g)].map((m) => m[1]).filter((u) => !u.startsWith('./'));
      for (const ref of refs) expect(ref).toMatch(/@[0-9a-f]{40}$/);
    }
  });

  test('workflow copies under docs/ci-patches stay identical', () => {
    for (const name of ['ci.yml', 'deploy.yml', 'release-build.yml']) {
      expect(read(`docs/ci-patches/${name}`)).toBe(read(`.github/workflows/${name}`));
    }
  });
});

describe('prod:verify gate behaviour', () => {
  const { spawnSync } = require('child_process');
  const os = require('os');
  const gatePath = path.join(ROOT, 'scripts/prod-verify.mjs');

  test.each([['--only'], ['--only=']])('an empty %s selection exits 2 without verifying anything', (arg) => {
    const run = spawnSync(process.execPath, [gatePath, arg], { cwd: ROOT, encoding: 'utf8' });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('--only needs at least one step id');
  });

  test('--fail-fast reports skipped steps as skipped after a failure, not as a disabled tier', () => {
    // A throwaway root with stub scripts: the first selected step fails, the second must not run.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vip-gate-'));
    try {
      fs.mkdirSync(path.join(root, 'scripts'));
      fs.copyFileSync(gatePath, path.join(root, 'scripts/prod-verify.mjs'));
      fs.writeFileSync(path.join(root, 'scripts/apply-ci-patches.mjs'), 'process.exit(1);\n');
      fs.writeFileSync(path.join(root, 'scripts/check-version-sync.cjs'), 'process.exit(0);\n');
      const run = spawnSync(process.execPath,
        [path.join(root, 'scripts/prod-verify.mjs'), '--only', 'ci-patches,version', '--fail-fast'],
        { cwd: root, encoding: 'utf8' });
      expect(run.status).toBe(1);
      const report = JSON.parse(fs.readFileSync(path.join(root, 'output/prod-verify/report.json'), 'utf8'));
      const byId = Object.fromEntries(report.results.map((r) => [r.id, r]));
      expect(byId['ci-patches'].status).toBe('FAIL');
      expect(byId.version).toMatchObject({ status: 'NOT RUN', reason: 'skipped after a failure (--fail-fast)' });
      expect(byId.lint.reason).toBe('not selected');
      expect(report.verdict).toBe('FAIL');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
