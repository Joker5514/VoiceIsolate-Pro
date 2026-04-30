process.env.LICENSE_JWT_SECRET = 'test-secret';
const request = require('supertest');
const path = require('path');

describe('Server.js Integration Tests', () => {
  let app;

  beforeAll(async () => {
    const serverModule = await import('../server.js');
    app = serverModule.app;
  });

  describe('Cross-Origin Isolation Headers', () => {
    test('should return correct cross-origin headers for root path', async () => {
      const res = await request(app).get('/');
      expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
      expect(res.headers['cross-origin-embedder-policy']).toBe('require-corp');
      expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
    });

    test('should return correct cross-origin headers for health endpoint', async () => {
      const res = await request(app).get('/health');
      expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
      expect(res.headers['cross-origin-embedder-policy']).toBe('require-corp');
      expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
    });
  });

  describe('Security Hardening Headers', () => {
    test('should return proper security headers', async () => {
      const res = await request(app).get('/');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
      expect(res.headers['permissions-policy']).toBe('microphone=(self), camera=(), geolocation=()');
    });

    test('should return proper Content-Security-Policy', async () => {
      const res = await request(app).get('/');
      const csp = res.headers['content-security-policy'];
      expect(csp).toBeDefined();
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain("style-src 'self'");
      expect(csp).toContain("font-src 'self'");
      expect(csp).toContain("img-src 'self' data: blob:");
      expect(csp).toContain("media-src 'self' blob: mediastream:");
      expect(csp).toContain("connect-src 'self'");
      expect(csp).toContain("worker-src 'self' blob:");
      expect(csp).toContain("wasm-src 'self'");
    });
  });

  describe('API Endpoints', () => {
    test('GET /health returns minimal health status (no version/feature disclosure)', async () => {
      const res = await request(app).get('/health');
      expect(res.statusCode).toBe(200);
      expect(res.body).toHaveProperty('status', 'ok');
      // Version and feature details must not be exposed on the public health endpoint
      expect(res.body).not.toHaveProperty('version');
      expect(res.body).not.toHaveProperty('app');
      expect(res.body).not.toHaveProperty('features');
    });
  });

  describe('Static Assets', () => {
    test('should serve index.html for root', async () => {
      const res = await request(app).get('/');
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
    });

    test('should serve static files with correct COOP/COEP headers', async () => {
      const res = await request(app).get('/app/app.js');
      expect(res.statusCode).not.toBe(404);
      if (res.statusCode === 200) {
        expect(res.headers['content-type']).toContain('application/javascript');
        expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
      }
    });
  });
});
