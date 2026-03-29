/**
 * VoiceIsolate Pro — Cloud Sync v22 (Studio/Enterprise)
 *
 * Syncs user presets, noise profiles, and processing history across devices.
 * Uses a simple REST API with JWT auth.
 *
 * In production: connect to your backend (Node.js + S3/R2 for file storage).
 * This module provides the full client-side interface with offline-first design.
 */

const CloudSync = (() => {
  'use strict';

  const BASE_URL = '/api/sync';
  const STORAGE_KEY = 'vip_cloud_sync_v22';
  const SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

  let _token = null;
  let _syncTimer = null;
  let _pendingChanges = [];
  let _lastSyncAt = null;
  let _listeners = [];
  let _online = navigator.onLine;

  function _emit(event, data) {
    _listeners.filter(l => l.event === event || l.event === '*')
      .forEach(l => { try { l.cb(data); } catch { /* listener error */ } });
  }

  function _headers() {
    return {
      'Content-Type': 'application/json',
      ..._token ? { Authorization: `Bearer ${_token}` } : {},
    };
  }

  async function _apiCall(method, path, body = null) {
    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: _headers(),
      body: body ? JSON.stringify(body) : null,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `API error ${res.status}`);
    }
    return res.json();
  }

  function _loadLocal() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : { presets: [], noiseProfiles: [], history: [], pendingChanges: [] };
    } catch { return { presets: [], noiseProfiles: [], history: [], pendingChanges: [] }; }
  }

  function _saveLocal(data) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch { /* storage full */ }
  }

  const CS = {
    /**
     * Initialize cloud sync with a license token.
     */
    init(licenseToken) {
      _token = licenseToken;
      const local = _loadLocal();
      _pendingChanges = local.pendingChanges || [];

      // Monitor online status
      window.addEventListener('online', () => {
        _online = true;
        _emit('sync:online', {});
        CS.sync(); // Sync when coming back online
      });
      window.addEventListener('offline', () => {
        _online = false;
        _emit('sync:offline', {});
      });

      // Start periodic sync
      _syncTimer = setInterval(() => CS.sync(), SYNC_INTERVAL_MS);
      return this;
    },

    /**
     * Perform a full sync (push pending changes, pull latest).
     */
    async sync() {
      if (!_online || !_token) return { success: false, reason: 'offline or not authenticated' };

      const LM = window.LicenseManager;
      if (!LM?.can('cloudSync')) {
        return { success: false, reason: 'Cloud sync requires Studio or Enterprise tier' };
      }

      _emit('sync:started', {});
      try {
        // Push pending changes
        if (_pendingChanges.length > 0) {
          await _apiCall('POST', '/push', { changes: _pendingChanges });
          _pendingChanges = [];
          const local = _loadLocal();
          local.pendingChanges = [];
          _saveLocal(local);
        }

        // Pull latest
        const remote = await _apiCall('GET', '/pull');
        const local = _loadLocal();

        // Merge: remote wins for conflicts (last-write-wins)
        const merged = {
          presets: _mergeByKey(local.presets, remote.presets, 'id'),
          noiseProfiles: _mergeByKey(local.noiseProfiles, remote.noiseProfiles, 'name'),
          history: [...(local.history || []), ...(remote.newHistory || [])].slice(-100),
          pendingChanges: [],
        };
        _saveLocal(merged);
        _lastSyncAt = Date.now();

        _emit('sync:completed', { syncedAt: _lastSyncAt, itemCount: remote.presets?.length || 0 });
        return { success: true, syncedAt: _lastSyncAt };

      } catch (err) {
        _emit('sync:error', { error: err.message });
        return { success: false, error: err.message };
      }
    },

    /**
     * Save a preset (syncs to cloud if online).
     */
    async savePreset(preset) {
      const local = _loadLocal();
      const existing = local.presets.findIndex(p => p.id === preset.id);
      const item = { ...preset, updatedAt: Date.now() };
      if (existing >= 0) local.presets[existing] = item;
      else local.presets.push(item);
      _saveLocal(local);

      _pendingChanges.push({ type: 'preset:upsert', data: item, at: Date.now() });
      if (_online) await CS.sync();
      _emit('preset:saved', { preset: item });
      return item;
    },

    /**
     * Delete a preset.
     */
    async deletePreset(presetId) {
      const local = _loadLocal();
      local.presets = local.presets.filter(p => p.id !== presetId);
      _saveLocal(local);
      _pendingChanges.push({ type: 'preset:delete', id: presetId, at: Date.now() });
      if (_online) await CS.sync();
      _emit('preset:deleted', { presetId });
    },

    /**
     * Get all synced presets.
     */
    getPresets() {
      return _loadLocal().presets;
    },

    /**
     * Save a noise profile.
     */
    async saveNoiseProfile(profile) {
      const local = _loadLocal();
      const existing = local.noiseProfiles.findIndex(p => p.name === profile.name);
      const item = { ...profile, spectrum: Array.from(profile.spectrum), updatedAt: Date.now() };
      if (existing >= 0) local.noiseProfiles[existing] = item;
      else local.noiseProfiles.push(item);
      _saveLocal(local);
      _pendingChanges.push({ type: 'noiseProfile:upsert', data: item, at: Date.now() });
      if (_online) await CS.sync();
      _emit('noiseProfile:saved', { profile: item });
      return item;
    },

    /**
     * Get all synced noise profiles.
     */
    getNoiseProfiles() {
      return _loadLocal().noiseProfiles;
    },

    /**
     * Record a processing history entry.
     */
    recordHistory(entry) {
      const local = _loadLocal();
      local.history = [...(local.history || []), { ...entry, at: Date.now() }].slice(-100);
      _saveLocal(local);
      _pendingChanges.push({ type: 'history:add', data: entry, at: Date.now() });
    },

    /**
     * Get processing history.
     */
    getHistory() {
      return _loadLocal().history || [];
    },

    /**
     * Get sync status.
     */
    getStatus() {
      return {
        online: _online,
        authenticated: !!_token,
        lastSyncAt: _lastSyncAt,
        pendingChanges: _pendingChanges.length,
        enabled: !!window.LicenseManager?.can('cloudSync'),
      };
    },

    /**
     * Disconnect and clear local sync data.
     */
    disconnect() {
      _token = null;
      clearInterval(_syncTimer);
      try { localStorage.removeItem(STORAGE_KEY); } catch { /* ok */ }
      _emit('sync:disconnected', {});
    },

    on(event, cb) {
      _listeners.push({ event, cb });
      return () => { _listeners = _listeners.filter(l => l.cb !== cb); };
    },
  };

  function _mergeByKey(local, remote, key) {
    if (!remote) return local;
    const map = new Map((local || []).map(item => [item[key], item]));
    for (const item of remote) {
      const existing = map.get(item[key]);
      if (!existing || (item.updatedAt || 0) > (existing.updatedAt || 0)) {
        map.set(item[key], item);
      }
    }
    return Array.from(map.values());
  }

  if (typeof window !== 'undefined') window.CloudSync = CS;
  if (typeof module !== 'undefined' && module.exports) module.exports = CS;
  return CS;
})();
