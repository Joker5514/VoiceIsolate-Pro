/**
 * VIP-008 box 1 — the Android signing documentation stays true.
 *
 * docs/releases/RELEASE_RUNBOOK.md §2 must document exactly the signing
 * configuration the release workflow and Gradle actually use: every
 * repository secret the workflow references, every environment variable
 * build.gradle reads — and no credential values anywhere in the doc.
 * If a secret is renamed in the workflow or Gradle, this test fails
 * until the runbook is updated in the same change.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const runbook = fs.readFileSync(path.join(ROOT, 'docs/releases/RELEASE_RUNBOOK.md'), 'utf8');
const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/release-build.yml'), 'utf8');
const gradle = fs.readFileSync(path.join(ROOT, 'android/app/build.gradle'), 'utf8');

function section2() {
  const start = runbook.indexOf('## 2. Android release signing');
  const end = runbook.indexOf('## 3.', start);
  return runbook.slice(start, end === -1 ? undefined : end);
}

test('runbook documents every secret the release workflow references', () => {
  const workflowSecrets = new Set([...workflow.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]));
  expect(workflowSecrets.size).toBeGreaterThan(0);
  const doc = section2();
  for (const secret of workflowSecrets) {
    expect(doc).toContain(`\`${secret}\``);
  }
});

test('runbook documents every signing variable Gradle reads', () => {
  const gradleVars = new Set([...gradle.matchAll(/System\.getenv\('(ANDROID_[A-Z0-9_]+)'\)/g)].map((m) => m[1]));
  expect(gradleVars.size).toBe(4);
  const doc = section2();
  for (const name of gradleVars) {
    expect(doc).toContain(name);
  }
});

test('runbook documents no credential values (names and commands only)', () => {
  const doc = section2();
  expect(doc).not.toMatch(/-----BEGIN/);
  // A real keystore blob or password would show up as a long opaque token;
  // the doc legitimately contains only commands, names, and short labels.
  expect(doc).not.toMatch(/[A-Za-z0-9+/]{80,}={0,2}/);
});

test('runbook states where the secrets live and that the debug APK stays until a keystore exists', () => {
  const doc = section2();
  expect(doc).toContain('Settings');
  expect(doc).toContain('debug APK');
});
