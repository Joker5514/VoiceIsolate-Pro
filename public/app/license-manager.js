/**
 * VoiceIsolate Pro — License Manager v22
 * Manages freemium tiers, feature gates, usage quotas, and license validation.
 *
 * Tiers:
 *   FREE       — Basic noise removal, 5-min file limit, watermark on export
 *   PRO        — Full 35-stage pipeline, unlimited files, no watermark ($12/mo)
 *   STUDIO     — Pro + batch processing, API access, priority support ($29/mo)
 *   ENTERPRISE — White-label, custom models, SLA, per-seat ($199/mo)
 *
 * License storage: localStorage (web) / Capacitor Preferences (mobile)
 * License validation: JWT-based offline token + optional server ping
 */

const LicenseManager = (() => {
  // ─── Tier Definitions ────────────────────────────────────────────────────────
  const TIERS = {
    FREE: {
      id: 'free',
      name: 'Free',
      price: 0,
      priceAnnual: 0,
      color: '#6b7280',
      badge: null,
      limits: {
        fileSizeMB: 50,
        durationMinutes: 5,
        exportsPerDay: 3,
        batchFiles: 0,
        apiCallsPerMonth: 0,
        concurrentJobs: 1,
      },
      features: {
        basicNoiseReduction: true,
        adaptiveNoiseGate: true,
        basicEQ: true,          // 5-band only
        fullEQ: false,          // 10-band
        voiceIsolation: false,
        mlModels: false,        // DeepFilterNet, Demucs, BSRNN
        forensicMode: false,
        batchProcessing: false,
        apiAccess: false,
        exportWAV: true,
        exportMP3: false,       // Pro+
        exportFLAC: false,      // Pro+
        exportStem: false,      // Studio+
        presets: ['Podcast', 'Broadcast'], // 2 of 7
        customPresets: false,
        threeDSpectrogram: false,
        voiceFingerprint: false,
        cloudSync: false,
        priorityProcessing: false,
        watermark: true,        // "Processed by VoiceIsolate Free"
        whiteLabel: false,
        advancedDynamics: false,
        harmonicRecovery: false,
        dereverberation: false,
        aiAutoTune: false,
        sceneClassification: false,
        voiceQualityMetrics: false,
        noiseProfileLibrary: false,
        realtimeMonitoring: true,
        liveModeLatency: 'standard', // vs 'ultra-low' for Pro
      },
    },

    PRO: {
      id: 'pro',
      name: 'Pro',
      price: 12,
      priceAnnual: 99,
      color: '#6366f1',
      badge: 'Most Popular',
      limits: {
        fileSizeMB: -1,
        durationMinutes: 120,
        exportsPerDay: 50,
        batchFiles: 10,
        apiCallsPerMonth: 1000,
        concurrentJobs: 3,
      },
      features: {
        basicNoiseReduction: true,
        adaptiveNoiseGate: true,
        basicEQ: true,
        fullEQ: true,
        voiceIsolation: true,
        mlModels: true,
        forensicMode: true,
        batchProcessing: true,
        apiAccess: false,       // Studio+
        exportWAV: true,
        exportMP3: true,
        exportFLAC: true,
        exportStem: false,
        presets: 'all',
        customPresets: true,
        threeDSpectrogram: true,
        voiceFingerprint: true,
        cloudSync: false,       // Studio+
        priorityProcessing: false,
        watermark: false,
        whiteLabel: false,
        advancedDynamics: true,
        harmonicRecovery: true,
        dereverberation: true,
        aiAutoTune: true,
        sceneClassification: true,
        voiceQualityMetrics: true,
        noiseProfileLibrary: true,
        realtimeMonitoring: true,
        liveModeLatency: 'ultra-low',
      },
    },

    STUDIO: {
      id: 'studio',
      name: 'Studio',
      price: 29,
      priceAnnual: 249,
      color: '#f59e0b',
      badge: 'Best Value',
      limits: {
        fileSizeMB: -1,
        durationMinutes: -1,    // unlimited
        exportsPerDay: -1,
        batchFiles: 100,
        apiCallsPerMonth: 10000,
        concurrentJobs: 10,
      },
      features: {
        basicNoiseReduction: true,
        adaptiveNoiseGate: true,
        basicEQ: true,
        fullEQ: true,
        voiceIsolation: true,
        mlModels: true,
        forensicMode: true,
        batchProcessing: true,
        apiAccess: true,
        exportWAV: true,
        exportMP3: true,
        exportFLAC: true,
        exportStem: true,
        presets: 'all',
        customPresets: true,
        threeDSpectrogram: true,
        voiceFingerprint: true,
        cloudSync: true,
        priorityProcessing: true,
        watermark: false,
        whiteLabel: false,
        advancedDynamics: true,
        harmonicRecovery: true,
        dereverberation: true,
        aiAutoTune: true,
        sceneClassification: true,
        voiceQualityMetrics: true,
        noiseProfileLibrary: true,
        realtimeMonitoring: true,
        liveModeLatency: 'ultra-low',
      },
    },

    ENTERPRISE: {
      id: 'enterprise',
      name: 'Enterprise',
      price: 199,
      priceAnnual: 1999,
      color: '#10b981',
      badge: 'Custom',
      limits: {
        fileSizeMB: -1,
        durationMinutes: -1,
        exportsPerDay: -1,
        batchFiles: -1,
        apiCallsPerMonth: -1,
        concurrentJobs: -1,
      },
      features: {
        // All features enabled
        basicNoiseReduction: true,
        adaptiveNoiseGate: true,
        basicEQ: true,
        fullEQ: true,
        voiceIsolation: true,
        mlModels: true,
        forensicMode: true,
        batchProcessing: true,
        apiAccess: true,
        exportWAV: true,
        exportMP3: true,
        exportFLAC: true,
        exportStem: true,
        presets: 'all',
        customPresets: true,
        threeDSpectrogram: true,
        voiceFingerprint: true,
        cloudSync: true,
        priorityProcessing: true,
        watermark: false,
        whiteLabel: true,
        advancedDynamics: true,
        harmonicRecovery: true,
        dereverberation: true,
        aiAutoTune: true,
        sceneClassification: true,
        voiceQualityMetrics: true,
        noiseProfileLibrary: true,
        realtimeMonitoring: true,
        liveModeLatency: 'ultra-low',
      },
    },
  };

  // ─── Storage Keys ─────────────────────────────────────────────────────────────
  const STORAGE_KEYS = {
    LICENSE: 'vip_license_v22',
    USAGE: 'vip_usage_v22',
    TRIAL: 'vip_trial_v22',
  };

  // ─── Internal State ───────────────────────────────────────────────────────────
  let _currentLicense = null;
  let _usageCounters = null;
  let _listeners = [];

  // ─── Storage Helpers ──────────────────────────────────────────────────────────
  /**
   * Safely read a value from localStorage, returning null on any error
   * (e.g. SecurityError in sandboxed/private-browsing contexts).
   * @param {string} key
   * @returns {string|null}
   */
  function safeLocalGet(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  }

  // ─── License Token Validation (offline JWT-like) ──────────────────────────────
  /**
   * Validate an offline license token and return its decoded payload when valid.
   *
   * @param {string} token - Token in the form "base64(header).base64(payload).signature".
   * @returns {Object|null} The parsed payload object if the token is well-formed, contains a valid `tier` and `exp`, is not expired, and the tier exists; `null` otherwise.
   */
  function _validateToken(token) {
    if (!token || typeof token !== 'string') return null;
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return null;
      const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      // Add '=' padding to reach a multiple of 4, as required by atob()
      const padded = b64 + '=='.slice(0, (4 - b64.length % 4) % 4);
      const payload = JSON.parse(atob(padded));
      if (!payload.tier || !payload.exp) return null;
      if (Date.now() / 1000 > payload.exp) return null; // expired
      if (!TIERS[payload.tier.toUpperCase()]) return null;
      return payload;
    } catch {
      return null;
    }
  }

  /**
   * Generate a non-production demo/trial license token for the given tier.
   *
   * The token is a JWT-like string whose payload encodes the tier, a demo subject,
   * issuance and expiration times, available feature keys, and a `source: 'demo'`.
   * The signature portion is a randomly generated demo value and is not cryptographically secure.
   *
   * @param {string} tier - Tier identifier (e.g., "PRO", "FREE"); case is normalized internally.
   * @param {number} [daysValid=30] - Number of days the demo token should remain valid.
   * @returns {string} A demo license token in the form "header.payload.signature".
   */
  function _createDemoToken(tier, daysValid = 30) {
    const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const payload = btoa(JSON.stringify({
      tier: tier.toLowerCase(),
      sub: 'demo_user',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + (daysValid * 86400),
      features: Object.keys(TIERS[tier.toUpperCase()].features),
      source: 'demo',
    }));
    const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2, '0')).join('');
    const sig = btoa(`demo_${nonce}`);
    return `${header}.${payload}.${sig}`;
  }

  /**
   * Load persisted usage counters, ensure they are up-to-date for today, and fall back to a reset baseline on error.
   *
   * Attempts to read usage data from localStorage, resets daily counters if the stored date differs from today,
   * and returns the resulting usage object.
   *
   * @returns {Object} The usage counters object containing at minimum:
   *  - {string} date - today's date string
   *  - {number} exportsToday - exports performed today
   *  - {number} totalExports - cumulative exports
   *  - {number} totalMinutesProcessed - cumulative processed minutes
   *  - {number} apiCallsThisMonth - API calls in the current month
   *  - {string} monthKey - current month in `YYYY-MM` format
   * If reading or parsing stored data fails, returns a freshly reset usage object.
   */
  function _loadUsage() {
    try {
      const raw = safeLocalGet(STORAGE_KEYS.USAGE);
      if (!raw) return _resetUsage();
      const usage = JSON.parse(raw);
      // Reset daily counters if it's a new day
      const today = new Date().toDateString();
      if (usage.date !== today) {
        usage.exportsToday = 0;
        usage.date = today;
        _saveUsage(usage);
      }
      return usage;
    } catch {
      return _resetUsage();
    }
  }

  function _resetUsage() {
    const usage = {
      date: new Date().toDateString(),
      exportsToday: 0,
      totalExports: 0,
      totalMinutesProcessed: 0,
      apiCallsThisMonth: 0,
      monthKey: new Date().toISOString().slice(0, 7),
    };
    _saveUsage(usage);
    return usage;
  }

  function _saveUsage(usage) {
    try {
      try { localStorage.setItem(STORAGE_KEYS.USAGE, JSON.stringify(usage)); } catch { /* ARCH-06: sandboxed */ }
    } catch { /* storage full or unavailable */ }
  }

  // ─── Public API ───────────────────────────────────────────────────────────────
  const LM = {
    /**
     * Initialize the license manager. Call once on app startup.
     */
    init() {
      _usageCounters = _loadUsage();

      // Load saved license
      try {
        const saved = safeLocalGet(STORAGE_KEYS.LICENSE);
        if (saved) {
          const parsed = JSON.parse(saved);
          const payload = _validateToken(parsed.token);
          if (payload) {
            _currentLicense = {
              tier: payload.tier.toUpperCase(),
              token: parsed.token,
              email: parsed.email || null,
              source: payload.source || 'license',
              expiresAt: payload.exp * 1000,
            };
          }
        }
      } catch { /* invalid storage */ }

      // Default to FREE if no valid license
      if (!_currentLicense) {
        _currentLicense = { tier: 'FREE', token: null, email: null, source: 'default' };
      }

      console.log(`[LicenseManager] Initialized — Tier: ${_currentLicense.tier}`);
      return this;
    },

    /**
     * Activate a license token (from Stripe webhook, manual entry, etc.)
     */
    activate(token, email = null) {
      const payload = _validateToken(token);
      if (!payload) return { success: false, error: 'Invalid or expired license token' };

      _currentLicense = {
        tier: payload.tier.toUpperCase(),
        token,
        email,
        source: payload.source || 'license',
        expiresAt: payload.exp * 1000,
      };

      try {
        try { localStorage.setItem(STORAGE_KEYS.LICENSE, JSON.stringify({ token, email })); } catch { /* ARCH-06: sandboxed */ }
      } catch { /* storage error */ }

      _notify('license:activated', _currentLicense);
      return { success: true, tier: _currentLicense.tier };
    },

    /**
     * Activate a trial for a given tier (14-day trial).
     */
    activateTrial(tier) {
      const tierKey = tier.toUpperCase();
      if (!TIERS[tierKey]) return { success: false, error: 'Unknown tier' };

      try {
        const raw = safeLocalGet(STORAGE_KEYS.TRIAL);
        const trialData = JSON.parse(raw || '{}');
        if (trialData[tierKey]) return { success: false, error: 'Trial already used for this tier' };
        trialData[tierKey] = Date.now();
        try { localStorage.setItem(STORAGE_KEYS.TRIAL, JSON.stringify(trialData)); } catch { /* ARCH-06: sandboxed */ }
      } catch { /* storage error */ }

      const token = _createDemoToken(tierKey, 14);
      return this.activate(token);
    },

    /**
     * Deactivate license (logout / cancel subscription).
     */
    deactivate() {
      _currentLicense = { tier: 'FREE', token: null, email: null, source: 'default' };
      try {
        try { localStorage.removeItem(STORAGE_KEYS.LICENSE); } catch { /* ARCH-06: sandboxed */ }
      } catch { /* storage error */ }
      _notify('license:deactivated', null);
    },

    /**
     * Get current tier info.
     */
    getTier() {
      return _currentLicense ? _currentLicense.tier : 'FREE';
    },

    /**
     * Get full tier definition for the current tier.
     */
    getTierDef() {
      return TIERS[this.getTier()] || TIERS.FREE;
    },

    /**
     * Check if a specific feature is available on the current tier.
     */
    can(feature) {
      const tier = this.getTierDef();
      const val = tier.features[feature];
      if (val === undefined) return false;
      if (val === 'all' || val === true) return true;
      if (Array.isArray(val)) return val.length > 0;
      return false;
    },

    /**
     * Check if a preset is available on the current tier.
     */
    canUsePreset(presetName) {
      const tier = this.getTierDef();
      if (tier.features.presets === 'all') return true;
      if (Array.isArray(tier.features.presets)) {
        return tier.features.presets.includes(presetName);
      }
      return false;
    },

    /**
     * Check if a file can be processed given its size and duration.
     * Returns { allowed: bool, reason: string|null }
     */
    checkFileLimit(fileSizeMB, durationMinutes) {
      const limits = this.getTierDef().limits;
      if (limits.fileSizeMB !== -1 && fileSizeMB > limits.fileSizeMB) {
        return {
          allowed: false,
          reason: `File size ${fileSizeMB.toFixed(1)}MB exceeds ${limits.fileSizeMB}MB limit for ${this.getTier()} tier.`,
          upgrade: this._getUpgradeTier(),
        };
      }
      if (limits.durationMinutes !== -1 && durationMinutes > limits.durationMinutes) {
        return {
          allowed: false,
          reason: `Audio duration ${durationMinutes.toFixed(1)} min exceeds ${limits.durationMinutes} min limit for ${this.getTier()} tier.`,
          upgrade: this._getUpgradeTier(),
        };
      }
      return { allowed: true, reason: null };
    },

    /**
     * Check if an export is allowed today.
     */
    checkExportLimit() {
      const limits = this.getTierDef().limits;
      if (limits.exportsPerDay === -1) return { allowed: true };
      if (_usageCounters.exportsToday >= limits.exportsPerDay) {
        return {
          allowed: false,
          reason: `Daily export limit (${limits.exportsPerDay}) reached. Resets at midnight.`,
          upgrade: this._getUpgradeTier(),
        };
      }
      return { allowed: true };
    },

    /**
     * Record an export (increments usage counter).
     */
    recordExport(durationMinutes = 0) {
      _usageCounters.exportsToday++;
      _usageCounters.totalExports++;
      _usageCounters.totalMinutesProcessed += durationMinutes;
      _saveUsage(_usageCounters);
    },

    /**
     * Get usage stats for display.
     */
    getUsage() {
      const limits = this.getTierDef().limits;
      return {
        exportsToday: _usageCounters.exportsToday,
        exportLimitToday: limits.exportsPerDay,
        totalExports: _usageCounters.totalExports,
        totalMinutesProcessed: _usageCounters.totalMinutesProcessed,
        apiCallsThisMonth: _usageCounters.apiCallsThisMonth,
        apiLimit: limits.apiCallsPerMonth,
      };
    },

    /**
     * Get all tier definitions (for pricing page).
     */
    getAllTiers() {
      return TIERS;
    },

    /**
     * Get the license info for display.
     */
    getLicenseInfo() {
      return {
        tier: this.getTier(),
        tierDef: this.getTierDef(),
        email: _currentLicense?.email || null,
        expiresAt: _currentLicense?.expiresAt || null,
        source: _currentLicense?.source || 'default',
        isActive: _currentLicense?.tier !== 'FREE' && _currentLicense?.token !== null,
      };
    },

    /**
     * Check if the watermark should be applied to exports.
     */
    shouldWatermark() {
      return this.getTierDef().features.watermark === true;
    },

    /**
     * Get the next upgrade tier.
     */
    _getUpgradeTier() {
      const order = ['FREE', 'PRO', 'STUDIO', 'ENTERPRISE'];
      const idx = order.indexOf(this.getTier());
      return idx < order.length - 1 ? order[idx + 1] : null;
    },

    /**
     * Subscribe to license events.
     */
    on(event, callback) {
      _listeners.push({ event, callback });
      return () => { _listeners = _listeners.filter(l => l.callback !== callback); };
    },
  };

  function _notify(event, data) {
    _listeners.filter(l => l.event === event || l.event === '*').forEach(l => {
      try { l.callback(data); } catch { /* listener error */ }
    });
  }

  // Auto-init on load
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
