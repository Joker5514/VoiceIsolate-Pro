const { spawn } = require('child_process');
const request = require('supertest');
const path = require('path');

describe('Server.js Integration Tests', () => {
  let serverProcess;
  // Use a port that is unlikely to be in use for testing
  const PORT = 3005;
  const baseUrl = `http://localhost:${PORT}`;

  beforeAll((done) => {
    // Start the server with a specific port
    serverProcess = spawn('node', ['server.js'], {
      env: { ...process.env, PORT: PORT },
      cwd: process.cwd()
    });

    let started = false;
    serverProcess.stdout.on('data', (data) => {
      const output = data.toString();
      if (!started && output.includes('Dev Server')) {
        started = true;
        done();
      }
    });

    serverProcess.stderr.on('data', (data) => {
      console.error(`Server error: ${data}`);
    });
  });

  afterAll((done) => {
    if (serverProcess) {
      serverProcess.kill();
    }
    done();
  });

  describe('Cross-Origin Isolation Headers', () => {
    test('should return correct cross-origin headers for root path', async () => {
      const res = await request(baseUrl).get('/');
      expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
      expect(res.headers['cross-origin-embedder-policy']).toBe('require-corp');
      expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
    });

    test('should return correct cross-origin headers for health endpoint', async () => {
      const res = await request(baseUrl).get('/health');
      expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
      expect(res.headers['cross-origin-embedder-policy']).toBe('require-corp');
      expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
    });
  });

  describe('Security Hardening Headers', () => {
    test('should return proper security headers', async () => {
      const res = await request(baseUrl).get('/');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
      expect(res.headers['permissions-policy']).toBe('microphone=(self), camera=(), geolocation=()');
    });

    test('should return proper Content-Security-Policy', async () => {
      const res = await request(baseUrl).get('/');
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
    test('GET /health returns health status', async () => {
      const res = await request(baseUrl).get('/health');
      expect(res.statusCode).toBe(200);
      expect(res.body).toHaveProperty('status', 'ok');
      expect(res.body).toHaveProperty('app', 'VoiceIsolate Pro');
      expect(res.body).toHaveProperty('version');
      expect(res.body).toHaveProperty('crossOriginIsolated', true);
      expect(res.body).toHaveProperty('sharedArrayBuffer', true);
      expect(res.body).toHaveProperty('features');
      expect(res.body).toHaveProperty('timestamp');
    });

    test('GET /api/version returns version info', async () => {
      const res = await request(baseUrl).get('/api/version');
      expect(res.statusCode).toBe(200);
      expect(res.body).toHaveProperty('name', 'VoiceIsolate Pro');
      expect(res.body).toHaveProperty('version');
    });
  });

  describe('Static Assets', () => {
    test('should serve index.html for root', async () => {
      const res = await request(baseUrl).get('/');
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
    });

    test('should serve static files with correct COOP/COEP headers', async () => {
      const res = await request(baseUrl).get('/app/app.js');
      expect(res.statusCode).not.toBe(404);
      if (res.statusCode === 200) {
        expect(res.headers['content-type']).toContain('application/javascript');
        expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
      }
    });
  });
});
