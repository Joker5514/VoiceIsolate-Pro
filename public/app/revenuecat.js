/**
 * VoiceIsolate Pro — RevenueCat Integration v22
 *
 * Handles in-app purchases for Android and iOS via RevenueCat SDK.
 * Falls back to Stripe web checkout when running in browser.
 *
 * Setup:
 *   1. Install: npm install @revenuecat/purchases-capacitor
 *   2. Set RC_API_KEY_ANDROID and RC_API_KEY_IOS in your env
 *   3. Configure products in RevenueCat dashboard matching RC_PRODUCTS below
 *
 * Product IDs (must match RevenueCat dashboard):
 *   voiceisolate_pro_monthly    → $12/mo
 *   voiceisolate_pro_annual     → $99/yr
 *   voiceisolate_studio_monthly → $29/mo
 *   voiceisolate_studio_annual  → $249/yr
 */

const RevenueCatManager = (() => {
  'use strict';

  // ─── Configuration ────────────────────────────────────────────────────────────
  const CONFIG = {
    // Replace with real keys from RevenueCat dashboard
    apiKeyAndroid: 'rcb_android_placeholder',
    apiKeyIOS:     'rcb_ios_placeholder',
    entitlements: {
      PRO:    'pro_access',
      STUDIO: 'studio_access',
    },
    offerings: {
      default: 'default',
      annual:  'annual_promo',
    },
  };

  // ─── Product → Tier Mapping ───────────────────────────────────────────────────
  const PRODUCT_TO_TIER = {
    voiceisolate_pro_monthly:    'PRO',
    voiceisolate_pro_annual:     'PRO',
    voiceisolate_studio_monthly: 'STUDIO',
    voiceisolate_studio_annual:  'STUDIO',
  };

  let _purchases = null;
  let _isNative = false;
  let _initialized = false;
  let _currentOffering = null;

  // ─── Platform Detection ───────────────────────────────────────────────────────
  function _isCapacitor() {
    return !!(window.Capacitor?.isNativePlatform?.());
  }

  function _getPlatform() {
    if (!_isCapacitor()) return 'web';
    return window.Capacitor?.getPlatform?.() || 'web';
  }

  // ─── Initialization ───────────────────────────────────────────────────────────
  async function init(userId = null) {
    if (_initialized) return;

    _isNative = _isCapacitor();
    const platform = _getPlatform();

    if (_isNative) {
      try {
        // Dynamic import of Capacitor plugin
        const { Purchases } = await import('@revenuecat/purchases-capacitor');
        _purchases = Purchases;

        const apiKey = platform === 'ios' ? CONFIG.apiKeyIOS : CONFIG.apiKeyAndroid;
        await Purchases.configure({ apiKey });

        if (userId) {
          await Purchases.logIn({ appUserID: userId });
        }

        // Load current offering
        const { current } = await Purchases.getOfferings();
        _currentOffering = current;

        _initialized = true;
        console.log(`[RevenueCat] Initialized on ${platform}`);

        // Check existing entitlements
        await _syncEntitlements();

      } catch (err) {
        console.warn('[RevenueCat] Native init failed, falling back to web:', err.message);
        _isNative = false;
        _initialized = true;
      }
    } else {
      // Web: use Stripe via Paywall
      _initialized = true;
      console.log('[RevenueCat] Web mode — using Stripe checkout');
    }
  }

  // ─── Entitlement Sync ─────────────────────────────────────────────────────────
  async function _syncEntitlements() {
    if (!_isNative || !_purchases) return;

    try {
      const { customerInfo } = await _purchases.getCustomerInfo();
      const entitlements = customerInfo.entitlements.active;

      let tier = 'FREE';
      if (entitlements[CONFIG.entitlements.STUDIO]) tier = 'STUDIO';
      else if (entitlements[CONFIG.entitlements.PRO]) tier = 'PRO';

      if (tier !== 'FREE' && window.LicenseManager) {
        // Create a synthetic token for the license manager
        const token = _createNativeToken(tier, customerInfo.originalAppUserId);
        window.LicenseManager.activate(token, customerInfo.originalAppUserId);
      }

      return { tier, entitlements };
    } catch (err) {
      console.error('[RevenueCat] Entitlement sync failed:', err.message);
      return { tier: 'FREE', entitlements: {} };
    }
  }

  function _createNativeToken(tier, userId) {
    // Create a 1-year token for native purchases (RevenueCat manages the actual subscription)
    const header = btoa(JSON.stringify({ alg: 'RC', typ: 'JWT' }));
    const payload = btoa(JSON.stringify({
      tier: tier.toLowerCase(),
      sub: userId,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + (365 * 86400),
      source: 'revenuecat',
    }));
    return `${header}.${payload}.native_purchase`;
  }

  // ─── Purchase Flow ────────────────────────────────────────────────────────────
  const RC = {
    init,

    /**
     * Get available packages for display in the pricing UI.
     */
    async getPackages() {
      if (!_isNative || !_purchases) return null;

      try {
        const { current } = await _purchases.getOfferings();
        if (!current) return null;

        return current.availablePackages.map(pkg => ({
          id: pkg.identifier,
          productId: pkg.storeProduct.productIdentifier,
          title: pkg.storeProduct.title,
          description: pkg.storeProduct.description,
          price: pkg.storeProduct.priceString,
          priceAmount: pkg.storeProduct.price,
          currency: pkg.storeProduct.currencyCode,
          period: pkg.packageType, // MONTHLY, ANNUAL, etc.
          tier: PRODUCT_TO_TIER[pkg.storeProduct.productIdentifier] || 'PRO',
        }));
      } catch (err) {
        console.error('[RevenueCat] getPackages failed:', err.message);
        return null;
      }
    },

    /**
     * Purchase a package by product ID.
     * On web: redirects to Stripe checkout.
     * On native: triggers native IAP flow.
     */
    async purchase(productId) {
      if (!_isNative) {
        // Web fallback: use Stripe
        const tier = PRODUCT_TO_TIER[productId] || 'PRO';
        const cycle = productId.includes('annual') ? 'annual' : 'monthly';
        if (window.Paywall) window.Paywall.checkout(tier, cycle);
        return { success: false, reason: 'redirected_to_stripe' };
      }

      try {
        const packages = await RC.getPackages();
        const pkg = packages?.find(p => p.productId === productId);
        if (!pkg) throw new Error(`Package not found: ${productId}`);

        const { customerInfo } = await _purchases.purchasePackage({
          aPackage: { identifier: pkg.id },
        });

        await _syncEntitlements();

        const tier = PRODUCT_TO_TIER[productId] || 'PRO';
        if (window.Analytics) window.Analytics.trackSubscriptionActivated(tier, 'revenuecat');
        if (window.Paywall) window.Paywall.showSuccessToast(`${tier} activated! Welcome.`);

        return { success: true, tier, customerInfo };

      } catch (err) {
        if (err.code === 'PURCHASE_CANCELLED') {
          return { success: false, reason: 'cancelled' };
        }
        console.error('[RevenueCat] Purchase failed:', err.message);
        return { success: false, error: err.message };
      }
    },

    /**
     * Restore previous purchases (required by App Store guidelines).
     */
    async restorePurchases() {
      if (!_isNative || !_purchases) {
        return { success: false, reason: 'not_native' };
      }

      try {
        const { customerInfo } = await _purchases.restorePurchases();
        const result = await _syncEntitlements();
        const tier = result?.tier || 'FREE';

        if (tier !== 'FREE') {
          if (window.Paywall) window.Paywall.showSuccessToast(`Purchases restored! ${tier} active.`);
        } else {
          alert('No active purchases found to restore.');
        }

        return { success: true, tier, customerInfo };
      } catch (err) {
        console.error('[RevenueCat] Restore failed:', err.message);
        return { success: false, error: err.message };
      }
    },

    /**
     * Get current subscription status.
     */
    async getSubscriptionStatus() {
      if (!_isNative || !_purchases) {
        // Web: check LicenseManager
        return window.LicenseManager?.getLicenseInfo() || { tier: 'FREE', active: false };
      }

      try {
        const { customerInfo } = await _purchases.getCustomerInfo();
        const entitlements = customerInfo.entitlements.active;
        let tier = 'FREE';
        if (entitlements[CONFIG.entitlements.STUDIO]) tier = 'STUDIO';
        else if (entitlements[CONFIG.entitlements.PRO]) tier = 'PRO';

        return {
          tier,
          active: tier !== 'FREE',
          expiresAt: customerInfo.latestExpirationDate,
          managementUrl: customerInfo.managementURL,
        };
      } catch (err) {
        return { tier: 'FREE', active: false, error: err.message };
      }
    },

    /**
     * Check if running in native mode.
     */
    isNative: () => _isNative,
    getPlatform: _getPlatform,
    isInitialized: () => _initialized,
  };

  if (typeof window !== 'undefined') window.RevenueCatManager = RC;
  if (typeof module !== 'undefined' && module.exports) module.exports = RC;
  return RC;
})();
