/**
 * Tests for deployment configuration changes (CSP hardening PR)
 * Covers: render.yaml, vercel.json, .jules/sentinel.md
 *
 * Key changes verified:
 *  - 'wasm-unsafe-eval' has been removed from the Content-Security-Policy
 *    script-src directive in both render.yaml and vercel.json.
 *  - https://cdnjs.cloudflare.com has been added to vercel.json script-src.
 *  - The CSP hardening entry has been removed from .jules/sentinel.md.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// ─── Helpers ────────────────────────────────────────────────────────────────

function readFile(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

function fileExists(relPath) {
  return fs.existsSync(path.join(ROOT, relPath));
}

// ─── vercel.json ─────────────────────────────────────────────────────────────

describe('vercel.json — structure and Content-Security-Policy', () => {
  let cfg;
  let cspHeader;

  beforeAll(() => {
    cfg = JSON.parse(readFile('vercel.json'));
    // Find the CSP header entry under the catch-all source route
    const catchAll = cfg.headers.find(h => h.source === '/(.*)');
    expect(catchAll).toBeDefined();
    cspHeader = catchAll.headers.find(h => h.key === 'Content-Security-Policy');
  });

  test('file exists', () => {
    expect(fileExists('vercel.json')).toBe(true);
  });

  test('file parses as valid JSON', () => {
    expect(() => JSON.parse(readFile('vercel.json'))).not.toThrow();
  });

  test('top-level headers array is present', () => {
    expect(Array.isArray(cfg.headers)).toBe(true);
    expect(cfg.headers.length).toBeGreaterThan(0);
  });

  test('Content-Security-Policy header is defined', () => {
    expect(cspHeader).toBeDefined();
    expect(typeof cspHeader.value).toBe('string');
    expect(cspHeader.value.length).toBeGreaterThan(0);
  });

  // ── Core change: wasm-unsafe-eval must be absent ─────────────────────────

  test("CSP does NOT contain 'wasm-unsafe-eval' (removed in this PR)", () => {
    expect(cspHeader.value).not.toContain('wasm-unsafe-eval');
  });

  // ── Core change: cdnjs.cloudflare.com must be present ───────────────────

  test("CSP script-src includes https://cdnjs.cloudflare.com (added in this PR)", () => {
    expect(cspHeader.value).toContain('https://cdnjs.cloudflare.com');
  });

  // ── Existing directives that must still be present ───────────────────────

  test("CSP contains default-src 'self'", () => {
    expect(cspHeader.value).toContain("default-src 'self'");
  });

  test("CSP script-src contains 'self'", () => {
    expect(cspHeader.value).toMatch(/script-src[^;]*'self'/);
  });

  test("CSP script-src contains 'unsafe-inline'", () => {
    expect(cspHeader.value).toMatch(/script-src[^;]*'unsafe-inline'/);
  });

  test('CSP script-src contains https://cdn.jsdelivr.net', () => {
    expect(cspHeader.value).toMatch(/script-src[^;]*https:\/\/cdn\.jsdelivr\.net/);
  });

  test('CSP script-src contains /_vercel', () => {
    expect(cspHeader.value).toMatch(/script-src[^;]*\/_vercel/);
  });

  test("CSP style-src contains 'unsafe-inline'", () => {
    expect(cspHeader.value).toMatch(/style-src[^;]*'unsafe-inline'/);
  });

  test('CSP style-src contains https://fonts.googleapis.com', () => {
    expect(cspHeader.value).toContain('https://fonts.googleapis.com');
  });

  test('CSP font-src contains https://fonts.gstatic.com', () => {
    expect(cspHeader.value).toContain('https://fonts.gstatic.com');
  });

  test("CSP img-src allows data: URIs", () => {
    expect(cspHeader.value).toMatch(/img-src[^;]*data:/);
  });

  test("CSP img-src allows blob: URIs", () => {
    expect(cspHeader.value).toMatch(/img-src[^;]*blob:/);
  });

  test("CSP media-src allows blob: URIs", () => {
    expect(cspHeader.value).toMatch(/media-src[^;]*blob:/);
  });

  test("CSP worker-src allows blob: URIs (required for Web Workers)", () => {
    expect(cspHeader.value).toMatch(/worker-src[^;]*blob:/);
  });

  // ── Other security headers ───────────────────────────────────────────────

  test('Cross-Origin-Opener-Policy is same-origin', () => {
    const catchAll = cfg.headers.find(h => h.source === '/(.*)');
    const coop = catchAll.headers.find(h => h.key === 'Cross-Origin-Opener-Policy');
    expect(coop).toBeDefined();
    expect(coop.value).toBe('same-origin');
  });

  test('Cross-Origin-Embedder-Policy is require-corp', () => {
    const catchAll = cfg.headers.find(h => h.source === '/(.*)');
    const coep = catchAll.headers.find(h => h.key === 'Cross-Origin-Embedder-Policy');
    expect(coep).toBeDefined();
    expect(coep.value).toBe('require-corp');
  });

  test('X-Frame-Options is DENY', () => {
    const catchAll = cfg.headers.find(h => h.source === '/(.*)');
    const xfo = catchAll.headers.find(h => h.key === 'X-Frame-Options');
    expect(xfo).toBeDefined();
    expect(xfo.value).toBe('DENY');
  });

  // ── Negative / regression ────────────────────────────────────────────────

  test("CSP does NOT contain 'unsafe-eval' in any form", () => {
    // Ensures neither wasm-unsafe-eval nor unsafe-eval slipped back in
    expect(cspHeader.value).not.toMatch(/'unsafe-eval'/);
  });
});

// ─── render.yaml ─────────────────────────────────────────────────────────────

describe('render.yaml — Content-Security-Policy header', () => {
  let content;
  let cspLine;

  beforeAll(() => {
    content = readFile('render.yaml');
    // Extract the CSP value line from the YAML
    const lines = content.split('\n');
    // Find the line that contains Content-Security-Policy value (the value: line after the CSP name)
    const cspNameIdx = lines.findIndex(l => l.includes('Content-Security-Policy'));
    // The value line immediately follows the name: line
    cspLine = lines.slice(cspNameIdx + 1).find(l => l.trim().startsWith('value:')) || '';
  });

  test('file exists', () => {
    expect(fileExists('render.yaml')).toBe(true);
  });

  test('file is non-empty', () => {
    expect(content.length).toBeGreaterThan(0);
  });

  test('Content-Security-Policy header is declared', () => {
    expect(content).toContain('Content-Security-Policy');
  });

  // ── Core change: wasm-unsafe-eval must be absent ─────────────────────────

  test("CSP does NOT contain 'wasm-unsafe-eval' (removed in this PR)", () => {
    expect(content).not.toContain('wasm-unsafe-eval');
  });

  // ── Expected CDN sources must be present ────────────────────────────────

  test('CSP includes https://cdnjs.cloudflare.com in script-src', () => {
    expect(cspLine).toContain('https://cdnjs.cloudflare.com');
  });

  test('CSP includes https://cdn.jsdelivr.net in script-src', () => {
    expect(cspLine).toContain('https://cdn.jsdelivr.net');
  });

  // ── Core directives must still be present ───────────────────────────────

  test("CSP contains default-src 'self'", () => {
    expect(cspLine).toContain("default-src 'self'");
  });

  test("CSP script-src contains 'self'", () => {
    expect(cspLine).toMatch(/script-src[^;]*'self'/);
  });

  test("CSP script-src contains 'unsafe-inline'", () => {
    expect(cspLine).toMatch(/script-src[^;]*'unsafe-inline'/);
  });

  test("CSP style-src allows 'unsafe-inline'", () => {
    expect(cspLine).toMatch(/style-src[^;]*'unsafe-inline'/);
  });

  test('CSP style-src allows https://fonts.googleapis.com', () => {
    expect(cspLine).toContain('https://fonts.googleapis.com');
  });

  test('CSP font-src allows https://fonts.gstatic.com', () => {
    expect(cspLine).toContain('https://fonts.gstatic.com');
  });

  test("CSP img-src allows data: URIs", () => {
    expect(cspLine).toMatch(/img-src[^;]*data:/);
  });

  test("CSP img-src allows blob: URIs", () => {
    expect(cspLine).toMatch(/img-src[^;]*blob:/);
  });

  test("CSP worker-src allows blob: URIs (required for Web Workers)", () => {
    expect(cspLine).toMatch(/worker-src[^;]*blob:/);
  });

  // ── Other security headers ───────────────────────────────────────────────

  test('Cross-Origin-Opener-Policy header is declared as same-origin', () => {
    expect(content).toContain('Cross-Origin-Opener-Policy');
    expect(content).toContain('same-origin');
  });

  test('Cross-Origin-Embedder-Policy header is declared as require-corp', () => {
    expect(content).toContain('Cross-Origin-Embedder-Policy');
    expect(content).toContain('require-corp');
  });

  test('X-Frame-Options is set to DENY', () => {
    expect(content).toContain('X-Frame-Options');
    expect(content).toContain('DENY');
  });

  // ── Negative / regression ────────────────────────────────────────────────

  test("CSP does NOT contain 'unsafe-eval' in any form", () => {
    expect(content).not.toMatch(/'unsafe-eval'/);
  });

  test('render.yaml service type is web (static site)', () => {
    expect(content).toContain('type: web');
  });
});

// ─── Cross-config consistency ────────────────────────────────────────────────

describe('Cross-config consistency — vercel.json and render.yaml CSP alignment', () => {
  let vercelCsp;
  let renderContent;

  beforeAll(() => {
    const vercelCfg = JSON.parse(readFile('vercel.json'));
    const catchAll = vercelCfg.headers.find(h => h.source === '/(.*)');
    vercelCsp = catchAll.headers.find(h => h.key === 'Content-Security-Policy').value;
    renderContent = readFile('render.yaml');
  });

  test("neither config contains 'wasm-unsafe-eval'", () => {
    expect(vercelCsp).not.toContain('wasm-unsafe-eval');
    expect(renderContent).not.toContain('wasm-unsafe-eval');
  });

  test("neither config contains bare 'unsafe-eval'", () => {
    expect(vercelCsp).not.toMatch(/'unsafe-eval'/);
    expect(renderContent).not.toMatch(/'unsafe-eval'/);
  });

  test('both configs declare https://cdnjs.cloudflare.com as an allowed script source', () => {
    expect(vercelCsp).toContain('https://cdnjs.cloudflare.com');
    expect(renderContent).toContain('https://cdnjs.cloudflare.com');
  });

  test('both configs declare https://cdn.jsdelivr.net as an allowed script source', () => {
    expect(vercelCsp).toContain('https://cdn.jsdelivr.net');
    expect(renderContent).toContain('https://cdn.jsdelivr.net');
  });

  test("both configs retain 'unsafe-inline' for script-src", () => {
    expect(vercelCsp).toContain("'unsafe-inline'");
    expect(renderContent).toContain("'unsafe-inline'");
  });

  test('both configs use same-origin for Cross-Origin-Opener-Policy', () => {
    const vercelCfg = JSON.parse(readFile('vercel.json'));
    const catchAll = vercelCfg.headers.find(h => h.source === '/(.*)');
    const coopVal = catchAll.headers.find(h => h.key === 'Cross-Origin-Opener-Policy').value;
    expect(coopVal).toBe('same-origin');
    expect(renderContent).toContain('same-origin');
  });
});

// ─── .jules/sentinel.md ──────────────────────────────────────────────────────

describe('.jules/sentinel.md — CSP hardening log entry removed', () => {
  let content;

  beforeAll(() => {
    content = readFile('.jules/sentinel.md');
  });

  test('file exists', () => {
    expect(fileExists('.jules/sentinel.md')).toBe(true);
  });

  test('file is non-empty (pre-existing entries remain)', () => {
    expect(content.trim().length).toBeGreaterThan(0);
  });

  // ── Core change: the 2026-03-29 CSP hardening entry was removed ─────────

  test('does NOT contain the removed 2026-03-29 CSP hardening entry heading', () => {
    expect(content).not.toContain('2026-03-29 - Harden CSP by removing unsafe-eval');
  });

  test('does NOT contain the removed entry text about unsafe-eval XSS risk', () => {
    expect(content).not.toContain(
      "CSP headers should be as restrictive as possible. Even if core production code doesn't explicitly use `eval()`"
    );
  });

  test('does NOT contain the removed entry prevention advice about unsafe-eval', () => {
    expect(content).not.toContain(
      "Periodically audit CSP configurations and remove permissive directives like `'unsafe-eval'` and `'unsafe-inline'`"
    );
  });

  // ── Pre-existing entries must still be present (regression guard) ────────

  test('still contains the 2026-03-10 innerHTML vulnerability entry', () => {
    expect(content).toContain('2026-03-10 - Eliminate innerHTML usage for DOM construction');
  });

  test('still contains the 2024-05-24 PRNG dither entry', () => {
    expect(content).toContain('2024-05-24 - Secure PRNG for Dither');
  });

  test('still contains the crypto.getRandomValues() guidance', () => {
    expect(content).toContain('crypto.getRandomValues()');
  });

  // ── Boundary / negative ──────────────────────────────────────────────────

  test('file has exactly two top-level entries (## headings)', () => {
    const headings = content.match(/^## /gm) || [];
    expect(headings.length).toBe(2);
  });
});