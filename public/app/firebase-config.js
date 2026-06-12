// Firebase Client Configuration for VoiceIsolate Pro
// Replace the placeholder values below with your actual Firebase project credentials
// from the Firebase Console: https://console.firebase.google.com

/**
 * ARCHITECTURE EXCEPTION — INTENTIONAL CLOUD SERVICE
 * =====================================================
 * Firebase (Auth + Firestore) is the ONLY intentional cloud dependency
 * in VoiceIsolate Pro. It is used exclusively for:
 *   - User authentication (Google sign-in)
 *   - Preset cloud sync (optional, user-initiated)
 *   - Session logging for billing/tier enforcement
 *
 * ALL AUDIO PROCESSING is 100% local and never touches Firebase.
 * Firebase is never called from AudioWorklet, ml-worker, or dsp-* files.
 *
 * This exception is documented in ADR-001 (docs/adr/001-firebase-exception.md).
 */

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getAuth, onAuthStateChanged, signInWithPopup, GoogleAuthProvider, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
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

// ---- Auth helpers ----
export async function signInWithGoogle() {
  const provider = new GoogleAuthProvider();
  return signInWithPopup(auth, provider);
}

export async function signUpWithEmail(email, password) {
  return createUserWithEmailAndPassword(auth, email, password);
}

export async function signInWithEmail(email, password) {
  return signInWithEmailAndPassword(auth, email, password);
}

export function signOutUser() {
  return signOut(auth);
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
