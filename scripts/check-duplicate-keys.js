/**
 * Detects duplicate keys in a raw JSON string using a string-aware tokenizer.
 * Walks character-by-character, correctly skipping string contents (including
 * escape sequences) so that braces/brackets inside strings are never counted
 * as structural tokens.
 *
 * @param {string} raw - The raw JSON string to scan.
 * @returns {string[]} Array of duplicate key names found (may contain repeats
 *   if a key appears more than twice).
 */
function findDuplicateKeys(raw) {
  const dupes = [];
  const stack = [new Set()]; // stack of key-sets, one per object nesting level
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    // Skip whitespace
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i++; continue; }
    // String literal — advance past the entire string, handling escapes
    if (ch === '"') {
      const start = i;
      i++; // skip opening quote
      while (i < raw.length && raw[i] !== '"') {
        if (raw[i] === '\\') i++; // skip escaped char
        i++;
      }
      i++; // skip closing quote
      // Check if this string is a key (followed by ':')
      let j = i;
      while (j < raw.length && (raw[j] === ' ' || raw[j] === '\t' || raw[j] === '\n' || raw[j] === '\r')) j++;
      if (j < raw.length && raw[j] === ':') {
        const key = raw.slice(start + 1, i - 1);
        const currentLevel = stack[stack.length - 1];
        if (currentLevel.has(key)) {
          dupes.push(key);
        }
        currentLevel.add(key);
        i = j + 1; // skip past ':'
      }
      continue;
    }
    // Object open — push a new key-set scope
    if (ch === '{') { stack.push(new Set()); i++; continue; }
    // Object close — pop key-set scope
    if (ch === '}') { if (stack.length > 1) stack.pop(); i++; continue; }
    // Array open/close — push/pop a scope so nested objects inside arrays
    // each get their own key tracking (the set will simply stay empty for arrays)
    if (ch === '[') { stack.push(new Set()); i++; continue; }
    if (ch === ']') { if (stack.length > 1) stack.pop(); i++; continue; }
    // Skip all other characters (numbers, booleans, null, commas, colons)
    i++;
  }
  return dupes;
}

module.exports = { findDuplicateKeys };
