/**
 * jest-cjs-transform.cjs
 *
 * Jest transform for files in public/app/. The root package.json has
 * "type":"module", so Node would reject require() against those files.
 * Routing them through this transform lets Jest run them in its CJS sandbox.
 *
 * Files that are already CJS/UMD (no ESM export syntax) are returned
 * unchanged. Files that use `export` / `export default` (e.g.
 * speaker-diarizer.js) are rewritten to CommonJS named + default exports so
 * existing `require('../public/app/...')` tests keep working.
 */
'use strict';

function toCjs(sourceText) {
  if (!/(^|\n)export\s/.test(sourceText)) return sourceText;

  const named = [];
  let defaultExpr = null;
  let src = sourceText;

  src = src.replace(/^export\s+async\s+function\s+([A-Za-z_$][\w$]*)/gm, (_, n) => {
    named.push(n);
    return `async function ${n}`;
  });
  src = src.replace(/^export\s+function\s+([A-Za-z_$][\w$]*)/gm, (_, n) => {
    named.push(n);
    return `function ${n}`;
  });
  src = src.replace(/^export\s+class\s+([A-Za-z_$][\w$]*)/gm, (_, n) => {
    named.push(n);
    return `class ${n}`;
  });
  src = src.replace(/^export\s+(const|let|var)\s+([A-Za-z_$][\w$]*)/gm, (_, kw, n) => {
    named.push(n);
    return `${kw} ${n}`;
  });
  src = src.replace(/^export\s+\{([^}]+)\};?/gm, (_, inner) => {
    for (const part of inner.split(',')) {
      const p = part.trim();
      if (!p) continue;
      const m = p.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
      if (!m) continue;
      named.push(m[2] ? { id: m[2], from: m[1] } : m[1]);
    }
    return '';
  });
  src = src.replace(/^export\s+default\s+([^;]+);/gm, (_, expr) => {
    defaultExpr = expr.trim();
    return '';
  });

  const lines = [];
  for (const n of named) {
    if (typeof n === 'object') lines.push(`exports.${n.id} = ${n.from};`);
    else lines.push(`exports.${n} = ${n};`);
  }
  if (defaultExpr) {
    lines.push(`exports.default = ${defaultExpr};`);
    lines.push(`module.exports = Object.assign(${defaultExpr}, exports);`);
    lines.push(`module.exports.default = ${defaultExpr};`);
  }
  return `${src}\n${lines.join('\n')}\n`;
}

module.exports = {
  process(sourceText) {
    return { code: toCjs(sourceText) };
  },
  toCjs,
};
