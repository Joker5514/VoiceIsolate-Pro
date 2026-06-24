'use strict';

import { getPreset, listPresets } from '../core/StudioPresets.js';
import { SLIDER_BINDINGS } from './SliderUI.js';

const STORAGE_KEY = 'vip-studio-presets';

export class PresetManager {
  constructor(mixer, options = {}) {
    if (!mixer) throw new TypeError('[VIP][PresetManager] A PlaybackMixer instance is required.');
    this.mixer = mixer;
    this.doc = options.document || globalThis.document;
    this.storage = options.storage || globalThis.localStorage || null;
    this.onApply = options.onApply || null;
    this._customPresets = this._loadCustomPresets();
  }

  listBuiltInPresets() {
    return listPresets();
  }

  listCustomPresets() {
    return this._customPresets.slice();
  }

  listAllPresets() {
    return [...this.listBuiltInPresets(), ...this.listCustomPresets()];
  }

  captureCurrentValues() {
    const values = {};
    for (const binding of SLIDER_BINDINGS) {
      const el = this.doc?.getElementById?.(binding.id);
      values[binding.id] = el ? Number(el.value) : binding.initial;
    }
    return values;
  }

  applyPreset(idOrName) {
    const preset = this._resolvePreset(idOrName);
    for (const binding of SLIDER_BINDINGS) {
      if (!Object.prototype.hasOwnProperty.call(preset.values, binding.id)) continue;
      const value = Number(preset.values[binding.id]);
      const el = this.doc?.getElementById?.(binding.id);
      if (el) {
        el.value = String(value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (typeof this.mixer[binding.method] === 'function') {
        this.mixer[binding.method](value);
      }
    }
    if (this.onApply) this.onApply(preset);
    return preset;
  }

  saveCustomPreset(name, description = '') {
    if (typeof name !== 'string' || !name.trim()) {
      throw new TypeError('[VIP][PresetManager] Preset name is required.');
    }
    const trimmed = name.trim();
    const preset = {
      id: `custom-${slugify(trimmed)}-${Date.now().toString(36)}`,
      name: trimmed,
      description: String(description || '').trim(),
      values: Object.freeze(this.captureCurrentValues()),
      custom: true,
    };
    this._customPresets = [...this._customPresets, preset];
    this._persistCustomPresets();
    return preset;
  }

  deleteCustomPreset(id) {
    const before = this._customPresets.length;
    this._customPresets = this._customPresets.filter((preset) => preset.id !== id);
    if (this._customPresets.length !== before) this._persistCustomPresets();
    return this._customPresets.length !== before;
  }

  _resolvePreset(idOrName) {
    const custom = this._customPresets.find((preset) => preset.id === idOrName || preset.name === idOrName);
    return custom || getPreset(idOrName);
  }

  _loadCustomPresets() {
    if (!this.storage?.getItem) return [];
    try {
      const raw = this.storage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((preset) => preset && typeof preset.id === 'string' && typeof preset.name === 'string')
        .map((preset) => ({
          id: preset.id,
          name: preset.name,
          description: preset.description || '',
          values: Object.freeze({ ...preset.values }),
          custom: true,
        }));
    } catch (err) {
      console.warn('[VIP][PresetManager] Failed to load custom presets:', err);
      return [];
    }
  }

  _persistCustomPresets() {
    if (!this.storage?.setItem) return;
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify(this._customPresets));
    } catch (err) {
      console.warn('[VIP][PresetManager] Failed to persist custom presets:', err);
    }
  }
}

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'preset';
}

export default PresetManager;