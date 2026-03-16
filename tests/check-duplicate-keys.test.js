const { findDuplicateKeys } = require('../scripts/check-duplicate-keys.js');

describe('findDuplicateKeys', () => {
  test('returns empty array for valid JSON with no duplicates', () => {
    const json = '{"a": 1, "b": 2, "c": 3}';
    expect(findDuplicateKeys(json)).toEqual([]);
  });

  test('detects duplicate key at top level', () => {
    const json = '{"a": 1, "b": 2, "a": 3}';
    expect(findDuplicateKeys(json)).toEqual(['a']);
  });

  test('detects multiple different duplicate keys', () => {
    const json = '{"a": 1, "b": 2, "a": 3, "b": 4}';
    expect(findDuplicateKeys(json)).toEqual(['a', 'b']);
  });

  test('does not flag same key at different nesting levels', () => {
    const json = '{"a": {"a": 1}}';
    expect(findDuplicateKeys(json)).toEqual([]);
  });

  test('detects duplicate key inside nested object', () => {
    const json = '{"obj": {"x": 1, "x": 2}}';
    expect(findDuplicateKeys(json)).toEqual(['x']);
  });

  test('ignores braces inside string values', () => {
    const json = '{"a": "value with { and }", "b": 1}';
    expect(findDuplicateKeys(json)).toEqual([]);
  });

  test('ignores key-like patterns inside string values', () => {
    const json = '{"a": "\\"b\\": 1", "b": 2}';
    expect(findDuplicateKeys(json)).toEqual([]);
  });

  test('handles escaped quotes inside strings', () => {
    const json = '{"key": "val\\"ue", "key2": "test"}';
    expect(findDuplicateKeys(json)).toEqual([]);
  });

  test('handles escaped backslash before closing quote', () => {
    const json = '{"key": "val\\\\", "key2": "test"}';
    expect(findDuplicateKeys(json)).toEqual([]);
  });

  test('handles arrays of objects with independent scopes', () => {
    const json = '{"arr": [{"id": 1}, {"id": 2}]}';
    expect(findDuplicateKeys(json)).toEqual([]);
  });

  test('detects duplicate inside object within array', () => {
    const json = '{"arr": [{"id": 1, "id": 2}]}';
    expect(findDuplicateKeys(json)).toEqual(['id']);
  });

  test('handles package.json-like structure without false positives', () => {
    const json = JSON.stringify({
      name: 'test',
      scripts: { build: 'cmd', test: 'cmd' },
      devDependencies: { jest: '1.0', eslint: '2.0' },
      jest: { testMatch: ['**/*.test.js'] },
      engines: { node: '>=18' }
    }, null, 2);
    expect(findDuplicateKeys(json)).toEqual([]);
  });

  test('handles deeply nested duplicate keys', () => {
    const json = '{"a": {"b": {"c": 1, "c": 2}}}';
    expect(findDuplicateKeys(json)).toEqual(['c']);
  });

  test('handles empty object', () => {
    expect(findDuplicateKeys('{}')).toEqual([]);
  });

  test('handles multiline JSON', () => {
    const json = `{
  "a": 1,
  "b": 2,
  "a": 3
}`;
    expect(findDuplicateKeys(json)).toEqual(['a']);
  });

  test('handles string values containing colons (not confused as keys)', () => {
    const json = '{"url": "http://example.com:8080", "port": 8080}';
    expect(findDuplicateKeys(json)).toEqual([]);
  });
});
