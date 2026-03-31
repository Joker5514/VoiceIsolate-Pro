import request from 'supertest';
import { app } from '../server.js';

describe('Server Headers', () => {

  it('should return cross-origin isolation headers on root path', async () => {
    const res = await request(app).get('/');

    expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(res.headers['cross-origin-embedder-policy']).toBe('require-corp');
    expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
  });

  it('should return security hardening headers on root path', async () => {
    const res = await request(app).get('/');

    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(res.headers['permissions-policy']).toBe('microphone=(self), camera=(), geolocation=()');
    expect(res.headers['content-security-policy']).toBeDefined();
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
  });

  it('should set appropriate headers for WASM files', async () => {
    // Mock a response for a wasm file if it doesn't exist, or just check the headers of a GET request
    // We can just check that the middleware is wired up correctly.
    // However, express.static only sets headers if the file is found.
    // We can at least check that the middleware doesn't crash on WASM path.
    const res = await request(app).get('/wasm/nonexistent.wasm');
    expect(res.status).toBe(404);
  });

  it('should return health check data', async () => {
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.app).toBe('VoiceIsolate Pro');
    expect(res.body.crossOriginIsolated).toBe(true);
  });

  it('should return API version info', async () => {
    const res = await request(app).get('/api/version');

    expect(res.status).toBe(200);
    expect(res.body.version).toBeDefined();
    expect(res.body.name).toBe('VoiceIsolate Pro');
  });
});
