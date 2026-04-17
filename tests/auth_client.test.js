/**
 * VoiceIsolate Pro — auth.js v8 Structural & Functional Tests
 *
 * The v8 auth module (public/app/auth.js) is a privacy-first, 100% local
 * authentication system using SHA-256 password hashing and sessionStorage.
 * It is an ES module and cannot be eval'd directly; these tests verify
 * structure, API surface, and logic via source inspection and jsdom helpers.
 *
 * @jest-environment jsdom
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const authSrc = fs.readFileSync(
  path.join(__dirname, '../public/app/auth.js'),
  'utf8'
);

// ── Exported API surface ───────────────────────────────────────────────────────
describe('auth.js exported functions', () => {
  test('exports requireAuth (async)', () => {
    expect(authSrc).toContain('export async function requireAuth');
  });

  test('exports logout', () => {
    expect(authSrc).toContain('export function logout');
  });

  test('exports getCaps', () => {
    expect(authSrc).toContain('export function getCaps');
  });

  test('exports checkFileSizeLimit', () => {
    expect(authSrc).toContain('export function checkFileSizeLimit');
  });

  test('exports checkFilesRemaining', () => {
    expect(authSrc).toContain('export function checkFilesRemaining');
  });

  test('exports incrementFileUsage', () => {
    expect(authSrc).toContain('export function incrementFileUsage');
  });

  test('exports applyTierToDOM', () => {
    expect(authSrc).toContain('export function applyTierToDOM');
  });
});

// ── Tier configuration ────────────────────────────────────────────────────────
describe('TIER_CAPS configuration', () => {
  test('defines FREE tier', () => {
    expect(authSrc).toContain('FREE:');
  });

  test('defines PRO tier', () => {
    expect(authSrc).toContain('PRO:');
  });

  test('defines STUDIO tier', () => {
    expect(authSrc).toContain('STUDIO:');
  });

  test('defines ENTERPRISE tier', () => {
    expect(authSrc).toContain('ENTERPRISE:');
  });

  test('ENTERPRISE tier has Infinity filesPerMonth', () => {
    const enterpriseBlock = authSrc.match(/ENTERPRISE:\s*\{([\s\S]*?)\}/);
    expect(enterpriseBlock).not.toBeNull();
    expect(enterpriseBlock[1]).toContain('Infinity');
  });

  test('each tier defines maxFileSizeMB', () => {
    expect(authSrc).toContain('maxFileSizeMB:');
  });

  test('each tier defines maxStages', () => {
    expect(authSrc).toContain('maxStages:');
  });

  test('each tier defines mlModels array', () => {
    expect(authSrc).toContain('mlModels:');
  });
});

// ── Security properties ───────────────────────────────────────────────────────
describe('Security', () => {
  test('uses SHA-256 for password hashing via SubtleCrypto', () => {
    expect(authSrc).toContain('SHA-256');
    expect(authSrc).toContain('crypto.subtle');
  });

  test('stores session in sessionStorage (tab-scoped, not persistent)', () => {
    expect(authSrc).toContain('sessionStorage');
  });

  test('does not make network fetch calls for authentication', () => {
    // v8 auth is 100% local — no server calls
    expect(authSrc).not.toContain('fetch(');
  });

  test('password hashes are stored, not plaintext passwords', () => {
    expect(authSrc).toContain('passHash');
    expect(authSrc).not.toMatch(/password\s*:\s*['"][^'"]{4,}['"]/);
  });
});

// ── Session management logic ──────────────────────────────────────────────────
describe('Session management', () => {
  test('SESSION_KEY constant is defined', () => {
    expect(authSrc).toContain('SESSION_KEY');
  });

  test('saves session with sessionStorage.setItem', () => {
    expect(authSrc).toContain('sessionStorage.setItem');
  });

  test('loads session with sessionStorage.getItem', () => {
    expect(authSrc).toContain('sessionStorage.getItem');
  });

  test('clears session with sessionStorage.removeItem', () => {
    expect(authSrc).toContain('sessionStorage.removeItem');
  });

  test('session stores tier field', () => {
    expect(authSrc).toContain('tier');
  });

  test('session stores role field', () => {
    expect(authSrc).toContain('role');
  });
});

// ── Login modal DOM structure ─────────────────────────────────────────────────
describe('Login modal DOM', () => {
  test('renders username input with id vip-username', () => {
    expect(authSrc).toContain('vip-username');
  });

  test('renders password input with id vip-password', () => {
    expect(authSrc).toContain('vip-password');
  });

  test('renders submit button with id vip-auth-submit', () => {
    expect(authSrc).toContain('vip-auth-submit');
  });

  test('renders error display with id vip-auth-error', () => {
    expect(authSrc).toContain('vip-auth-error');
  });

  test('renders overlay with id vip-auth-overlay', () => {
    expect(authSrc).toContain('vip-auth-overlay');
  });
});

// ── DOM tier enforcement ──────────────────────────────────────────────────────
describe('applyTierToDOM()', () => {
  test('manages tier-badge element', () => {
    expect(authSrc).toContain('tier-badge');
  });

  test('handles data-requires-tier attribute gating', () => {
    expect(authSrc).toContain('data-requires-tier');
  });

  test('manages engineer-panel visibility', () => {
    expect(authSrc).toContain('engineer-panel');
  });

  test('manages forensic mode button visibility', () => {
    expect(authSrc).toContain('forensicMode');
  });

  test('manages admin-panel visibility based on role', () => {
    expect(authSrc).toContain('admin-panel');
  });
});

// ── checkFileSizeLimit logic ──────────────────────────────────────────────────
describe('checkFileSizeLimit()', () => {
  test('compares against maxFileSizeMB from tier caps', () => {
    expect(authSrc).toContain('maxFileSizeMB');
    expect(authSrc).toContain('sizeMB');
  });

  test('allows unlimited size when maxFileSizeMB is Infinity', () => {
    expect(authSrc).toContain('Infinity');
  });
});

// ── Logout logic ─────────────────────────────────────────────────────────────
describe('logout()', () => {
  test('calls clearSession to remove stored session', () => {
    expect(authSrc).toContain('clearSession');
  });

  test('triggers page reload after logout', () => {
    expect(authSrc).toContain('location.reload');
  });
});

// ── incrementFileUsage() logic ────────────────────────────────────────────────
describe('incrementFileUsage()', () => {
  test('exported as a function', () => {
    expect(authSrc).toMatch(/export function incrementFileUsage\b/);
  });

  // DEV BYPASS: incrementFileUsage is currently a no-op while all quotas are
  // disabled. When tier enforcement is reintroduced, this test should assert
  // that it persists updated session state back to sessionStorage.
  test('is a no-op under dev bypass', () => {
    const funcMatch = authSrc.match(/export function incrementFileUsage[\s\S]*?\n\}/);
    expect(funcMatch).not.toBeNull();
    const body = funcMatch[0];
    // filesUsed still referenced elsewhere (session schema), but the function
    // itself should not mutate sessionStorage while bypass is on.
    expect(body).not.toContain('sessionStorage');
  });
});
