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

  test('ci runs the production gate on PRs and main and is callable', () => {
    expect(ci).toMatch(/pull_request:/);
    expect(ci).toMatch(/workflow_call:/);
    expect(ci).toContain('node scripts/prod-verify.mjs --network');
  });

  test('no workflow suppresses a required failure', () => {
    for (const wf of [ci, deploy, release]) {
      expect(wf).not.toMatch(/continue-on-error:\s*true/);
      expect(wf).not.toMatch(/\|\|\s*true/);
    }
  });

  test('deploys start only after a successful gate and use its exact SHA', () => {
    expect(deploy).toMatch(/workflow_run:\s*\n\s*workflows: \[ci\]/);
    expect(deploy.match(/workflow_run\.conclusion == 'success'/g)).toHaveLength(2);
    expect(deploy.match(/ref: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/g)).toHaveLength(2);
  });

  test('preview deploys never run fork code with secrets', () => {
    expect(deploy).toContain('head_repository.full_name == github.repository');
  });

  test('Android release is built only from a gated, pinned SHA with a hash manifest', () => {
    expect(release).toContain('uses: ./.github/workflows/ci.yml');
    expect(release).toMatch(/needs: \[resolve, gate\]/);
    expect(release).toContain('ref: ${{ needs.resolve.outputs.sha }}');
    expect(release).toContain('SHA256SUMS');
    expect(release).toContain('release-manifest.json');
  });

  test('workflow copies under docs/ci-patches stay identical', () => {
    for (const name of ['ci.yml', 'deploy.yml', 'release-build.yml']) {
      expect(read(`docs/ci-patches/${name}`)).toBe(read(`.github/workflows/${name}`));
    }
  });
});
