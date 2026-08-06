/**
 * Public entry for SAM 3 vision module worker.
 * Spawning:
 *   new Worker('/app/sam3-worker.js', { type: 'module' })
 * or:
 *   new Worker('/src/sam3_integration/worker.js', { type: 'module' })
 *
 * Requires `pnpm sync:src` / dev server so /src maps to public/src.
 */
import '../src/sam3_integration/worker.js';
