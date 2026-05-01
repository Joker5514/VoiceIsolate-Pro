/**
 * VoiceIsolate Pro — GET /api/client-config Unit Tests
 *
 * Verifies the response shape, default behaviour when env vars are unset,
 * and the Cache-Control header of the client-config endpoint.
 *
 * Because api/client-config.js is an ES module the handler is re-implemented
 * inline using the same logic, then exercised through a minimal Express app
 * — the same pattern used by the other API test files in this suite.
 */

'use strict';

const express = require('express');
const request = require('supertest');

// ── Minimal Express app that mirrors api/client-config.js ─────────────────────
function buildApp({ rcAndroid = '', rcIos = '' } = {}) {
  const app = express();

  app.get('/api/client-config', (req, res) => {
    if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method Not Allowed' });
    }
    res.set('Cache-Control', 'no-store');
    res.json({
      rcApiKeyAndroid: rcAndroid,
      rcApiKeyIos:     rcIos,
    });
  });

  return app;
}

// ── Tests ─────────────────────────────────────────────────────────────────────
describe('GET /api/client-config', () => {
  describe('when env vars are unset', () => {
    const app = buildApp();

    test('returns HTTP 200', async () => {
      const res = await request(app).get('/api/client-config');
      expect(res.status).toBe(200);
    });

    test('returns JSON content-type', async () => {
      const res = await request(app).get('/api/client-config');
      expect(res.headers['content-type']).toMatch(/application\/json/);
    });

    test('body has rcApiKeyAndroid and rcApiKeyIos fields', async () => {
      const res = await request(app).get('/api/client-config');
      expect(res.body).toHaveProperty('rcApiKeyAndroid');
      expect(res.body).toHaveProperty('rcApiKeyIos');
    });

    test('both keys default to empty strings when env vars are unset', async () => {
      const res = await request(app).get('/api/client-config');
      expect(res.body.rcApiKeyAndroid).toBe('');
      expect(res.body.rcApiKeyIos).toBe('');
    });

    test('response carries Cache-Control: no-store', async () => {
      const res = await request(app).get('/api/client-config');
      expect(res.headers['cache-control']).toBe('no-store');
    });

    test('body contains only the expected keys (no secret leakage)', async () => {
      const res = await request(app).get('/api/client-config');
      const keys = Object.keys(res.body);
      // Exactly these two keys — no extras (guards against accidental secret exposure)
      expect(keys).toHaveLength(2);
      expect(keys).toEqual(expect.arrayContaining(['rcApiKeyAndroid', 'rcApiKeyIos']));
    });
  });

  describe('when env vars are set', () => {
    const app = buildApp({ rcAndroid: 'rcb_android_test_key', rcIos: 'rcb_ios_test_key' });

    test('returns the android key', async () => {
      const res = await request(app).get('/api/client-config');
      expect(res.body.rcApiKeyAndroid).toBe('rcb_android_test_key');
    });

    test('returns the iOS key', async () => {
      const res = await request(app).get('/api/client-config');
      expect(res.body.rcApiKeyIos).toBe('rcb_ios_test_key');
    });

    test('still carries Cache-Control: no-store when keys are set', async () => {
      const res = await request(app).get('/api/client-config');
      expect(res.headers['cache-control']).toBe('no-store');
    });
  });

  describe('source-level checks', () => {
    const fs   = require('fs');
    const path = require('path');
    const src  = fs.readFileSync(
      path.join(__dirname, '../api/client-config.js'), 'utf8'
    );

    test('api/client-config.js sets Cache-Control: no-store', () => {
      expect(src).toContain('no-store');
    });

    test('api/client-config.js reads RC_API_KEY_ANDROID from process.env', () => {
      expect(src).toContain('RC_API_KEY_ANDROID');
    });

    test('api/client-config.js reads RC_API_KEY_IOS from process.env', () => {
      expect(src).toContain('RC_API_KEY_IOS');
    });

    test('api/index.js mounts the /client-config route', () => {
      const indexSrc = fs.readFileSync(
        path.join(__dirname, '../api/index.js'), 'utf8'
      );
      expect(indexSrc).toContain("router.get('/client-config', clientConfigHandler)");
    });

    test('api/index.js imports clientConfigHandler', () => {
      const indexSrc = fs.readFileSync(
        path.join(__dirname, '../api/index.js'), 'utf8'
      );
      expect(indexSrc).toContain("import clientConfigHandler from './client-config.js'");
    });
  });
});
