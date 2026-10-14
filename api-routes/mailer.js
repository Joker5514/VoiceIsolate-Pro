/**
 * VoiceIsolate Pro — transactional email (server only).
 *
 * Drains `license-issued` rows from the store outbox through Resend's REST API.
 * No SDK and no client exposure: the key is read from the server environment
 * and the browser never learns it.
 *
 *   RESEND_API_KEY  — Resend API key (re_...). Unset = no transport.
 *   EMAIL_FROM      — Verified sender, e.g. "VoiceIsolate Pro <billing@example.com>".
 *
 * The email only confirms the subscription. It carries no license token:
 * delivery stays the Stripe-verified claim (POST /api/license/claim).
 *
 * Each row is sent with Resend's Idempotency-Key set to the row id, so a crash
 * between "sent" and the commit that records it cannot mail the buyer twice.
 */
'use strict';

const RESEND_URL = 'https://api.resend.com/emails';
export const MAX_ATTEMPTS = 5;
/** A row left in "sending" this long (crashed process) is retried. */
const SENDING_LEASE_MS = 10 * 60 * 1000;
/**
 * Resend keeps an Idempotency-Key for 24 h. Past that a re-send of a row left in
 * "sending" (outcome unknown) could mail the buyer twice, so it is failed instead.
 * A "retry" row got an error response, so re-sending it is safe.
 */
export const IDEMPOTENCY_WINDOW_MS = 23 * 60 * 60 * 1000;
const BATCH = 20;

/** @returns {{ send: (msg: object, key: string) => Promise<string> } | null} */
export function getMailTransport({ fetchImpl = globalThis.fetch } = {}) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!key || !from) return null;
  return {
    async send(msg, idempotencyKey) {
      const res = await fetchImpl(RESEND_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify({ from, ...msg }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = new Error(`Resend ${res.status}: ${body?.message || body?.name || 'request failed'}`);
        // 4xx other than 429 will not succeed on retry (bad address, bad sender).
        err.permanent = res.status >= 400 && res.status < 500 && res.status !== 429;
        throw err;
      }
      return body?.id || '';
    },
  };
}

export function mailTransportStatus() {
  return process.env.RESEND_API_KEY && process.env.EMAIL_FROM ? 'configured' : 'not-configured';
}

export function licenseIssuedEmail(row) {
  const tier = row.tier || 'PRO';
  return {
    to: [row.email],
    subject: `Your VoiceIsolate Pro ${tier} subscription is active`,
    text: [
      `Thanks for subscribing to VoiceIsolate Pro ${tier}.`,
      '',
      'Your license is ready. Return to the app on the device you paid from and',
      'it activates automatically. Your audio is still processed only on your device.',
      '',
      'If you did not make this purchase, reply to this email.',
    ].join('\n'),
  };
}

const due = (row, now) =>
  row.type === 'license-issued' && row.email && (
    row.status === 'pending' ||
    (row.status === 'retry' && (row.nextAttemptAt || 0) <= now) ||
    (row.status === 'sending' && now - (row.leasedAt || 0) > SENDING_LEASE_MS)
  );

/**
 * Send every due outbox row once. Safe to call concurrently with webhooks:
 * rows are leased in one transaction and settled in another.
 * @returns {Promise<{ sent: number, failed: number, skipped: boolean }>}
 */
export async function drainOutbox(store, transport, { now = Date.now } = {}) {
  if (!store || !transport) return { sent: 0, failed: 0, skipped: true };
  const leased = await store.transact((state) => {
    const t = now();
    const rows = [];
    state.outbox.forEach((row, i) => {
      if (rows.length >= BATCH || !due(row, t)) return;
      if (row.status === 'sending' && t - (row.firstAttemptAt || row.leasedAt || t) > IDEMPOTENCY_WINDOW_MS) {
        Object.assign(row, { status: 'failed', lastError: 'outcome unknown past the idempotency window; not re-sent' });
        return;
      }
      row.id ||= `license-issued:${row.customerId}:${row.at}:${i}`;
      row.status = 'sending';
      row.leasedAt = t;
      row.firstAttemptAt ||= t;
      rows.push({ ...row });
    });
    return rows;
  });

  const outcomes = [];
  for (const row of leased) {
    try {
      outcomes.push({ id: row.id, providerId: await transport.send(licenseIssuedEmail(row), row.id) });
    } catch (err) {
      console.error(`[VIP] [mail] ${row.id} failed: ${err?.message || err}`);
      outcomes.push({ id: row.id, error: String(err?.message || err), permanent: Boolean(err?.permanent) });
    }
  }
  if (!outcomes.length) return { sent: 0, failed: 0, skipped: false };

  return store.transact((state) => {
    const t = now();
    let sent = 0;
    let failed = 0;
    for (const o of outcomes) {
      const row = state.outbox.find((r) => r.id === o.id);
      if (!row) continue;
      if (!o.error) {
        Object.assign(row, { status: 'sent', sentAt: t, providerId: o.providerId });
        sent += 1;
        continue;
      }
      row.attempts = (row.attempts || 0) + 1;
      row.lastError = o.error.slice(0, 300);
      if (o.permanent || row.attempts >= MAX_ATTEMPTS) {
        row.status = 'failed';
      } else {
        row.status = 'retry';
        row.nextAttemptAt = t + 60_000 * 2 ** (row.attempts - 1);
      }
      failed += 1;
    }
    return { sent, failed, skipped: false };
  });
}

export default { getMailTransport, mailTransportStatus, drainOutbox, licenseIssuedEmail };
