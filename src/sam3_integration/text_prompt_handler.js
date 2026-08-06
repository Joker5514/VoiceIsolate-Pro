/**
 * Text / visual prompt validation and normalization for SAM 3 commands.
 */
'use strict';

import { SAM3_LIMITS, isValidBox } from './types.js';

/** @typedef {'text'|'box'|'click'|'mask-ref'|'clear'} Sam3PromptKind */

/**
 * @typedef {{
 *   kind: Sam3PromptKind,
 *   text?: string,
 *   box?: [number, number, number, number],
 *   point?: [number, number],
 *   label?: 0|1,
 *   maskRefId?: string,
 *   confidenceThreshold?: number,
 * }} Sam3PromptCommand
 */

/**
 * @param {unknown} cmd
 * @returns {{ ok: boolean, reason?: string, command?: Sam3PromptCommand }}
 */
export function validatePromptCommand(cmd) {
  if (!cmd || typeof cmd !== 'object') return { ok: false, reason: 'command-not-object' };
  const c = /** @type {Record<string, unknown>} */ (cmd);
  const kind = String(c.kind || '').toLowerCase();
  if (!['text', 'box', 'click', 'mask-ref', 'clear'].includes(kind)) {
    return { ok: false, reason: 'unknown-kind' };
  }

  /** @type {Sam3PromptCommand} */
  const out = { kind: /** @type {Sam3PromptKind} */ (kind) };

  if (c.confidenceThreshold != null) {
    const th = Number(c.confidenceThreshold);
    if (!Number.isFinite(th) || th < 0 || th > 1) {
      return { ok: false, reason: 'bad-confidenceThreshold' };
    }
    out.confidenceThreshold = th;
  }

  if (kind === 'clear') return { ok: true, command: out };

  if (kind === 'text') {
    const text = String(c.text ?? '').trim();
    if (!text) return { ok: false, reason: 'empty-text' };
    if (text.length > SAM3_LIMITS.MAX_PROMPT_CHARS) {
      return { ok: false, reason: 'text-too-long' };
    }
    // Reject obvious remote URLs inside prompts (prompt injection of fetches)
    // Ban remote URLs inside prompts (do not allow cloud host names)
    if (/https?:\/\//i.test(text)) {
      return { ok: false, reason: 'text-contains-remote-url' };
    }
    out.text = text;
    return { ok: true, command: out };
  }

  if (kind === 'box') {
    if (!isValidBox(c.box)) return { ok: false, reason: 'bad-box' };
    const [x, y, w, h] = /** @type {number[]} */ (c.box);
    if (w <= 0 || h <= 0) return { ok: false, reason: 'non-positive-box' };
    out.box = [x, y, w, h];
    if (c.text) out.text = String(c.text).slice(0, SAM3_LIMITS.MAX_PROMPT_CHARS);
    return { ok: true, command: out };
  }

  if (kind === 'click') {
    if (!Array.isArray(c.point) || c.point.length !== 2) {
      return { ok: false, reason: 'bad-point' };
    }
    const px = Number(c.point[0]);
    const py = Number(c.point[1]);
    if (!Number.isFinite(px) || !Number.isFinite(py)) {
      return { ok: false, reason: 'bad-point' };
    }
    out.point = [px, py];
    const lab = c.label == null ? 1 : Number(c.label);
    if (lab !== 0 && lab !== 1) return { ok: false, reason: 'bad-label' };
    out.label = /** @type {0|1} */ (lab);
    return { ok: true, command: out };
  }

  if (kind === 'mask-ref') {
    const id = String(c.maskRefId || '').trim();
    if (!id || id.length > 64) return { ok: false, reason: 'bad-maskRefId' };
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) return { ok: false, reason: 'maskRefId-charset' };
    out.maskRefId = id;
    return { ok: true, command: out };
  }

  return { ok: false, reason: 'unhandled-kind' };
}

/**
 * Human-readable summary for UI / audit logs (no PII beyond user prompt text).
 * @param {Sam3PromptCommand} command
 */
export function summarizePrompt(command) {
  if (!command) return 'none';
  switch (command.kind) {
    case 'text': return `text:"${(command.text || '').slice(0, 48)}"`;
    case 'box': return `box:[${(command.box || []).map((n) => Math.round(n)).join(',')}]`;
    case 'click': return `click:[${(command.point || []).map((n) => Math.round(n)).join(',')}] lab=${command.label}`;
    case 'mask-ref': return `mask-ref:${command.maskRefId}`;
    case 'clear': return 'clear';
    default: return String(command.kind);
  }
}

export default { validatePromptCommand, summarizePrompt };
