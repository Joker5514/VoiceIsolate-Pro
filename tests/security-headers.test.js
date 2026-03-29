'use strict';

/**
 * Tests for security header configuration changes introduced in this PR:
 *  - vercel.json:   removed 'wasm-unsafe-eval' from script-src; added cdnjs.cloudflare.com
 *  - render.yaml:   removed 'wasm-unsafe-eval' from script-src (duplicate line also removed)
 *  - .jules/sentinel.md: removed the 2026-03-29 "Harden CSP" entry
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function readFile(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

// ─── Helper: parse CSP directive map from a CSP string ───────────────────────

/**
 * Parses a Content-Security-Policy string into a map of
 * directive name -> array of source tokens.
 *
 * e.g. "default-src 'self'; script-src 'self' https://example.com"
 *  => { 'default-src': ["'self'"], 'script-src': ["'self'", "https://example.com"] }
 */
function parseCSP(cspString) {
  const directives = {};
  cspString.split(';').forEach(part => {
    const trimmed = part.trim();
    if (!trimmed) return;
    const tokens = trimmed.split(/\s+/);
    const name = tokens[0].toLowerCase();
    directives[name] = tokens.slice(1);
  });
  return directives;
}

// ─── vercel.json ─────────────────────────────────────────────────────────────

describe('vercel.json — Content-Security-Policy header', () => {
  let config;
  let cspHeader;
  let cspValue;
  let cspDirectives;

  beforeAll(() => {
    config = JSON.parse(readFile('vercel.json'));

    // Find the global catch-all route headers (source "/(.*)")
    const globalRoute = config.headers.find(h => h.source === '/(.*)');
    expect(globalRoute).toBeDefined();

    cspHeader = globalRoute.headers.find(h => h.key === 'Content-Security-Policy');
    expect(cspHeader).toBeDefined();

    cspValue = cspHeader.value;
    cspDirectives = parseCSP(cspValue);
  });

  test('vercel.json is valid JSON and can be parsed', () => {
    expect(() => JSON.parse(readFile('vercel.json'))).not.toThrow();
  });

  test('CSP header is present on the global route', () => {
    expect(cspHeader).toBeDefined();
    expect(cspValue).toBeTruthy();
  });

  // ── Core security regression: wasm-unsafe-eval removed ───────────────────

  test('script-src does NOT contain wasm-unsafe-eval (PR regression)', () => {
    expect(cspDirectives['script-src']).not.toContain("'wasm-unsafe-eval'");
  });

  test('CSP value string does not contain wasm-unsafe-eval anywhere', () => {
    expect(cspValue).not.toContain('wasm-unsafe-eval');
  });

  // ── New allowlist entry added ─────────────────────────────────────────────

  test('script-src includes https://cdnjs.cloudflare.com (added in PR)', () => {
    expect(cspDirectives['script-src']).toContain('https://cdnjs.cloudflare.com');
  });

  // ── Retained sources still present ───────────────────────────────────────

  test("script-src includes 'self'", () => {
    expect(cspDirectives['script-src']).toContain("'self'");
  });

  test("script-src includes 'unsafe-inline'", () => {
    expect(cspDirectives['script-src']).toContain("'unsafe-inline'");
  });

  test('script-src includes https://cdn.jsdelivr.net', () => {
    expect(cspDirectives['script-src']).toContain('https://cdn.jsdelivr.net');
  });

  test('script-src includes /_vercel (Vercel system scripts)', () => {
    // The value uses "/_vercel" without trailing slash
    const scriptSrcJoined = cspDirectives['script-src'].join(' ');
    expect(scriptSrcJoined).toContain('/_vercel');
  });

  // ── Other directives intact ───────────────────────────────────────────────

  test("default-src is 'self'", () => {
    expect(cspDirectives['default-src']).toContain("'self'");
  });

  test('style-src allows fonts.googleapis.com', () => {
    expect(cspDirectives['style-src']).toContain('https://fonts.googleapis.com');
  });

  test('font-src allows fonts.gstatic.com', () => {
    expect(cspDirectives['font-src']).toContain('https://fonts.gstatic.com');
  });

  test('worker-src allows blob:', () => {
    expect(cspDirectives['worker-src']).toContain('blob:');
  });

  test('img-src allows data: and blob:', () => {
    expect(cspDirectives['img-src']).toContain('data:');
    expect(cspDirectives['img-src']).toContain('blob:');
  });

  test('media-src allows blob:', () => {
    expect(cspDirectives['media-src']).toContain('blob:');
  });

  // ── Structural checks ─────────────────────────────────────────────────────

  test('CSP ends with a semicolon (well-formed)', () => {
    expect(cspValue.trimEnd()).toMatch(/;$/);
  });

  test('vercel.json has exactly one Content-Security-Policy header on the global route', () => {
    const globalRoute = config.headers.find(h => h.source === '/(.*)');
    const cspHeaders = globalRoute.headers.filter(h => h.key === 'Content-Security-Policy');
    expect(cspHeaders).toHaveLength(1);
  });
});

// ─── vercel.json — other security headers unchanged ──────────────────────────

