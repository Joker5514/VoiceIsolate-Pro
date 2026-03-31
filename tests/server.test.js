/**
 * Tests for Server Cross-Origin Headers
 */
'use strict';

// Because server.js is an ES module and tests run in CommonJS mode,
// dynamic import() can be used. Jest allows importing ESM inside CJS
// tests when run with --experimental-vm-modules (which is configured in package.json).

let app;

describe('Server Cross-Origin Isolation Headers', () => {
  beforeAll(async () => {
    // dynamically import the ES module server.js
    const serverModule = await import('../server.js');
    app = serverModule.app;
  });

  test('should return correct headers for cross-origin isolation and security', async () => {
    // We need supertest. But it's CJS so we can require it here.
    const request = require('supertest');

    // Request a generic route, like /health
    const response = await request(app).get('/health');

    // Assert status
    expect(response.status).toBe(200);

    // Assert headers
    expect(response.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(response.headers['cross-origin-embedder-policy']).toBe('require-corp');
    expect(response.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
  });
});
