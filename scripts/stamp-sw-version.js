#!/usr/bin/env node
/**
 * stamp-sw-version.js
 * Writes a BUILD_DATE / BUILD_HASH comment into public/sw.js so the service
 * worker cache is busted on every deploy.  If sw.js does not exist the script
 * exits 0 silently — vercel.json already wraps this with `|| true` anyway.
 */

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const SW_PATH = path.resolve(__dirname, '../public/sw.js');

if (!fs.existsSync(SW_PATH)) {
  console.warn('[stamp-sw-version] public/sw.js not found — skipping stamp.');
  process.exit(0);
}

const now  = new Date().toISOString();
const hash = crypto.randomBytes(6).toString('hex');
const stamp = `// __VIP_BUILD__ ${now} ${hash}\n`;

let src = fs.readFileSync(SW_PATH, 'utf8');
// Remove any previous stamp line
src = src.replace(/^\/\/ __VIP_BUILD__.*\n/m, '');
// Prepend fresh stamp
fs.writeFileSync(SW_PATH, stamp + src, 'utf8');
console.log('[stamp-sw-version] Stamped sw.js →', hash);
