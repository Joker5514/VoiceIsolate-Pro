/**
 * Tests for deployment configuration changes introduced in this PR:
 *   - vercel.json: removed 'wasm-unsafe-eval', added cdnjs.cloudflare.com to script-src
 *   - render.yaml: removed 'wasm-unsafe-eval' from script-src
 *   - .jules/sentinel.md: removed the "Harden CSP by removing unsafe-eval" entry
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// ─── Helpers ────────────────────────────────────────────────────────────────

function readFile(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

function fileExists(relPath) {
  return fs.existsSync(path.join(ROOT, relPath));
}

/**
 * Parse a CSP header string into a map of directive → array of source tokens.
 * e.g. "default-src 'self'; script-src 'self' https://example.com"
 *   → { 'default-src': ["'self'"], 'script-src': ["'self'", "https://example.com"] }
 */
function parseCSP(cspString) {
  const directives = {};
  const parts = cspString.split(/;\s*/);
  for (const part of parts) {
    const tokens = part.trim().split(/\s+/);
    if (tokens.length === 0 || !tokens[0]) continue;
    const name = tokens[0].toLowerCase();
    directives[name] = tokens.slice(1);
  }
  return directives;
}

// ─── vercel.json ─────────────────────────────────────────────────────────────

describe('vercel.json — file integrity', () => {
  test('file exists', () => {
    expect(fileExists('vercel.json')).toBe(true);
  });

  test('is valid JSON', () => {
    expect(() => JSON.parse(readFile('vercel.json'))).not.toThrow();
  });

  test('contains a headers array', () => {
    const cfg = JSON.parse(readFile('vercel.json'));
    expect(Array.isArray(cfg.headers)).toBe(true);
    expect(cfg.headers.length).toBeGreaterThan(0);
  });
});

describe('vercel.json — Content-Security-Policy header', () => {
  let cspValue;
  let directives;

  beforeAll(() => {
    const cfg = JSON.parse(readFile('vercel.json'));
    const globalHeaders = cfg.headers.find(h => h.source === '/(.*)');
    expect(globalHeaders).toBeDefined();
    const cspEntry = globalHeaders.headers.find(h => h.key === 'Content-Security-Policy');
    expect(cspEntry).toBeDefined();
    cspValue = cspEntry.value;
    directives = parseCSP(cspValue);
  });

  // ── Core change: wasm-unsafe-eval must be absent ──────────────────────────

  test("script-src does NOT contain 'wasm-unsafe-eval' (removed in this PR)", () => {
    expect(cspValue).not.toContain('wasm-unsafe-eval');
  });

  test("CSP string contains no eval-related directives other than 'unsafe-inline'", () => {
    // 'unsafe-eval' and 'wasm-unsafe-eval' are both absent
    expect(cspValue).not.toContain("'unsafe-eval'");
    expect(cspValue).not.toContain('wasm-unsafe-eval');
  });

  // ── Core change: cdnjs.cloudflare.com added to script-src ────────────────

  test('script-src includes https://cdnjs.cloudflare.com (added in this PR)', () => {
    expect(directives['script-src']).toContain('https://cdnjs.cloudflare.com');
  });

  // ── All required script-src sources are present ───────────────────────────

  test("script-src includes 'self'", () => {
    expect(directives['script-src']).toContain("'self'");
  });

  test("script-src includes 'unsafe-inline'", () => {
    expect(directives['script-src']).toContain("'unsafe-inline'");
  });

  test('script-src includes https://cdn.jsdelivr.net', () => {
    expect(directives['script-src']).toContain('https://cdn.jsdelivr.net');
  });

  test('script-src includes /_vercel (Vercel runtime scripts)', () => {
    const scriptSrc = directives['script-src'].join(' ');
    expect(scriptSrc).toContain('/_vercel');
  });

  // ── Required CSP directives ───────────────────────────────────────────────

  test('CSP contains default-src directive', () => {
    expect(directives).toHaveProperty('default-src');
  });

  test("default-src is 'self'", () => {
    expect(directives['default-src']).toContain("'self'");
  });

  test('CSP contains script-src directive', () => {
    expect(directives).toHaveProperty('script-src');
  });

  test('CSP contains style-src directive', () => {
    expect(directives).toHaveProperty('style-src');
  });

  test('CSP contains font-src directive', () => {
    expect(directives).toHaveProperty('font-src');
  });

  test('CSP contains img-src directive', () => {
    expect(directives).toHaveProperty('img-src');
  });

  test('CSP contains media-src directive', () => {
    expect(directives).toHaveProperty('media-src');
  });

  test('CSP contains connect-src directive', () => {
    expect(directives).toHaveProperty('connect-src');
  });

  test('CSP contains worker-src directive', () => {
    expect(directives).toHaveProperty('worker-src');
  });

  // ── Directive source values ───────────────────────────────────────────────

  test("style-src includes 'unsafe-inline' and fonts.googleapis.com", () => {
    expect(directives['style-src']).toContain("'unsafe-inline'");
    expect(directives['style-src']).toContain('https://fonts.googleapis.com');
  });

  test('font-src includes fonts.gstatic.com', () => {
    expect(directives['font-src']).toContain('https://fonts.gstatic.com');
  });

  test('img-src allows data: and blob: for canvas/thumbnail use', () => {
    expect(directives['img-src']).toContain('data:');
    expect(directives['img-src']).toContain('blob:');
  });

  test('media-src allows blob: for audio/video playback', () => {
    expect(directives['media-src']).toContain('blob:');
  });

  test('worker-src allows blob: for Web Workers and AudioWorklets', () => {
    expect(directives['worker-src']).toContain('blob:');
  });

  // ── Boundary / negative cases ─────────────────────────────────────────────

  test("script-src does not allow wildcard '*'", () => {
    expect(directives['script-src']).not.toContain('*');
  });

  test("default-src does not allow wildcard '*'", () => {
    expect(directives['default-src']).not.toContain('*');
  });
});

