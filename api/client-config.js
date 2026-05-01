/**
 * GET /api/client-config
 *
 * Returns non-secret, browser-safe runtime configuration values.
 * Reads RC API keys from process.env so they are NEVER hardcoded
 * in client-side source files.
 *
 * Only returns keys that are safe to expose to the browser
 * (public-facing RevenueCat SDK keys, not Stripe secret keys).
 */
export default function clientConfigHandler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // Prevent caches from holding stale keys after an environment update.
  res.set('Cache-Control', 'no-store');

  res.json({
    rcApiKeyAndroid: process.env.RC_API_KEY_ANDROID || '',
    rcApiKeyIos:     process.env.RC_API_KEY_IOS     || '',
  });
}
