/**
 * VoiceIsolate Pro — Analytics v22
 * Privacy-first local analytics + optional server reporting.
 *
 * Tracks:
 *   - Feature usage (which features are used most)
 *   - Processing metrics (duration, quality improvement)
 *   - Session data (time in app, files processed)
 *   - Conversion events (free → trial → paid)
 *   - Error rates per feature
 *
 * Data stays local by default. Server reporting only if user opts in.
 */

const Analytics = (() => {
  'use strict';

  const STORAGE_KEY = 'vip_analytics_v22';
  const SESSION_KEY = 'vip_session_v22';
  const MAX_EVENTS = 500;

  let _events = [];
  let _session = null;
  let _serverEndpoint = null;
  let _serverEnabled = false;
  let _flushTimer = null;

  // ─── Session Management ───────────────────────────────────────────────────────
  function _startSession() {
    _session = {
      id: `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      startedAt: Date.now(),
      filesProcessed: 0,
      totalMinutesProcessed: 0,
      featuresUsed: new Set(),
      tier: window.LicenseManager?.getTier() || 'FREE',
      platform: _detectPlatform(),
    };
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify({ id: _session.id, startedAt: _session.startedAt })); }
    catch { /* storage unavailable */ }
    return _session;
  }

  function _detectPlatform() {
    const ua = navigator.userAgent;
    if (/Capacitor/.test(ua) || window.Capacitor) return 'android';
    if (/iPhone|iPad/.test(ua)) return 'ios';
    if (/Mobile/.test(ua)) return 'mobile-web';
    return 'desktop-web';
  }

  // ─── Event Storage ────────────────────────────────────────────────────────────
  function _loadEvents() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  }

  function _saveEvents() {
    try {
      // Keep only the most recent MAX_EVENTS
      const toSave = _events.slice(-MAX_EVENTS);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
    } catch { /* storage full */ }
  }

  // ─── Core Track Function ──────────────────────────────────────────────────────
  function _track(eventName, properties = {}) {
    const event = {
      e: eventName,
      t: Date.now(),
      s: _session?.id || 'unknown',
      tier: window.LicenseManager?.getTier() || 'FREE',
      platform: _detectPlatform(),
      ...properties,
    };
    _events.push(event);
    _saveEvents();

    // Update session
    if (_session && properties.feature) {
      _session.featuresUsed.add(properties.feature);
    }

    // Server flush (debounced)
    if (_serverEnabled && _serverEndpoint) {
      clearTimeout(_flushTimer);
      _flushTimer = setTimeout(_flushToServer, 5000);
    }
  }

  // ─── Server Flush ─────────────────────────────────────────────────────────────
  async function _flushToServer() {
    if (!_serverEnabled || !_serverEndpoint || _events.length === 0) return;
    const toFlush = _events.slice(-50); // Send last 50 events
    try {
      await fetch(_serverEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ events: toFlush, sessionId: _session?.id }),
        keepalive: true,
      });
    } catch { /* network error, events stay local */ }
  }

  // ─── Aggregation ──────────────────────────────────────────────────────────────
  function _aggregate(events) {
    const featureCounts = {};
    const dailyUsage = {};
    let totalFiles = 0;
    let totalMinutes = 0;
    let errors = 0;

    for (const e of events) {
      // Feature usage
      if (e.feature) featureCounts[e.feature] = (featureCounts[e.feature] || 0) + 1;
      // Daily usage
      const day = new Date(e.t).toDateString();
      dailyUsage[day] = (dailyUsage[day] || 0) + 1;
      // Files processed
      if (e.e === 'file:processed') { totalFiles++; totalMinutes += e.duration || 0; }
      // Errors
      if (e.e === 'error') errors++;
    }

    const topFeatures = Object.entries(featureCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([feature, count]) => ({ feature, count }));

    return { featureCounts, topFeatures, dailyUsage, totalFiles, totalMinutes, errors };
  }

  // ─── Public API ───────────────────────────────────────────────────────────────
  const AN = {
    init(options = {}) {
      _events = _loadEvents();
      _session = _startSession();
      _serverEndpoint = options.endpoint || null;
      _serverEnabled = options.serverEnabled || false;

      // Track app open
      _track('app:open', { version: '22.0.0' });
      return this;
    },

    // ── Feature Events ──────────────────────────────────────────────────────────
    trackFeatureUsed(feature, params = {}) {
      _track('feature:used', { feature, ...params });
    },

    trackFileProcessed(durationMinutes, qualityBefore, qualityAfter, format) {
      if (_session) {
        _session.filesProcessed++;
        _session.totalMinutesProcessed += durationMinutes;
      }
      _track('file:processed', {
        duration: durationMinutes,
        qualityBefore,
        qualityAfter,
        improvement: qualityAfter - qualityBefore,
        format,
      });
    },

    trackExport(format, durationMinutes, watermarked) {
      _track('export', { format, duration: durationMinutes, watermarked });
    },

    trackBatchJob(fileCount, totalMinutes, successCount, errorCount) {
      _track('batch:completed', { fileCount, totalMinutes, successCount, errorCount });
    },

    // ── Monetization Events ─────────────────────────────────────────────────────
    trackPaywallShown(trigger, requiredTier) {
      _track('paywall:shown', { trigger, requiredTier });
    },

    trackTrialStarted(tier) {
      _track('trial:started', { tier });
    },

    trackUpgradeClicked(tier, cycle, source) {
      _track('upgrade:clicked', { tier, cycle, source });
    },

    trackSubscriptionActivated(tier, source) {
      _track('subscription:activated', { tier, source });
    },

    trackSubscriptionCancelled(tier, reason) {
      _track('subscription:cancelled', { tier, reason });
    },

    // ── Error Events ────────────────────────────────────────────────────────────
    trackError(feature, errorMessage, severity = 'error') {
      _track('error', { feature, message: errorMessage, severity });
    },

    // ── Performance Events ──────────────────────────────────────────────────────
    trackProcessingTime(feature, durationMs, audioLengthMs) {
      const rtFactor = audioLengthMs / durationMs; // >1 means faster than real-time
      _track('perf:processing', { feature, durationMs, audioLengthMs, rtFactor });
    },

    // ── Session Events ──────────────────────────────────────────────────────────
    trackSessionEnd() {
      if (!_session) return;
      const duration = Date.now() - _session.startedAt;
      _track('session:end', {
        duration,
        filesProcessed: _session.filesProcessed,
        totalMinutes: _session.totalMinutesProcessed,
        featuresUsed: Array.from(_session.featuresUsed),
      });
      if (_serverEnabled) _flushToServer();
    },

    // ── Analytics Dashboard ─────────────────────────────────────────────────────
    getStats() {
      return _aggregate(_events);
    },

    getRecentEvents(n = 20) {
      return _events.slice(-n);
    },

    getSessionInfo() {
      if (!_session) return null;
      return {
        id: _session.id,
        duration: Date.now() - _session.startedAt,
        filesProcessed: _session.filesProcessed,
        totalMinutesProcessed: _session.totalMinutesProcessed,
        featuresUsed: Array.from(_session.featuresUsed),
        tier: _session.tier,
        platform: _session.platform,
      };
    },

    // ── Privacy Controls ────────────────────────────────────────────────────────
    clearAll() {
      _events = [];
      try { localStorage.removeItem(STORAGE_KEY); } catch { /* ok */ }
    },

    enableServerReporting(endpoint) {
      _serverEndpoint = endpoint;
      _serverEnabled = true;
    },

    disableServerReporting() {
      _serverEnabled = false;
    },

    exportData() {
      const data = JSON.stringify({ events: _events, session: AN.getSessionInfo(), stats: AN.getStats() }, null, 2);
      const blob = new Blob([data], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `voiceisolate_analytics_${Date.now()}.json`;
      document.body.appendChild(a); a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
  };

  // Auto-track session end on page unload
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', () => AN.trackSessionEnd());
    window.addEventListener('DOMContentLoaded', () => AN.init());
    window.Analytics = AN;
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = AN;
  return AN;
})();