describe('vercel.json — other security headers still present', () => {
  let globalHeaders;

  beforeAll(() => {
    const cfg = JSON.parse(readFile('vercel.json'));
    const section = cfg.headers.find(h => h.source === '/(.*)');
    expect(section).toBeDefined();
    globalHeaders = section.headers;
  });

  function headerValue(key) {
    const entry = globalHeaders.find(h => h.key === key);
    return entry ? entry.value : undefined;
  }

  test('Cross-Origin-Opener-Policy is same-origin', () => {
    expect(headerValue('Cross-Origin-Opener-Policy')).toBe('same-origin');
  });

  test('Cross-Origin-Embedder-Policy is require-corp', () => {
    expect(headerValue('Cross-Origin-Embedder-Policy')).toBe('require-corp');
  });

  test('Cross-Origin-Resource-Policy is same-origin', () => {
    expect(headerValue('Cross-Origin-Resource-Policy')).toBe('same-origin');
  });

  test('X-Content-Type-Options is nosniff', () => {
    expect(headerValue('X-Content-Type-Options')).toBe('nosniff');
  });

  test('X-Frame-Options is DENY', () => {
    expect(headerValue('X-Frame-Options')).toBe('DENY');
  });

  test('Referrer-Policy is strict-origin-when-cross-origin', () => {
    expect(headerValue('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
  });
});

// ─── render.yaml ─────────────────────────────────────────────────────────────

describe('render.yaml — file integrity', () => {
  test('file exists', () => {
    expect(fileExists('render.yaml')).toBe(true);
  });

  test('file is non-empty', () => {
    expect(readFile('render.yaml').trim().length).toBeGreaterThan(0);
  });

  test('declares a services block', () => {
    expect(readFile('render.yaml')).toContain('services:');
  });
});

describe('render.yaml — Content-Security-Policy header', () => {
  let cspValue;
  let directives;

  beforeAll(() => {
    const yaml = readFile('render.yaml');
    // Extract the CSP value: the line that sets the Content-Security-Policy header value
    const cspLineMatch = yaml.match(/name:\s*Content-Security-Policy[\s\S]*?value:\s*"([^"]+)"/);
    expect(cspLineMatch).not.toBeNull();
    cspValue = cspLineMatch[1];
    directives = parseCSP(cspValue);
  });

  // ── Core change: wasm-unsafe-eval must be absent ──────────────────────────

  test("script-src does NOT contain 'wasm-unsafe-eval' (removed in this PR)", () => {
    expect(cspValue).not.toContain('wasm-unsafe-eval');
  });

  test("CSP contains no 'unsafe-eval' variant directives", () => {
    expect(cspValue).not.toContain("'unsafe-eval'");
    expect(cspValue).not.toContain('wasm-unsafe-eval');
  });

  // ── Required script-src sources ───────────────────────────────────────────

  test("script-src includes 'self'", () => {
    expect(directives['script-src']).toContain("'self'");
  });

  test("script-src includes 'unsafe-inline'", () => {
    expect(directives['script-src']).toContain("'unsafe-inline'");
  });

  test('script-src includes https://cdnjs.cloudflare.com', () => {
    expect(directives['script-src']).toContain('https://cdnjs.cloudflare.com');
  });

  test('script-src includes https://cdn.jsdelivr.net', () => {
    expect(directives['script-src']).toContain('https://cdn.jsdelivr.net');
  });

  test('script-src includes /_vercel/ path (Render CDN scripts)', () => {
    const scriptSrc = directives['script-src'].join(' ');
    expect(scriptSrc).toContain('/_vercel/');
  });

  // ── Required CSP directives ───────────────────────────────────────────────

  test('CSP contains default-src directive', () => {
    expect(directives).toHaveProperty('default-src');
  });

  test("default-src is 'self'", () => {
    expect(directives['default-src']).toContain("'self'");
  });

  test('CSP contains style-src directive', () => {
    expect(directives).toHaveProperty('style-src');
  });

  test('CSP contains font-src directive', () => {
    expect(directives).toHaveProperty('font-src');
  });

  test('CSP contains img-src directive', () => {
    expect(directives).toHaveProperty('img-src');
  });

  test('CSP contains media-src directive', () => {
    expect(directives).toHaveProperty('media-src');
  });

  test('CSP contains connect-src directive', () => {
    expect(directives).toHaveProperty('connect-src');
  });

  test('CSP contains worker-src directive', () => {
    expect(directives).toHaveProperty('worker-src');
  });

  // ── Directive source values ───────────────────────────────────────────────

  test("style-src includes 'unsafe-inline' and fonts.googleapis.com", () => {
    expect(directives['style-src']).toContain("'unsafe-inline'");
    expect(directives['style-src']).toContain('https://fonts.googleapis.com');
  });

  test('font-src includes fonts.gstatic.com', () => {
    expect(directives['font-src']).toContain('https://fonts.gstatic.com');
  });

  test('img-src allows data: and blob:', () => {
    expect(directives['img-src']).toContain('data:');
    expect(directives['img-src']).toContain('blob:');
  });

  test('media-src allows blob: for audio/video playback', () => {
    expect(directives['media-src']).toContain('blob:');
  });

  test('worker-src allows blob: for Web Workers and AudioWorklets', () => {
    expect(directives['worker-src']).toContain('blob:');
  });

  // ── Boundary / negative cases ─────────────────────────────────────────────

  test("script-src does not allow wildcard '*'", () => {
    expect(directives['script-src']).not.toContain('*');
  });
});

describe('render.yaml — other security headers still present', () => {
  let yaml;

  beforeAll(() => {
    yaml = readFile('render.yaml');
  });

  test('Cross-Origin-Opener-Policy header is declared', () => {
    expect(yaml).toContain('Cross-Origin-Opener-Policy');
    expect(yaml).toContain('same-origin');
  });

  test('Cross-Origin-Embedder-Policy header is declared', () => {
    expect(yaml).toContain('Cross-Origin-Embedder-Policy');
    expect(yaml).toContain('require-corp');
  });

  test('X-Frame-Options DENY is declared', () => {
    expect(yaml).toContain('X-Frame-Options');
    expect(yaml).toContain('DENY');
  });

  test('X-Content-Type-Options nosniff is declared', () => {
    expect(yaml).toContain('X-Content-Type-Options');
    expect(yaml).toContain('nosniff');
  });

  test('Referrer-Policy is declared', () => {
    expect(yaml).toContain('Referrer-Policy');
    expect(yaml).toContain('strict-origin-when-cross-origin');
  });
});

// ─── .jules/sentinel.md ──────────────────────────────────────────────────────

describe('.jules/sentinel.md — CSP documentation update', () => {
  let sentinel;

  beforeAll(() => {
    sentinel = readFile('.jules/sentinel.md');
  });

  test('file exists', () => {
    expect(fileExists('.jules/sentinel.md')).toBe(true);
  });

  test('removed section "2026-03-29 - Harden CSP by removing unsafe-eval" is absent', () => {
    expect(sentinel).not.toContain('2026-03-29 - Harden CSP by removing unsafe-eval');
  });

  test('file does not reference the removed wasm-unsafe-eval directive', () => {
    // The entry that documented removing wasm-unsafe-eval has been removed from the file
    expect(sentinel).not.toContain('wasm-unsafe-eval');
  });

  test('pre-existing innerHTML XSS entry is still present', () => {
    expect(sentinel).toContain('2026-03-10 - Eliminate innerHTML usage for DOM construction');
  });

  test('pre-existing Secure PRNG entry is still present', () => {
    expect(sentinel).toContain('2024-05-24 - Secure PRNG for Dither');
  });

  test('pre-existing crypto.getRandomValues guidance is retained', () => {
    expect(sentinel).toContain('crypto.getRandomValues()');
  });

  test('file contains exactly two top-level section entries', () => {
    const sections = (sentinel.match(/^##\s+/gm) || []);
    expect(sections).toHaveLength(2);
  });

  // Regression: the removed entry should not be re-introduced
  test("REGRESSION: 'unsafe-eval' removal guidance is not documented in sentinel (it was removed intentionally)", () => {
    expect(sentinel).not.toContain("Harden CSP");
  });
});

// ─── Cross-platform CSP consistency ──────────────────────────────────────────

describe('Cross-platform CSP consistency — vercel.json vs render.yaml', () => {
  let vercelCSP;
  let renderCSP;
  let vercelDirectives;
  let renderDirectives;

  beforeAll(() => {
    const vercelCfg = JSON.parse(readFile('vercel.json'));
    const globalHeaders = vercelCfg.headers.find(h => h.source === '/(.*)');
    const vercelEntry = globalHeaders.headers.find(h => h.key === 'Content-Security-Policy');
    vercelCSP = vercelEntry.value;
    vercelDirectives = parseCSP(vercelCSP);

    const yaml = readFile('render.yaml');
    const cspLineMatch = yaml.match(/name:\s*Content-Security-Policy[\s\S]*?value:\s*"([^"]+)"/);
    renderCSP = cspLineMatch[1];
    renderDirectives = parseCSP(renderCSP);
  });

  test('neither platform CSP contains wasm-unsafe-eval', () => {
    expect(vercelCSP).not.toContain('wasm-unsafe-eval');
    expect(renderCSP).not.toContain('wasm-unsafe-eval');
  });

  test('both platforms include cdnjs.cloudflare.com in script-src', () => {
    expect(vercelDirectives['script-src']).toContain('https://cdnjs.cloudflare.com');
    expect(renderDirectives['script-src']).toContain('https://cdnjs.cloudflare.com');
  });

  test('both platforms include cdn.jsdelivr.net in script-src', () => {
    expect(vercelDirectives['script-src']).toContain('https://cdn.jsdelivr.net');
    expect(renderDirectives['script-src']).toContain('https://cdn.jsdelivr.net');
  });

  test("both platforms keep 'unsafe-inline' in script-src", () => {
    expect(vercelDirectives['script-src']).toContain("'unsafe-inline'");
    expect(renderDirectives['script-src']).toContain("'unsafe-inline'");
  });

  test("both platforms set default-src to 'self'", () => {
    expect(vercelDirectives['default-src']).toContain("'self'");
    expect(renderDirectives['default-src']).toContain("'self'");
  });

  test('both platforms define the same set of CSP directives', () => {
    const vercelKeys = Object.keys(vercelDirectives).sort();
    const renderKeys = Object.keys(renderDirectives).sort();
    expect(vercelKeys).toEqual(renderKeys);
  });

  test('both platforms allow blob: in worker-src', () => {
    expect(vercelDirectives['worker-src']).toContain('blob:');
    expect(renderDirectives['worker-src']).toContain('blob:');
  });

  test('both platforms allow blob: in media-src', () => {
    expect(vercelDirectives['media-src']).toContain('blob:');
    expect(renderDirectives['media-src']).toContain('blob:');
  });
});