/**
 * VoiceIsolate Pro — Capability Registry (Layer 1: Core)
 *
 * The single authoritative query point for "can this capability be used?"
 * Shared by the profile resolver, RecommendationEngine, AnalyzerWhisperBridge,
 * UI preset availability, and worker execution eligibility (the worker gets
 * the same disabled list via its init payload — see MLWorkerHost.initMLWorker
 * — and rejects disabled profileIds at the process boundary).
 *
 * UI-01 (LOCAL 2026-11-25): do NOT solve stale recommendations with a
 * hardcoded list in RecommendationEngine — that creates a second source of
 * truth. This registry DERIVES from the existing single sources instead:
 * preset enablement from the `disabled` / `disabledReason` flags on the
 * preset objects (PresetCalibration.PRESET_DISABLED), model availability
 * from ModelManifest `shipped` flags. Nothing here duplicates those facts.
 *
 * Preset capabilities are static (known at import). Model capabilities are
 * runtime state: the registry holds the last worker attestation's verdict
 * (see ML-02); until an attestation arrives a model is 'unknown' and must
 * not be recommended as available. Pass a capabilities snapshot into
 * recommend-time calls when the caller has one; the static preset filter
 * always applies regardless.
 *
 * Pure module except for the attestation snapshot store (a plain object the
 * host replaces wholesale on each validated attestation — never mutated
 * in place, so a stale snapshot cannot survive a worker restart).
 */
'use strict';

import {
  CALIBRATED_ENGINEER_PRESETS,
  PRESET_DISABLED,
  STANDARD_DEFAULT,
  resolvePresetName,
} from './PresetCalibration.js';
import { MODEL_MANIFEST } from './ModelManifest.js';

/**
 * @typedef {'ready'|'disabled'|'degraded'|'unavailable'|'unknown'} CapabilityStatus
 * @typedef {object} ProcessingCapability
 * @property {string} id
 * @property {'preset'|'model'} kind
 * @property {boolean} enabled
 * @property {CapabilityStatus} status
 * @property {string} [reason]
 */

/**
 * Preset capability, derived from the preset object's own flags.
 * @param {string} name preset name or alias
 * @returns {ProcessingCapability}
 */
export function getPresetCapability(name) {
  const resolved = resolvePresetName(name);
  const preset = CALIBRATED_ENGINEER_PRESETS[resolved];
  const reason = PRESET_DISABLED[resolved] || preset?.disabledReason || null;
  if (preset?.disabled === true || reason) {
    return {
      id: resolved, kind: 'preset', enabled: false, status: 'disabled',
      reason: reason || 'Disabled pending re-qualification.',
    };
  }
  return { id: resolved, kind: 'preset', enabled: true, status: 'ready' };
}

/** True when the named preset may be selected, recommended, or executed. */
export function isPresetEnabled(name) {
  return getPresetCapability(name).enabled;
}

/**
 * Model capability from the manifest's static facts. Runtime state
 * (loaded/verified/failed) comes from the worker attestation snapshot —
 * see getModelCapability with a snapshot, and recordAttestation.
 * @param {string} id model id
 * @param {Record<string, ProcessingCapability>} [snapshot] attestation snapshot by model id
 * @returns {ProcessingCapability}
 */
export function getModelCapability(id, snapshot = null) {
  const entry = MODEL_MANIFEST[id];
  if (!entry) {
    return { id, kind: 'model', enabled: false, status: 'unavailable', reason: `Unknown model '${id}'.` };
  }
  if (entry.shipped === false) {
    return { id, kind: 'model', enabled: false, status: 'unavailable', reason: `'${id}' is not shipped.` };
  }
  if (snapshot && Object.prototype.hasOwnProperty.call(snapshot, id)) {
    return snapshot[id];
  }
  return { id, kind: 'model', enabled: false, status: 'unknown', reason: 'No worker attestation received yet.' };
}

/** Last validated worker attestation snapshot (model id → capability). */
let _attestationSnapshot = Object.freeze({});

/**
 * Replace the attestation snapshot wholesale (ML-02). The caller must pass
 * a snapshot already validated by validateWorkerAttestation (OrtStatus) —
 * this function does not re-validate, it only stores.
 * @param {Record<string, ProcessingCapability>} snapshot
 */
export function recordAttestationSnapshot(snapshot) {
  _attestationSnapshot = Object.freeze({ ...(snapshot || {}) });
}

/** The current attestation snapshot (empty until the first attestation). */
export function getAttestationSnapshot() {
  return _attestationSnapshot;
}

/** Drop the snapshot — called when the worker is recycled (ML-02). */
export function clearAttestationSnapshot() {
  _attestationSnapshot = Object.freeze({});
}

/**
 * Re-route a preset name through the registry. Disabled presets resolve to
 * the Standard profile with a reason; enabled presets pass through.
 * This is the ONLY place recommendation code may substitute a preset.
 * @param {string} name
 * @returns {{ preset: string, substituted: boolean, reason: string|null }}
 */
export function revalidatePreset(name) {
  const cap = getPresetCapability(name);
  if (cap.enabled) return { preset: cap.id, substituted: false, reason: null };
  return {
    preset: STANDARD_DEFAULT.profile,
    substituted: true,
    reason: `'${cap.id}' is disabled (${cap.reason}) — substituted the Standard profile '${STANDARD_DEFAULT.profile}'.`,
  };
}

/**
 * Revalidate a recommendation object: a disabled recommendedPreset is
 * replaced with the Standard profile, the reason is appended to `reasons`,
 * and the stage config's canonical keys are reset to the Standard values
 * (the substituted preset is what will actually be applied).
 * Returns a new object; the input is not mutated.
 * @param {object} rec a RecommendationEngine / AnalyzerWhisperBridge result
 * @returns {object}
 */
export function revalidateRecommendation(rec) {
  if (!rec || typeof rec !== 'object') return rec;
  const checked = revalidatePreset(rec.recommendedPreset);
  if (!checked.substituted) return rec;
  const stage = { ...(rec.recommendedStageConfig || {}) };
  stage.maskStrength = STANDARD_DEFAULT.maskStrength;
  stage.whisperMode = STANDARD_DEFAULT.whisperMode;
  stage.whisperLift = STANDARD_DEFAULT.whisperLift;
  stage.gateThresh = STANDARD_DEFAULT.gateThresh;
  return {
    ...rec,
    recommendedPreset: checked.preset,
    recommendedStageConfig: stage,
    reasons: [...(rec.reasons || []), checked.reason],
    autoApplySafe: false,
  };
}

/**
 * Assert a recommendation result contains no disabled preset id anywhere
 * it could be acted on (recommendedPreset). Used by tests.
 * @param {object} rec
 * @returns {string[]} disabled preset ids found (empty = clean)
 */
export function findDisabledPresetsInRecommendation(rec) {
  const found = [];
  const name = rec?.recommendedPreset;
  if (typeof name === 'string' && !isPresetEnabled(name)) found.push(resolvePresetName(name));
  return found;
}

export default {
  getPresetCapability,
  isPresetEnabled,
  getModelCapability,
  recordAttestationSnapshot,
  getAttestationSnapshot,
  clearAttestationSnapshot,
  revalidatePreset,
  revalidateRecommendation,
  findDisabledPresetsInRecommendation,
};