describe('vercel.json — other security headers are intact', () => {
  let globalHeaders;

  beforeAll(() => {
    const config = JSON.parse(readFile('vercel.json'));
    const globalRoute = config.headers.find(h => h.source === '/(.*)');
    globalHeaders = globalRoute.headers;
  });

  test('Cross-Origin-Opener-Policy is same-origin', () => {
    const h = globalHeaders.find(h => h.key === 'Cross-Origin-Opener-Policy');
    expect(h).toBeDefined();
    expect(h.value).toBe('same-origin');
  });

  test('Cross-Origin-Embedder-Policy is require-corp', () => {
    const h = globalHeaders.find(h => h.key === 'Cross-Origin-Embedder-Policy');
    expect(h).toBeDefined();
    expect(h.value).toBe('require-corp');
  });

  test('X-Frame-Options is DENY', () => {
    const h = globalHeaders.find(h => h.key === 'X-Frame-Options');
    expect(h).toBeDefined();
    expect(h.value).toBe('DENY');
  });

  test('X-Content-Type-Options is nosniff', () => {
    const h = globalHeaders.find(h => h.key === 'X-Content-Type-Options');
    expect(h).toBeDefined();
    expect(h.value).toBe('nosniff');
  });

  test('Referrer-Policy is strict-origin-when-cross-origin', () => {
    const h = globalHeaders.find(h => h.key === 'Referrer-Policy');
    expect(h).toBeDefined();
    expect(h.value).toBe('strict-origin-when-cross-origin');
  });
});

// ─── render.yaml — Content-Security-Policy header ────────────────────────────

describe('render.yaml — Content-Security-Policy header', () => {
  let yamlContent;
  let cspValue;
  let cspDirectives;

  beforeAll(() => {
    yamlContent = readFile('render.yaml');

    // Extract the CSP value from the YAML using a regex that matches the
    // Content-Security-Policy value line (quoted string after "value:")
    const cspMatch = yamlContent.match(
      /name:\s*Content-Security-Policy\s*\n\s*value:\s*"([^"]+)"/
    );
    expect(cspMatch).not.toBeNull();
    cspValue = cspMatch[1];
    cspDirectives = parseCSP(cspValue);
  });

  test('render.yaml is readable and non-empty', () => {
    expect(yamlContent.length).toBeGreaterThan(0);
  });

  test('Content-Security-Policy header is present in render.yaml', () => {
    expect(yamlContent).toContain('Content-Security-Policy');
  });

  // ── Core security regression: wasm-unsafe-eval removed ───────────────────

  test('script-src does NOT contain wasm-unsafe-eval (PR regression)', () => {
    expect(cspDirectives['script-src']).not.toContain("'wasm-unsafe-eval'");
  });

  test('CSP value string does not contain wasm-unsafe-eval anywhere', () => {
    expect(cspValue).not.toContain('wasm-unsafe-eval');
  });

  // ── No duplicate CSP value lines (the PR removed the duplicate) ──────────

  test('render.yaml has exactly one Content-Security-Policy value line (no duplicate)', () => {
    // Count occurrences of the CSP value pattern in the file
    const cspValueMatches = yamlContent.match(/name:\s*Content-Security-Policy/g);
    expect(cspValueMatches).toHaveLength(1);
  });

  // ── Required sources present ──────────────────────────────────────────────

  test("script-src includes 'self'", () => {
    expect(cspDirectives['script-src']).toContain("'self'");
  });

  test("script-src includes 'unsafe-inline'", () => {
    expect(cspDirectives['script-src']).toContain("'unsafe-inline'");
  });

  test('script-src includes https://cdnjs.cloudflare.com', () => {
    expect(cspDirectives['script-src']).toContain('https://cdnjs.cloudflare.com');
  });

  test('script-src includes https://cdn.jsdelivr.net', () => {
    expect(cspDirectives['script-src']).toContain('https://cdn.jsdelivr.net');
  });

  test('script-src includes /_vercel/ (trailing slash in render.yaml)', () => {
    const scriptSrcJoined = cspDirectives['script-src'].join(' ');
    expect(scriptSrcJoined).toContain('/_vercel/');
  });

  // ── Other directives intact ───────────────────────────────────────────────

  test("default-src is 'self'", () => {
    expect(cspDirectives['default-src']).toContain("'self'");
  });

  test('style-src allows fonts.googleapis.com', () => {
    expect(cspDirectives['style-src']).toContain('https://fonts.googleapis.com');
  });

  test('font-src allows fonts.gstatic.com', () => {
    expect(cspDirectives['font-src']).toContain('https://fonts.gstatic.com');
  });

  test('worker-src allows blob:', () => {
    expect(cspDirectives['worker-src']).toContain('blob:');
  });

  test('media-src allows blob:', () => {
    expect(cspDirectives['media-src']).toContain('blob:');
  });

  test('connect-src allows data: and blob:', () => {
    expect(cspDirectives['connect-src']).toContain('data:');
    expect(cspDirectives['connect-src']).toContain('blob:');
  });
});

// ─── render.yaml — other security headers unchanged ──────────────────────────

