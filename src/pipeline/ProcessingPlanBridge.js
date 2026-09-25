/** Maps a validated plan onto the existing control state; it performs no DSP. */
'use strict';

import { clampParam, getParamSpec } from '../core/ParameterSchema.js';
import { assertPlanIsCurrent } from '../core/IntelligenceContracts.js';

/**
 * @param {object} plan Validated ProcessingPlan.
 * @param {object} [currentControls]
 * @param {{ sessionId?: string, contentFingerprint?: string }} [current]
 *   Identity the caller holds now; a plan built for another session or input is rejected.
 */
export function planToControlPatch(plan, currentControls = {}, current = {}) {
  assertPlanIsCurrent(plan, current);
  const patch = {};
  for (const operation of plan.operations) {
    if (operation.id !== 'process-controls') throw new Error(`[VIP][PlanBridge] Unsupported operation '${operation.id}'`);
    for (const [id, value] of Object.entries(operation.parameters)) {
      if (!getParamSpec(id)) throw new Error(`[VIP][PlanBridge] Unknown control '${id}'`);
      patch[id] = clampParam(id, value);
    }
  }
  return { ...currentControls, ...patch };
}

export default { planToControlPatch };
