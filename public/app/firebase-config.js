// Firebase Client Configuration for VoiceIsolate Pro
// Replace the placeholder values below with your actual Firebase project credentials
// from the Firebase Console: https://console.firebase.google.com

/**
 * ARCHITECTURE EXCEPTION — INTENTIONAL CLOUD SERVICE
 * =====================================================
 * Firebase (Auth + Firestore) is an intentional cloud dependency used for:
 *   - User authentication (Google sign-in)
 *   - Preset cloud sync (optional, user-initiated)
 *   - Session logging for billing/tier enforcement
 *   - Optional Google Drive file I/O scopes (user-initiated import/export only)
 *
 * ALL AUDIO PROCESSING is 100% local and never touches Firebase or Drive.
 * Firebase/Drive are never called from AudioWorklet, ml-worker, or dsp-* files.
 *
 * Documented in ADR-001 and ADR-002 (Drive file I/O).
 */

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getAuth, onAuthStateChanged, signInWithPopup, GoogleAuthProvider, signOut } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { getFirestore, doc, getDoc, setDoc, updateDoc, collection, addDoc, query, where, orderBy, getDocs } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

const firebaseConfig = {
  apiKey: window.FIREBASE_API_KEY || 'YOUR_API_KEY',
  authDomain: window.FIREBASE_AUTH_DOMAIN || 'voiceisolate-pro.firebaseapp.com',
  projectId: window.FIREBASE_PROJECT_ID || 'voiceisolate-pro',
  storageBucket: window.FIREBASE_STORAGE_BUCKET || 'voiceisolate-pro.appspot.com',
  messagingSenderId: window.FIREBASE_MESSAGING_SENDER_ID || 'YOUR_SENDER_ID',
  appId: window.FIREBASE_APP_ID || 'YOUR_APP_ID'
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

/** Least-privilege Drive scope — only files created or opened by this app. */
export const GOOGLE_DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

function isFirebaseConfigured() {
  const key = firebaseConfig.apiKey;
  return Boolean(key && key !== 'YOUR_API_KEY');
}

// ---- Auth helpers ----
export async function signInWithGoogle() {
  if (!isFirebaseConfigured()) {
    throw new Error('Firebase is not configured (set window.FIREBASE_API_KEY).');
  }
  const provider = new GoogleAuthProvider();
  return signInWithPopup(auth, provider);
}

/**
 * Google sign-in with Drive file scope. Returns accessToken for Drive REST/Picker.
 * User-initiated only — never call from Process / ML / worklets.
 */
export async function signInWithGoogleDrive() {
  if (!isFirebaseConfigured()) {
    throw new Error('Firebase is not configured (set window.FIREBASE_API_KEY).');
  }
  const provider = new GoogleAuthProvider();
  provider.addScope(GOOGLE_DRIVE_FILE_SCOPE);
  provider.setCustomParameters({ prompt: 'consent' });
  const result = await signInWithPopup(auth, provider);
  const credential = GoogleAuthProvider.credentialFromResult(result);
  const accessToken = credential?.accessToken || null;
  if (!accessToken) {
    throw new Error('Google Drive permission was not granted (missing access token).');
  }
  try {
    if (typeof globalThis !== 'undefined') {
      globalThis.__vipGoogleDriveAccessToken = accessToken;
    }
  } catch { /* ignore */ }
  return { user: result.user, accessToken, credential, result };
}

export function signOutUser() {
  try {
    if (typeof globalThis !== 'undefined') delete globalThis.__vipGoogleDriveAccessToken;
  } catch { /* ignore */ }
  return signOut(auth);
}

// Hook used by GoogleDriveBridge.ensureGoogleDriveAuth()
if (typeof globalThis !== 'undefined') {
  globalThis.__vipSignInGoogleDrive = async () => {
    const out = await signInWithGoogleDrive();
    return { accessToken: out.accessToken, user: out.user };
  };
}

export function onAuthChange(callback) {
  return onAuthStateChanged(auth, callback);
}

// ---- User document helpers ----
export async function getUserDoc(uid) {
  const ref = doc(db, 'users', uid);
  const snap = await getDoc(ref);
  return snap.exists() ? snap.data() : null;
}

export async function createUserDoc(uid, data) {
  const ref = doc(db, 'users', uid);
  return setDoc(ref, { tier: 'FREE', createdAt: new Date(), ...data }, { merge: true });
}

export async function updateUserDoc(uid, data) {
  const ref = doc(db, 'users', uid);
  return updateDoc(ref, data);
}

// ---- Presets helpers ----
export async function savePreset(userId, preset) {
  return addDoc(collection(db, 'presets'), { userId, ...preset, updatedAt: new Date() });
}

export async function getUserPresets(userId) {
  const q = query(collection(db, 'presets'), where('userId', '==', userId), orderBy('updatedAt', 'desc'));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// ---- Session logging ----
export async function logSession(userId, sessionData) {
  return addDoc(collection(db, 'sessions'), { userId, createdAt: new Date(), ...sessionData });
}

export default app;
