/** Maps a validated plan onto the existing control state; it performs no DSP. */
'use strict';

import { clampParam, getParamSpec } from '../core/ParameterSchema.js';
import { validateProcessingPlan } from '../core/IntelligenceContracts.js';

export function planToControlPatch(plan, currentControls = {}) {
  validateProcessingPlan(plan);
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
