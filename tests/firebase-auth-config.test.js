'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FIREBASE_CONFIG = path.join(ROOT, 'public/app/firebase-config.js');

function readFirebaseConfig() {
  return fs.readFileSync(FIREBASE_CONFIG, 'utf8');
}

describe('firebase-config auth helpers', () => {
  test('keeps Google sign-in helper intact', () => {
    const src = readFirebaseConfig();
    expect(src).toMatch(/export\s+async\s+function\s+signInWithGoogle\s*\(/);
    expect(src).toMatch(/new\s+GoogleAuthProvider\s*\(\s*\)/);
    expect(src).toMatch(/signInWithPopup\s*\(\s*auth\s*,\s*provider\s*\)/);
  });

  test('exports email/password sign-up and sign-in helpers', () => {
    const src = readFirebaseConfig();
    expect(src).toMatch(/createUserWithEmailAndPassword/);
    expect(src).toMatch(/signInWithEmailAndPassword/);
    expect(src).toMatch(/export\s+async\s+function\s+signUpWithEmail\s*\(\s*email\s*,\s*password\s*\)/);
    expect(src).toMatch(/createUserWithEmailAndPassword\s*\(\s*auth\s*,\s*email\s*,\s*password\s*\)/);
    expect(src).toMatch(/export\s+async\s+function\s+signInWithEmail\s*\(\s*email\s*,\s*password\s*\)/);
    expect(src).toMatch(/signInWithEmailAndPassword\s*\(\s*auth\s*,\s*email\s*,\s*password\s*\)/);
  });

  test('session logging helper remains auth-method agnostic', () => {
    const src = readFirebaseConfig();
    expect(src).toMatch(/export\s+async\s+function\s+logSession\s*\(\s*userId\s*,\s*sessionData\s*\)/);
    expect(src).toMatch(/addDoc\s*\(\s*collection\s*\(\s*db\s*,\s*'sessions'\s*\)\s*,\s*\{\s*userId\s*,\s*createdAt:\s*new\s+Date\(\)\s*,\s*\.\.\.sessionData\s*\}\s*\)/);
  });
});
