const { spawnSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
describe('release provenance validator', () => {
  test('accepts documented contradictions only as explicit warnings', () => {
    const result = spawnSync(process.execPath, ['scripts/validate-release-provenance.mjs'], { cwd: root, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('android: stale');
  });

  test('strict release gate rejects unknown and stale provenance', () => {
    const result = spawnSync(process.execPath, ['scripts/validate-release-provenance.mjs', '--strict'], { cwd: root, encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('web: unknown');
  });
});
