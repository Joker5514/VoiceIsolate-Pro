/**
 * VoiceIsolate Pro — License Manager v22
 * DEV/TEST STUB: All tiers return ENTERPRISE-level caps. No limits enforced.
 *
 * WARNING: This file is a development stub. It must NOT be deployed to
 * production. In production, replace with a real license manager that
 * validates tokens against /api/license/validate and enforces tier limits.
 */

// Fail fast if this stub is accidentally loaded in production.
if (typeof window !== 'undefined' && window.location && window.location.hostname) {
  const _h = window.location.hostname;
  if (_h !== 'localhost' && _h !== '127.0.0.1' && !_h.endsWith('.local')) {
    console.error(
      '[LicenseManager] SECURITY: Dev stub loaded in non-local environment (' +
      _h + '). Replace with production license-manager.js.'
    );
  }
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
  let _currentLicense = { tier: 'ENTERPRISE', token: null, email: null, source: 'dev-override' };
  let _usageCounters  = { date: new Date().toDateString(), exportsToday: 0, totalExports: 0, totalMinutesProcessed: 0, apiCallsThisMonth: 0, monthKey: new Date().toISOString().slice(0,7) };
  let _listeners = [];

  function safeLocalGet(key) { try { return localStorage.getItem(key); } catch { return null; } }

  const LM = {
    init() {
      // Always ENTERPRISE — ignore any stored license
      _currentLicense = { tier: 'ENTERPRISE', token: null, email: null, source: 'dev-override' };
      console.log('[LicenseManager] DEV MODE — Tier forced to ENTERPRISE, all limits disabled.');
      return this;
    },

    activate(token, email = null) { return { success: true, tier: 'ENTERPRISE' }; },
    activateTrial(tier) { return { success: true, tier: 'ENTERPRISE' }; },
    deactivate() { /* no-op in dev mode */ },

    getTier()    { return 'ENTERPRISE'; },
    getTierDef() { return TIERS['ENTERPRISE']; },

    can(feature) { return true; },           // every feature unlocked
    canUsePreset(presetName) { return true; }, // every preset unlocked

    // Always returns allowed — no file or duration blocking
    checkFileLimit(fileSizeMB, durationMinutes) {
      return { allowed: true, reason: null };
    },

    checkExportLimit() { return { allowed: true }; },

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
        tier:     'ENTERPRISE',
        tierDef:  TIERS['ENTERPRISE'],
        email:    null,
        expiresAt: null,
        source:   'dev-override',
        isActive: true,
      };
    },

    shouldWatermark() { return false; }, // no watermark
    _getUpgradeTier() { return null; },   // already at top

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
