/**
 * Tests for deployment configuration changes in this PR:
 * - vercel.json: removed 'wasm-unsafe-eval' from script-src, added https://cdnjs.cloudflare.com
 * - render.yaml: removed 'wasm-unsafe-eval' from script-src (duplicate line removed)
 * - .jules/sentinel.md: removed the 2026-03-29 CSP hardening entry
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function readFile(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

function fileExists(relPath) {
  return fs.existsSync(path.join(ROOT, relPath));
}

// ─── vercel.json ─────────────────────────────────────────────────────────────

describe('vercel.json — Content-Security-Policy header', () => {
  let config;
  let cspValue;

  beforeAll(() => {
    config = JSON.parse(readFile('vercel.json'));
    const globalHeaders = config.headers.find(h => h.source === '/(.*)');
    const cspHeader = globalHeaders.headers.find(h => h.key === 'Content-Security-Policy');
    cspValue = cspHeader.value;
  });

  test('file exists and parses as valid JSON', () => {
    expect(fileExists('vercel.json')).toBe(true);
    expect(() => JSON.parse(readFile('vercel.json'))).not.toThrow();
  });

  test('Content-Security-Policy header is present', () => {
    expect(cspValue).toBeDefined();
    expect(typeof cspValue).toBe('string');
    expect(cspValue.length).toBeGreaterThan(0);
  });

  test("script-src does NOT contain 'wasm-unsafe-eval' (security hardening)", () => {
    expect(cspValue).not.toContain('wasm-unsafe-eval');
  });

  test("script-src contains 'unsafe-inline'", () => {
    expect(cspValue).toMatch(/script-src[^;]*'unsafe-inline'/);
  });

  test("script-src contains https://cdnjs.cloudflare.com (added in this PR)", () => {
    expect(cspValue).toContain('https://cdnjs.cloudflare.com');
    expect(cspValue).toMatch(/script-src[^;]*https:\/\/cdnjs\.cloudflare\.com/);
  });

  test('script-src contains https://cdn.jsdelivr.net', () => {
    expect(cspValue).toContain('https://cdn.jsdelivr.net');
    expect(cspValue).toMatch(/script-src[^;]*https:\/\/cdn\.jsdelivr\.net/);
  });

  test("script-src contains 'self'", () => {
    expect(cspValue).toMatch(/script-src[^;]*'self'/);
  });

  test("default-src is 'self'", () => {
    expect(cspValue).toMatch(/default-src\s+'self'/);
  });

  test('style-src allows fonts.googleapis.com', () => {
    expect(cspValue).toContain('https://fonts.googleapis.com');
    expect(cspValue).toMatch(/style-src[^;]*https:\/\/fonts\.googleapis\.com/);
  });

  test('font-src allows fonts.gstatic.com', () => {
    expect(cspValue).toContain('https://fonts.gstatic.com');
    expect(cspValue).toMatch(/font-src[^;]*https:\/\/fonts\.gstatic\.com/);
  });

  test('img-src allows data: and blob: URIs', () => {
    expect(cspValue).toMatch(/img-src[^;]*data:/);
    expect(cspValue).toMatch(/img-src[^;]*blob:/);
  });

  test('media-src allows blob: URIs', () => {
    expect(cspValue).toMatch(/media-src[^;]*blob:/);
  });

  test('worker-src allows blob: URIs', () => {
    expect(cspValue).toMatch(/worker-src[^;]*blob:/);
  });

  test('all required CSP directives are present', () => {
    const requiredDirectives = [
      'default-src',
      'script-src',
      'style-src',
      'font-src',
      'img-src',
      'media-src',
      'connect-src',
      'worker-src',
    ];
    requiredDirectives.forEach(directive => {
      expect(cspValue).toContain(directive);
    });
  });
});

describe('vercel.json — other security headers', () => {
  let globalHeaders;

  beforeAll(() => {
    const config = JSON.parse(readFile('vercel.json'));
    const block = config.headers.find(h => h.source === '/(.*)');
    globalHeaders = block.headers;
  });

  function getHeader(key) {
    const h = globalHeaders.find(h => h.key === key);
    return h ? h.value : undefined;
  }

  test('Cross-Origin-Opener-Policy is same-origin', () => {
    expect(getHeader('Cross-Origin-Opener-Policy')).toBe('same-origin');
  });

  test('Cross-Origin-Embedder-Policy is require-corp', () => {
    expect(getHeader('Cross-Origin-Embedder-Policy')).toBe('require-corp');
  });

  test('X-Frame-Options is DENY', () => {
    expect(getHeader('X-Frame-Options')).toBe('DENY');
  });

  test('X-Content-Type-Options is nosniff', () => {
    expect(getHeader('X-Content-Type-Options')).toBe('nosniff');
  });

  test('Referrer-Policy is strict-origin-when-cross-origin', () => {
    expect(getHeader('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
  });
});

// ─── render.yaml ─────────────────────────────────────────────────────────────

describe('render.yaml — Content-Security-Policy header', () => {
  let renderYaml;
  let cspValue;

  beforeAll(() => {
    renderYaml = readFile('render.yaml');
    // Extract the CSP value by finding the line after "name: Content-Security-Policy"
    const lines = renderYaml.split('\n');
    const cspNameIdx = lines.findIndex(l => l.includes('Content-Security-Policy'));
    // The value follows on the next line that contains "value:"
    let cspLine = null;
    for (let i = cspNameIdx + 1; i < lines.length; i++) {
      if (lines[i].includes('value:')) {
        cspLine = lines[i];
        break;
      }
    }
    // Strip the leading `        value: ` prefix and surrounding quotes
    const match = cspLine && cspLine.match(/value:\s+"(.+)"/);
    cspValue = match ? match[1] : null;
  });

  test('file exists', () => {
    expect(fileExists('render.yaml')).toBe(true);
  });

  test('Content-Security-Policy header entry is present', () => {
    expect(renderYaml).toContain('Content-Security-Policy');
  });

  test('CSP value is extractable and non-empty', () => {
    expect(cspValue).not.toBeNull();
    expect(cspValue.length).toBeGreaterThan(0);
  });

  test("script-src does NOT contain 'wasm-unsafe-eval' (security hardening)", () => {
    expect(cspValue).not.toContain('wasm-unsafe-eval');
  });

  test('render.yaml contains exactly one Content-Security-Policy value line (no duplicate)', () => {
    const valueLines = renderYaml
      .split('\n')
      .filter(l => l.includes('value:') && l.includes('default-src'));
    expect(valueLines).toHaveLength(1);
  });

  test('script-src contains https://cdnjs.cloudflare.com', () => {
    expect(cspValue).toContain('https://cdnjs.cloudflare.com');
    expect(cspValue).toMatch(/script-src[^;]*https:\/\/cdnjs\.cloudflare\.com/);
  });

  test('script-src contains https://cdn.jsdelivr.net', () => {
    expect(cspValue).toContain('https://cdn.jsdelivr.net');
    expect(cspValue).toMatch(/script-src[^;]*https:\/\/cdn\.jsdelivr\.net/);
  });

  test("script-src contains 'unsafe-inline'", () => {
    expect(cspValue).toMatch(/script-src[^;]*'unsafe-inline'/);
  });

  test("default-src is 'self'", () => {
    expect(cspValue).toMatch(/default-src\s+'self'/);
  });

  test('style-src allows fonts.googleapis.com', () => {
    expect(cspValue).toMatch(/style-src[^;]*https:\/\/fonts\.googleapis\.com/);
  });

  test('font-src allows fonts.gstatic.com', () => {
    expect(cspValue).toMatch(/font-src[^;]*https:\/\/fonts\.gstatic\.com/);
  });

  test('worker-src allows blob: URIs', () => {
    expect(cspValue).toMatch(/worker-src[^;]*blob:/);
  });

  test('all required CSP directives are present', () => {
    const requiredDirectives = [
      'default-src',
      'script-src',
      'style-src',
      'font-src',
      'img-src',
      'media-src',
      'connect-src',
      'worker-src',
    ];
    requiredDirectives.forEach(directive => {
      expect(cspValue).toContain(directive);
    });
  });
});

describe('render.yaml — other security headers', () => {
  let renderYaml;

  beforeAll(() => {
    renderYaml = readFile('render.yaml');
  });

  test('Cross-Origin-Opener-Policy is same-origin', () => {
    expect(renderYaml).toContain('Cross-Origin-Opener-Policy');
    expect(renderYaml).toContain('same-origin');
  });

  test('Cross-Origin-Embedder-Policy is require-corp', () => {
    expect(renderYaml).toContain('require-corp');
  });

  test('X-Frame-Options is DENY', () => {
    expect(renderYaml).toContain('DENY');
  });

  test('X-Content-Type-Options is nosniff', () => {
    expect(renderYaml).toContain('nosniff');
  });

  test('Referrer-Policy is strict-origin-when-cross-origin', () => {
    expect(renderYaml).toContain('strict-origin-when-cross-origin');
  });
});

// ─── .jules/sentinel.md ──────────────────────────────────────────────────────

describe('.jules/sentinel.md — removed unsafe-eval CSP entry', () => {
  let sentinel;

  beforeAll(() => {
    sentinel = readFile('.jules/sentinel.md');
  });

  test('file exists', () => {
    expect(fileExists('.jules/sentinel.md')).toBe(true);
  });

  test('removed section heading "Harden CSP by removing unsafe-eval" is not present', () => {
    expect(sentinel).not.toContain('Harden CSP by removing unsafe-eval');
  });

  test('removed section date 2026-03-29 is not present', () => {
    expect(sentinel).not.toContain('2026-03-29');
  });

  test('file still contains the innerHTML vulnerability entry (2026-03-10)', () => {
    expect(sentinel).toContain('2026-03-10');
    expect(sentinel).toContain('innerHTML');
  });

  test('file still contains the secure PRNG entry (2024-05-24)', () => {
    expect(sentinel).toContain('2024-05-24');
    expect(sentinel).toContain('Math.random()');
    expect(sentinel).toContain('crypto.getRandomValues()');
  });

  test('file contains exactly 2 vulnerability entries', () => {
    const entryCount = (sentinel.match(/^## \d{4}-\d{2}-\d{2}/gm) || []).length;
    expect(entryCount).toBe(2);
  });
});

// ─── Cross-config consistency ─────────────────────────────────────────────────

describe('Cross-config consistency — vercel.json vs render.yaml CSP', () => {
  let vercelCsp;
  let renderCsp;

  beforeAll(() => {
    const vercelConfig = JSON.parse(readFile('vercel.json'));
    const globalHeaders = vercelConfig.headers.find(h => h.source === '/(.*)');
    const vercelCspHeader = globalHeaders.headers.find(h => h.key === 'Content-Security-Policy');
    vercelCsp = vercelCspHeader.value;

    const renderYaml = readFile('render.yaml');
    const lines = renderYaml.split('\n');
    const cspNameIdx = lines.findIndex(l => l.includes('Content-Security-Policy'));
    let cspLine = null;
    for (let i = cspNameIdx + 1; i < lines.length; i++) {
      if (lines[i].includes('value:')) {
        cspLine = lines[i];
        break;
      }
    }
    const match = cspLine && cspLine.match(/value:\s+"(.+)"/);
    renderCsp = match ? match[1] : null;
  });

  test("neither config CSP contains 'wasm-unsafe-eval'", () => {
    expect(vercelCsp).not.toContain('wasm-unsafe-eval');
    expect(renderCsp).not.toContain('wasm-unsafe-eval');
  });

  test('both configs allow https://cdnjs.cloudflare.com in script-src', () => {
    expect(vercelCsp).toContain('https://cdnjs.cloudflare.com');
    expect(renderCsp).toContain('https://cdnjs.cloudflare.com');
  });

  test('both configs allow https://cdn.jsdelivr.net in script-src', () => {
    expect(vercelCsp).toContain('https://cdn.jsdelivr.net');
    expect(renderCsp).toContain('https://cdn.jsdelivr.net');
  });

  test("both configs have default-src 'self'", () => {
    expect(vercelCsp).toMatch(/default-src\s+'self'/);
    expect(renderCsp).toMatch(/default-src\s+'self'/);
  });

  test('both configs restrict worker-src to blob: only (no arbitrary worker sources)', () => {
    // worker-src should be 'self' blob: — not wildcard
    expect(vercelCsp).toMatch(/worker-src[^;]*blob:/);
    expect(renderCsp).toMatch(/worker-src[^;]*blob:/);
    expect(vercelCsp).not.toMatch(/worker-src[^;]*\*/);
    expect(renderCsp).not.toMatch(/worker-src[^;]*\*/);
  });

  test("neither config allows 'unsafe-eval' in script-src (regression guard)", () => {
    // Ensure 'unsafe-eval' (not just 'wasm-unsafe-eval') is also absent
    // The only eval-adjacent directive permitted was 'wasm-unsafe-eval', now removed
    expect(vercelCsp).not.toMatch(/script-src[^;]*'unsafe-eval'(?!.*wasm)/);
    expect(renderCsp).not.toMatch(/script-src[^;]*'unsafe-eval'(?!.*wasm)/);
  });
});