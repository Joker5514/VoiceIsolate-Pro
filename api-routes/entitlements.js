/**
 * VoiceIsolate Pro — license tokens and authoritative entitlements.
 *
 * A license token is a signed identity credential (customer id, email,
 * issued tier for display) with a short lifetime. It never grants access on
 * its own: every protected endpoint resolves the customer's current
 * entitlement record in the store, which Stripe webhooks keep up to date.
 * Downgrade, cancellation and failed payment therefore take effect on the
 * next request, not when a 400-day token finally expires.
 *
 * One signing secret for every router (monetization, sync, NIM): separate
 * per-module random dev secrets never agreed, so a token minted by one router
 * was rejected by the others.
 */
'use strict';

import crypto from 'crypto';

/** Token lifetime: one monthly cycle plus a short grace; refresh renews it. */
export const LICENSE_TOKEN_TTL_DAYS = 35;

const PAID_TIERS = new Set(['PRO', 'STUDIO', 'ENTERPRISE']);

let _secret = null;

/** LICENSE_JWT_SECRET; required in production, random per process otherwise. */
export function licenseSecret() {
  if (_secret) return _secret;
  if (process.env.LICENSE_JWT_SECRET) {
    _secret = process.env.LICENSE_JWT_SECRET;
  } else if (process.env.NODE_ENV === 'production') {
    throw new Error('[license] LICENSE_JWT_SECRET is required in production.');
  } else {
    _secret = crypto.randomBytes(48).toString('base64url');
    console.warn(
      '[license] WARNING: LICENSE_JWT_SECRET not set. Using a random per-process secret; '
      + 'license tokens will not validate after restart.',
    );
  }
  return _secret;
}

/**
 * @param {{ customerId: string, email?: string, tier: string, ttlDays?: number }} claims
 * @returns {string}
 */
export function createLicenseToken({ customerId, email = '', tier, ttlDays = LICENSE_TOKEN_TTL_DAYS }) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub: customerId,
    email,
    tier: String(tier).toLowerCase(),
    iat: now,
    exp: now + ttlDays * 86400,
    source: 'stripe',
    jti: crypto.randomBytes(8).toString('hex'),
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', licenseSecret()).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

/**
 * Signature, expiry and issuer check only — no entitlement decision.
 * @param {string} token
 * @returns {object|null}
 */
export function verifyLicenseToken(token) {
  try {
    if (typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const expected = Buffer.from(
      crypto.createHmac('sha256', licenseSecret()).update(`${parts[0]}.${parts[1]}`).digest('base64url'),
      'base64url',
    );
    const got = Buffer.from(parts[2], 'base64url');
    if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (typeof payload.exp !== 'number' || Date.now() / 1000 > payload.exp) return null;
    // Tokens minted before the 35-day lifetime (400 days) are refused even while
    // unexpired, so a long-lived bearer credential cannot outlast the change.
    if (typeof payload.iat !== 'number' || payload.exp - payload.iat > LICENSE_TOKEN_TTL_DAYS * 86400) return null;
    if (payload.source !== 'stripe' || typeof payload.sub !== 'string' || !payload.sub) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Stripe subscription status → whether the subscription currently entitles. */
export function isEntitledStatus(status) {
  return status === 'active' || status === 'trialing';
}

/**
 * The authoritative entitlement behind a token: the customer's current record.
 * @param {{ read: () => Promise<object> }} store
 * @param {string} token
 * @returns {Promise<{ payload: object, customerId: string, email: string, tier: string, active: boolean, status: string } | null>}
 *   null when the token is invalid or the customer has no license record.
 */
export async function resolveEntitlement(store, token) {
  const payload = verifyLicenseToken(token);
  if (!payload || !store) return null;
  const state = await store.read();
  const rec = state.licenses[payload.sub];
  if (!rec) return null;
  const active = isEntitledStatus(rec.status) && PAID_TIERS.has(String(rec.tier).toUpperCase());
  return {
    payload,
    customerId: payload.sub,
    email: rec.email || payload.email || '',
    tier: active ? String(rec.tier).toUpperCase() : 'FREE',
    active,
    status: rec.status,
  };
}

/** Bearer token from an Authorization header, or null. */
export function bearer(req) {
  const auth = req.headers.authorization;
  return typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : null;
}

export default {
  LICENSE_TOKEN_TTL_DAYS,
  licenseSecret,
  createLicenseToken,
  verifyLicenseToken,
  resolveEntitlement,
  isEntitledStatus,
  bearer,
};
