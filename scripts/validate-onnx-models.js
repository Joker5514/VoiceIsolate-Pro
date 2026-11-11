#!/usr/bin/env node
'use strict';
/** Model delivery gate. Default is offline; --remote downloads and hashes required bytes.
 * Optional/unshipped models never block either tier. No HEAD-only success claims.
 */
const path = require('node:path');

async function main() {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => !['--remote', '--require-build'].includes(a));
  if (unknown.length) throw new Error(`Unknown arguments: ${unknown.join(', ')}. Use --remote for network delivery checks.`);
  const root = path.resolve(__dirname, '..');
  const { validateModelIntegrity } = await import('./validate-model-integrity.mjs');
  const { checkModelManifests } = await import('./generate-model-manifests.mjs');
  const local = validateModelIntegrity({ root, requireBuild: args.includes('--require-build') });
  const drift = checkModelManifests(root);
  for (const error of [...local.errors, ...drift]) console.error(`[model-delivery] ${error}`);
  for (const notice of local.notices) console.log(`[model-delivery] ${notice}`);
  let remoteOk = true;
  if (args.includes('--remote')) {
    const { deliveryBase, verifyRemoteDelivery } = await import('./lib/model-delivery.mjs');
    const remote = await verifyRemoteDelivery({ base: deliveryBase(root, process.env.BLOB_BASE_URL) });
    for (const result of remote.results) console.log(`[model-delivery] ${result.ok ? 'PASS' : 'FAIL'} ${result.id}: ${result.error || `${result.size} bytes, SHA-256 verified`}`);
    console.log(`[model-delivery] optional/unshipped, not checked: ${remote.skipped.join(', ') || '(none)'}`);
    remoteOk = remote.ok;
    if (remote.error) console.error(`[model-delivery] ${remote.error}`);
  } else {
    console.log('[model-delivery] offline tier: shipped source bytes and generated registries verified; remote delivery NOT RUN');
  }
  return local.ok && !drift.length && remoteOk ? 0 : 1;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, (error) => { console.error(`[model-delivery] ${error.message}`); process.exitCode = 1; });
}

module.exports = { main };
