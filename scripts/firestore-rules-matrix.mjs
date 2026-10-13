#!/usr/bin/env node
/**
 * Firestore rules CRUD/ownership matrix (repair audit F21), run against the
 * local emulator only — the "demo-" project id cannot reach a real project.
 *
 * Not a project dependency. Run from a scratch directory:
 *   npm i firebase-tools@15 @firebase/rules-unit-testing@5 firebase@12
 *   cp <repo>/scripts/firestore-rules-matrix.mjs .
 *   cp <repo>/firestore.rules firestore.fixed.rules
 *   git -C <repo> show 0b020cc:firestore.rules > firestore.original.rules
 *   printf '{"emulators":{"firestore":{"port":8089,"host":"127.0.0.1"},"ui":{"enabled":false}}}' > firebase.json
 *   npx firebase emulators:exec --only firestore --project demo-vip-rules "node firestore-rules-matrix.mjs"
 */
import { readFileSync } from 'fs';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, deleteDoc } from 'firebase/firestore';

const outcome = async (p) => { try { await p; return 'ALLOW'; } catch (e) { return /PERMISSION_DENIED|permission/i.test(String(e?.code || e?.message)) ? 'DENY' : `ERR:${e?.code || e?.message}`; } };
async function run(rulesFile) {
  const env = await initializeTestEnvironment({
    projectId: 'demo-vip-rules',
    firestore: { rules: readFileSync(rulesFile, 'utf8'), host: '127.0.0.1', port: 8089 },
  });
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'presets/p1'), { userId: 'alice', name: 'Mine', params: {} });
    await setDoc(doc(db, 'presets/p2'), { userId: 'alice', name: 'Two', params: {} });
    await setDoc(doc(db, 'presets/p3'), { userId: 'alice', name: 'Three', params: {} });
    await setDoc(doc(db, 'users/alice'), { name: 'A', tier: 'FREE' });
    await setDoc(doc(db, 'sessions/s1'), { userId: 'alice', createdAt: 1 });
    await setDoc(doc(db, 'licenses/L1'), { userId: 'alice', tier: 'PRO' });
  });
  const alice = env.authenticatedContext('alice').firestore();
  const bob = env.authenticatedContext('bob').firestore();
  const anon = env.unauthenticatedContext().firestore();
  const m = {};
  m['preset: owner reads own'] = await outcome(getDoc(doc(alice, 'presets/p1')));
  m['preset: other user reads'] = await outcome(getDoc(doc(bob, 'presets/p1')));
  m['preset: anonymous reads'] = await outcome(getDoc(doc(anon, 'presets/p1')));
  m['preset: create own'] = await outcome(setDoc(doc(alice, 'presets/n1'), { userId: 'alice', name: 'New' }));
  m['preset: create for another user'] = await outcome(setDoc(doc(alice, 'presets/n2'), { userId: 'bob', name: 'Planted' }));
  m['preset: owner updates, keeps owner'] = await outcome(updateDoc(doc(alice, 'presets/p1'), { name: 'Renamed' }));
  m['preset: owner reassigns to another user'] = await outcome(updateDoc(doc(alice, 'presets/p2'), { userId: 'bob' }));
  m['preset: other user updates'] = await outcome(updateDoc(doc(bob, 'presets/p1'), { name: 'Hijack' }));
  m['preset: owner update, name too long'] = await outcome(updateDoc(doc(alice, 'presets/p1'), { name: 'x'.repeat(200) }));
  m['preset: owner deletes own'] = await outcome(deleteDoc(doc(alice, 'presets/p3')));
  m['preset: other user deletes'] = await outcome(deleteDoc(doc(bob, 'presets/p1')));
  m['user: owner updates name'] = await outcome(updateDoc(doc(alice, 'users/alice'), { name: 'Al' }));
  m['user: owner escalates tier'] = await outcome(updateDoc(doc(alice, 'users/alice'), { tier: 'STUDIO' }));
  m['user: create with tier'] = await outcome(setDoc(doc(bob, 'users/bob'), { name: 'B', tier: 'PRO' }));
  m['user: other user reads'] = await outcome(getDoc(doc(bob, 'users/alice')));
  m['user: owner deletes'] = await outcome(deleteDoc(doc(alice, 'users/alice')));
  m['session: create own'] = await outcome(setDoc(doc(alice, 'sessions/s2'), { userId: 'alice', createdAt: 2 }));
  m['session: owner updates'] = await outcome(updateDoc(doc(alice, 'sessions/s1'), { createdAt: 3 }));
  m['session: owner deletes'] = await outcome(deleteDoc(doc(alice, 'sessions/s1')));
  m['license: owner reads'] = await outcome(getDoc(doc(alice, 'licenses/L1')));
  m['license: owner writes'] = await outcome(updateDoc(doc(alice, 'licenses/L1'), { tier: 'ENTERPRISE' }));
  m['other collection: write'] = await outcome(setDoc(doc(alice, 'misc/x'), { a: 1 }));
  await env.cleanup();
  return m;
}
const orig = await run('firestore.original.rules');
const fixed = await run('firestore.fixed.rules');
const expected = {
  'preset: owner reads own': 'ALLOW', 'preset: other user reads': 'DENY', 'preset: anonymous reads': 'DENY',
  'preset: create own': 'ALLOW', 'preset: create for another user': 'DENY', 'preset: owner updates, keeps owner': 'ALLOW',
  'preset: owner reassigns to another user': 'DENY', 'preset: other user updates': 'DENY', 'preset: owner update, name too long': 'DENY',
  'preset: owner deletes own': 'ALLOW', 'preset: other user deletes': 'DENY',
  'user: owner updates name': 'ALLOW', 'user: owner escalates tier': 'DENY', 'user: create with tier': 'DENY',
  'user: other user reads': 'DENY', 'user: owner deletes': 'DENY',
  'session: create own': 'ALLOW', 'session: owner updates': 'DENY', 'session: owner deletes': 'DENY',
  'license: owner reads': 'ALLOW', 'license: owner writes': 'DENY', 'other collection: write': 'DENY',
};
let bad = 0;
console.log('case | expected | original | fixed');
for (const k of Object.keys(expected)) {
  const ok = fixed[k] === expected[k];
  if (!ok) bad++;
  console.log(`${k} | ${expected[k]} | ${orig[k]}${orig[k] !== expected[k] ? ' (WRONG)' : ''} | ${fixed[k]}${ok ? '' : ' (WRONG)'}`);
}
console.log(bad ? `FIXED RULES: ${bad} mismatches` : 'FIXED RULES: matrix matches expectations');
// exitCode, not exit(): stdout is a pipe under emulators:exec and must flush.
process.exitCode = bad ? 1 : 0;
