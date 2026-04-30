/**
 * VoiceIsolate Pro — License Manager v22
 * DEV/TEST STUB: All tiers return ENTERPRISE-level caps. No limits enforced.
 *
 * WARNING: This file is a development stub. It must NOT be deployed to
 * production. In production, replace with a real license manager that
 * validates tokens against /api/license/validate and enforces tier limits.
 */

// Block execution in non-local environments — this file must never reach production.
const _LM_IS_PROD = (() => {
  if (typeof window === 'undefined' || !window.location) return false;
  const h = window.location.hostname;
  return h !== 'localhost' && h !== '127.0.0.1' && !h.endsWith('.local') && h !== '';
})();

if (_LM_IS_PROD) {
  console.error(
    '[LicenseManager] SECURITY: Dev stub detected in production (' +
    window.location.hostname + '). All features restricted to FREE tier. ' +
    'Deploy the production license-manager.js.'
  );
}

const LicenseManager = (() => {

  // All tiers get ENTERPRISE caps during testing — no paywalls, no blocks
  const ENTERPRISE_LIMITS = {
    fileSizeMB:        -1,  // -1 = unlimited
    durationMinutes:   -1,
    exportsPerDay:     -1,
    batchFiles:        -1,
    apiCallsPerMonth:  -1,
    concurrentJobs:    -1,
  };

  const ENTERPRISE_FEATURES = {
    basicNoiseReduction: true, adaptiveNoiseGate: true,
    basicEQ: true, fullEQ: true, voiceIsolation: true,
    mlModels: true, forensicMode: true, batchProcessing: true,
    apiAccess: true, exportWAV: true, exportMP3: true,
    exportFLAC: true, exportStem: true, presets: 'all',
    customPresets: true, threeDSpectrogram: true,
    voiceFingerprint: true, cloudSync: true,
    priorityProcessing: true, watermark: false, whiteLabel: true,
    advancedDynamics: true, harmonicRecovery: true,
    dereverberation: true, aiAutoTune: true,
    sceneClassification: true, voiceQualityMetrics: true,
    noiseProfileLibrary: true, realtimeMonitoring: true,
    liveModeLatency: 'ultra-low',
  };

  const TIERS = {
    FREE:       { id:'free',       name:'Free',       price:0,   priceAnnual:0,    color:'#f59e0b', badge:'Enterprise (Dev)', limits: ENTERPRISE_LIMITS, features: ENTERPRISE_FEATURES },
    PRO:        { id:'pro',        name:'Pro',        price:12,  priceAnnual:99,   color:'#f59e0b', badge:'Enterprise (Dev)', limits: ENTERPRISE_LIMITS, features: ENTERPRISE_FEATURES },
    STUDIO:     { id:'studio',     name:'Studio',     price:29,  priceAnnual:249,  color:'#f59e0b', badge:'Enterprise (Dev)', limits: ENTERPRISE_LIMITS, features: ENTERPRISE_FEATURES },
    ENTERPRISE: { id:'enterprise', name:'Enterprise', price:199, priceAnnual:1999, color:'#f59e0b', badge:null,              limits: ENTERPRISE_LIMITS, features: ENTERPRISE_FEATURES },
  };

  const STORAGE_KEYS = { LICENSE: 'vip_license_v22', USAGE: 'vip_usage_v22', TRIAL: 'vip_trial_v22' };
  let _currentLicense = _LM_IS_PROD
    ? { tier: 'FREE', token: null, email: null, source: 'prod-stub-fallback' }
    : { tier: 'ENTERPRISE', token: null, email: null, source: 'dev-override' };
  let _usageCounters  = { date: new Date().toDateString(), exportsToday: 0, totalExports: 0, totalMinutesProcessed: 0, apiCallsThisMonth: 0, monthKey: new Date().toISOString().slice(0,7) };
  let _listeners = [];

  function safeLocalGet(key) { try { return localStorage.getItem(key); } catch { return null; } }

  const LM = {
    init() {
      if (_LM_IS_PROD) {
        _currentLicense = { tier: 'FREE', token: null, email: null, source: 'prod-stub-fallback' };
        console.error('[LicenseManager] Production environment detected — restricting to FREE tier. Replace this stub.');
      } else {
        _currentLicense = { tier: 'ENTERPRISE', token: null, email: null, source: 'dev-override' };
        console.log('[LicenseManager] DEV MODE — Tier forced to ENTERPRISE, all limits disabled.');
      }
      return this;
    },

    activate(token, email = null) {
      return _LM_IS_PROD ? { success: false, tier: 'FREE', error: 'stub' } : { success: true, tier: 'ENTERPRISE' };
    },
    activateTrial(tier) {
      return _LM_IS_PROD ? { success: false, tier: 'FREE', error: 'stub' } : { success: true, tier: 'ENTERPRISE' };
    },
    deactivate() { /* no-op in dev mode */ },

    getTier()    { return _currentLicense.tier; },
    getTierDef() { return TIERS[_currentLicense.tier] || TIERS['FREE']; },

    can(feature) {
      if (_LM_IS_PROD) return false;
      return true;
    },
    canUsePreset(presetName) {
      if (_LM_IS_PROD) return false;
      return true;
    },

    checkFileLimit(fileSizeMB, durationMinutes) {
      if (_LM_IS_PROD) return { allowed: false, reason: 'License validation unavailable' };
      return { allowed: true, reason: null };
    },

    checkExportLimit() {
      if (_LM_IS_PROD) return { allowed: false };
      return { allowed: true };
    },

    recordExport(durationMinutes = 0) {
      _usageCounters.exportsToday++;
      _usageCounters.totalExports++;
      _usageCounters.totalMinutesProcessed += durationMinutes;
    },

    getUsage() {
      return {
        exportsToday:           _usageCounters.exportsToday,
        exportLimitToday:       -1,
        totalExports:           _usageCounters.totalExports,
        totalMinutesProcessed:  _usageCounters.totalMinutesProcessed,
        apiCallsThisMonth:      _usageCounters.apiCallsThisMonth,
        apiLimit:               -1,
      };
    },

    getAllTiers()     { return TIERS; },
    getLicenseInfo() {
      return {
        tier:      _currentLicense.tier,
        tierDef:   TIERS[_currentLicense.tier] || TIERS['FREE'],
        email:     _currentLicense.email,
        expiresAt: null,
        source:    _currentLicense.source,
        isActive:  !_LM_IS_PROD,
      };
    },

    shouldWatermark() { return _LM_IS_PROD; },
    _getUpgradeTier() { return _LM_IS_PROD ? 'PRO' : null; },

    on(event, callback) {
      _listeners.push({ event, callback });
      return () => { _listeners = _listeners.filter(l => l.callback !== callback); };
    },
  };

  if (typeof window !== 'undefined') {
    window.addEventListener('DOMContentLoaded', () => LM.init());
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = LM;
  } else if (typeof window !== 'undefined') {
    window.LicenseManager = LM;
  }

  return LM;
})();
