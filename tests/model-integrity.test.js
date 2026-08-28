const { spawnSync } = require('child_process');
const path = require('path');

test('canonical model validator verifies source delivery bytes', () => {
  const root = path.join(__dirname, '..');
  const result = spawnSync(process.execPath, ['scripts/validate-model-integrity.mjs'], { cwd: root, encoding: 'utf8' });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('bsrnn_vocals: verified');
  expect(result.stdout).toContain('verified 4 shipped manifest entries');
});
