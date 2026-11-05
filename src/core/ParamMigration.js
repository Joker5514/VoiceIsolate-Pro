/**
 * Versioned Engineer / Live-Mix parameter migration.
 *
 * Pure: no DOM, no audio, no storage. Callers persist the returned snapshot
 * and surface `warnings` — values outside a contract are never dropped quietly.
 *
 * gateAttack is milliseconds. Contract v2 matches the Live-Mix engine
 * (PlaybackMixer) and the landing slider: 0–200 ms. Unversioned sessions may
 * still hold a value from the older 0–500 ms Engineer slider. Values inside
 * 0–200 keep their millisecond meaning. Values from 201–500 are reported and
 * set to 200 ms, the slowest attack the engine will apply. Anything else is
 * reported and reset to the default.
 */
'use strict';

import { PARAMETER_BY_ID } from './ParameterSchema.js';

/** Snapshots written by the current app. */
export const PARAM_CONTRACT_VERSION = 2;

/**
 * Upper bound of the pre-v2 Engineer gate-attack slider, in milliseconds.
 * Not an engine limit.
 */
export const GATE_ATTACK_LEGACY_MAX_MS = 500;

function gateAttackSpec() {
  const spec = PARAMETER_BY_ID.get('gateAttack');
  if (!spec) {
    throw new Error('[VIP][ParamMigration] gateAttack is missing from ParameterSchema');
  }
  return spec;
}

/**
 * @param {number} value
 * @param {number} fromVersion
 * @returns {{ value: number, warnings: string[] }}
 */
export function migrateGateAttack(value, fromVersion) {
  const spec = gateAttackSpec();
  const min = spec.min;
  const max = spec.max;
  const fallback = spec.default;
  if (!Number.isFinite(value)) {
    return {
      value: fallback,
      warnings: [`gateAttack was not a finite number and was reset to ${fallback} ms.`],
    };
  }
  if (value >= min && value <= max) {
    return { value, warnings: [] };
  }
  const legacy = Number(fromVersion) < PARAM_CONTRACT_VERSION
    && value > max
    && value <= GATE_ATTACK_LEGACY_MAX_MS;
  if (legacy) {
    return {
      value: max,
      warnings: [
        `gateAttack ${value} ms came from the older 0–${GATE_ATTACK_LEGACY_MAX_MS} ms control. `
        + `Live-Mix applies at most ${max} ms, so it was set to ${max} ms.`,
      ],
    };
  }
  return {
    value: fallback,
    warnings: [
      `gateAttack ${value} ms is outside ${min}–${max} ms and was reset to ${fallback} ms.`,
    ],
  };
}

/**
 * Copy finite numeric controls and migrate the ones whose contract changed.
 * Non-numeric keys are dropped. `paramContractVersion` is metadata, not a control.
 *
 * @param {Record<string, unknown>|null|undefined} raw
 * @param {{ version?: number }} [options]
 * @returns {{
 *   params: Record<string, number>,
 *   version: number,
 *   warnings: string[],
 *   changed: Array<{ id: string, from: number, to: number }>,
 * }}
 */
export function migrateParamSnapshot(raw, options = {}) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const versionField = options.version ?? source.paramContractVersion;
  const fromVersion = Number.isFinite(Number(versionField)) ? Number(versionField) : 0;
  /** @type {Record<string, number>} */
  const params = {};
  for (const [key, value] of Object.entries(source)) {
    if (key === 'paramContractVersion') continue;
    if (typeof value === 'number' && Number.isFinite(value)) params[key] = value;
  }

  const warnings = [];
  const changed = [];
  if (Object.prototype.hasOwnProperty.call(params, 'gateAttack')) {
    const next = migrateGateAttack(params.gateAttack, fromVersion);
    if (next.value !== params.gateAttack) {
      changed.push({ id: 'gateAttack', from: params.gateAttack, to: next.value });
    }
    params.gateAttack = next.value;
    warnings.push(...next.warnings);
  }

  return {
    params,
    version: PARAM_CONTRACT_VERSION,
    warnings,
    changed,
  };
}