describe('render.yaml — other security headers are intact', () => {
  let yamlContent;

  beforeAll(() => {
    yamlContent = readFile('render.yaml');
  });

  test('Cross-Origin-Opener-Policy header is same-origin', () => {
    expect(yamlContent).toMatch(/name:\s*Cross-Origin-Opener-Policy[\s\S]*?value:\s*same-origin/);
  });

  test('Cross-Origin-Embedder-Policy header is require-corp', () => {
    expect(yamlContent).toMatch(/name:\s*Cross-Origin-Embedder-Policy[\s\S]*?value:\s*require-corp/);
  });

  test('X-Frame-Options header is DENY', () => {
    expect(yamlContent).toMatch(/name:\s*X-Frame-Options[\s\S]*?value:\s*DENY/);
  });

  test('X-Content-Type-Options header is nosniff', () => {
    expect(yamlContent).toMatch(/name:\s*X-Content-Type-Options[\s\S]*?value:\s*nosniff/);
  });

  test('Referrer-Policy is strict-origin-when-cross-origin', () => {
    expect(yamlContent).toMatch(/name:\s*Referrer-Policy[\s\S]*?value:\s*strict-origin-when-cross-origin/);
  });
});

// ─── .jules/sentinel.md — removed CSP unsafe-eval entry ─────────────────────

describe('.jules/sentinel.md — 2026-03-29 CSP entry is removed', () => {
  let sentinelContent;

  beforeAll(() => {
    sentinelContent = readFile('.jules/sentinel.md');
  });

  test('sentinel.md is readable and non-empty', () => {
    expect(sentinelContent.length).toBeGreaterThan(0);
  });

  test('the 2026-03-29 "Harden CSP" section heading is absent', () => {
    expect(sentinelContent).not.toContain('2026-03-29');
  });

  test('"Harden CSP by removing unsafe-eval" title is not present', () => {
    expect(sentinelContent).not.toContain('Harden CSP by removing unsafe-eval');
  });

  test('no reference to unsafe-eval vulnerability in a new dated entry', () => {
    // The removed paragraph contained explicit unsafe-eval guidance.
    // Ensure that specific removed text is gone.
    expect(sentinelContent).not.toContain("included the `'unsafe-eval'` directive");
  });

  test('earlier sentinel entries are still present (2026-03-10 innerHTML entry)', () => {
    expect(sentinelContent).toContain('2026-03-10 - Eliminate innerHTML usage');
  });

  test('PRNG dither entry is still present (2024-05-24)', () => {
    expect(sentinelContent).toContain('2024-05-24 - Secure PRNG for Dither');
  });

  test('file contains exactly the two expected dated sections', () => {
    const dateSections = sentinelContent.match(/^## \d{4}-\d{2}-\d{2}/gm);
    expect(dateSections).not.toBeNull();
    expect(dateSections).toHaveLength(2);
  });

  // Regression: ensure the section content describing the removed vulnerability is gone
  test('removed text about auditing CSP configurations is absent (regression)', () => {
    expect(sentinelContent).not.toContain('Periodically audit CSP configurations');
  });
});

// ─── Cross-file consistency: vercel.json vs render.yaml ──────────────────────

describe('Cross-file CSP consistency — vercel.json and render.yaml', () => {
  let vercelCSP;
  let renderCSP;

  beforeAll(() => {
    const vercelConfig = JSON.parse(readFile('vercel.json'));
    const globalRoute = vercelConfig.headers.find(h => h.source === '/(.*)');
    const vercelCSPHeader = globalRoute.headers.find(h => h.key === 'Content-Security-Policy');
    vercelCSP = parseCSP(vercelCSPHeader.value);

    const yamlContent = readFile('render.yaml');
    const cspMatch = yamlContent.match(
      /name:\s*Content-Security-Policy\s*\n\s*value:\s*"([^"]+)"/
    );
    renderCSP = parseCSP(cspMatch[1]);
  });

  test('neither vercel.json nor render.yaml CSP includes wasm-unsafe-eval', () => {
    expect(vercelCSP['script-src']).not.toContain("'wasm-unsafe-eval'");
    expect(renderCSP['script-src']).not.toContain("'wasm-unsafe-eval'");
  });

  test('both configs allow cdnjs.cloudflare.com in script-src', () => {
    expect(vercelCSP['script-src']).toContain('https://cdnjs.cloudflare.com');
    expect(renderCSP['script-src']).toContain('https://cdnjs.cloudflare.com');
  });

  test('both configs allow cdn.jsdelivr.net in script-src', () => {
    expect(vercelCSP['script-src']).toContain('https://cdn.jsdelivr.net');
    expect(renderCSP['script-src']).toContain('https://cdn.jsdelivr.net');
  });

  test("both configs have default-src as 'self'", () => {
    expect(vercelCSP['default-src']).toContain("'self'");
    expect(renderCSP['default-src']).toContain("'self'");
  });

  test('both configs allow blob: in worker-src', () => {
    expect(vercelCSP['worker-src']).toContain('blob:');
    expect(renderCSP['worker-src']).toContain('blob:');
  });
});