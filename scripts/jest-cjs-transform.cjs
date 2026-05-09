/**
 * jest-cjs-transform.cjs
 *
 * Minimal Jest transform for the CJS-style files in public/app/.
 * These files use UMD-style exports (no ESM import/export syntax) but the root
 * package.json has "type":"module", which would cause Node to reject require()
 * calls against them. By routing them through this transform, Jest executes them
 * in its own CJS module sandbox — bypassing Node's ESM file-type detection.
 *
 * The transform is intentionally a no-op: it returns the source unchanged.
 * No compilation or AST work is needed because the files contain no ESM syntax.
 */
'use strict';

module.exports = {
  process(sourceText) {
    // Return the source unchanged. No source map is needed because this is a
    // no-op transform — the files contain UMD-compatible JS with no
    // transpilation required. Jest will run the output in its CJS sandbox.
    return { code: sourceText };
  },
};
