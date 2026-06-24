'use strict';

const fs = require('fs');
const path = require('path');

describe('release-build workflow', () => {
  const workflowPath = path.join(__dirname, '../.github/workflows/release-build.yml');
  let workflow;

  beforeAll(() => {
    workflow = fs.readFileSync(workflowPath, 'utf8');
  });

  test('exists', () => {
    expect(fs.existsSync(workflowPath)).toBe(true);
  });

  test('builds Android release AAB', () => {
    expect(workflow).toContain('bundleRelease');
    expect(workflow).toContain('voiceisolate-pro-release-aab');
  });

  test('uses keystore secrets for signing', () => {
    expect(workflow).toContain('ANDROID_KEYSTORE_BASE64');
    expect(workflow).toContain('ANDROID_KEYSTORE_PASSWORD');
    expect(workflow).toContain('ANDROID_KEY_ALIAS');
    expect(workflow).toContain('ANDROID_KEY_PASSWORD');
  });
});
