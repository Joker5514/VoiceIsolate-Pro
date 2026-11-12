/**
 * One pipeline word for the Engineer header, the debug panel, and the
 * Live-Mix bridge readout. A bridge that has not been started is not
 * "booting".
 */

const SESSION_STATES = new Set(['IDLE', 'LOADING', 'READY', 'PROCESSING', 'DONE', 'ERROR']);

/**
 * @param {unknown} headerText
 * @returns {'IDLE'|'LOADING'|'READY'|'PROCESSING'|'DONE'|'ERROR'}
 */
export function sharedSessionStatus(headerText) {
  const raw = String(headerText == null ? '' : headerText).trim().toUpperCase();
  return SESSION_STATES.has(raw) ? raw : 'IDLE';
}

export { SESSION_STATES };
