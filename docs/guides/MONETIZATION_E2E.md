# Stripe purchase flow: test mode and e2e smoke

Status: **active in test mode.** The server flow works end to end against the
real Stripe SDK. It is not yet deployed to production (see below).

## What the smoke covers

`pnpm test:monetization:e2e` (`scripts/monetization-e2e.mjs`, also the
`monetization-e2e` step of `pnpm prod:verify`) mounts the real `api-routes`
router on a real port and drives:

1. `POST /api/checkout` creates a Checkout session through the Stripe SDK.
2. `POST /api/license/claim` on the unpaid session returns 402.
3. A webhook with a wrong signature returns 400.
4. A signed `checkout.session.completed` is applied; a replay is a duplicate.
5. Claim returns a PRO token; `GET /api/license/status` reports PRO active.
6. `customer.subscription.deleted` revokes it; refresh returns 403.

By default the SDK talks to a local fake Stripe API over HTTP via
`STRIPE_API_BASE`. No keys and no network are needed. `STRIPE_API_BASE` throws
when `NODE_ENV=production`.

## Live Stripe test mode

```bash
STRIPE_E2E_LIVE=1 \
STRIPE_SECRET_KEY=sk_test_... \
STRIPE_PRICE_PRO_MONTHLY=price_... \
pnpm test:monetization:e2e
```

This creates a real test-mode Checkout session and checks that an unpaid
session cannot be claimed. `sk_live_` keys are refused. To exercise the paid
path against Stripe, complete the session with a test card and forward events
with `stripe listen --forward-to localhost:3000/api/webhook/stripe`.

## Not done here (needs a product decision)

- **No production API host.** `.vercelignore` excludes `api/` and
  `api-routes/`, so the Vercel deploy is static. The API needs a Node host
  with a persistent `VIP_DATA_DIR`, the Stripe keys and `LICENSE_JWT_SECRET`.
- **No client gating.** Client code may only display license state
  (CLAUDE.md section 1.1). `workflow-tier.js` is a layout switcher, not a gate.
  Gating features on the client before the API is deployed would lock every
  user out.
- **License email.** Paid checkouts queue a `license-issued` outbox entry; a
  transport that sends it is tracked separately.
