/**
 * @voiceisolate/vip-sam-runtime — single package identity for all surfaces.
 * Re-exports shared provider entry points used by Web / Android WebView / Electron.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
export { getSamRuntimePaths } from './paths.js';

const __dir = dirname(fileURLToPath(import.meta.url));
export const manifest = JSON.parse(
  readFileSync(join(__dir, 'manifest.json'), 'utf8'),
);

/** True when this package is loaded (bundled in all three app versions). */
export const VIP_SAM_RUNTIME_BUNDLED = true;

export const VIP_SAM_RUNTIME_VERSION = '25.0.2';
