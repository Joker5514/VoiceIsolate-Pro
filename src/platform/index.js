/**
 * VoiceIsolate-Pro — Platform Adapters Index
 * Unified entry for Browser, Android, Desktop
 */

import { BrowserAdapter } from './browser/BrowserAdapter.js';
import { AndroidAdapter } from './android/AndroidAdapter.js';
import { DesktopAdapter } from './desktop/DesktopAdapter.js';
import { getAudioSessionStore } from '../state/audioSessionStore.js';
import { getUIStore } from '../state/uiStore.js';

export function detectPlatform() {
  try {
    const ua = (typeof navigator !== 'undefined' ? navigator.userAgent : '') || '';
    if (/Android/i.test(ua)) return 'android';
    if (typeof window !== 'undefined' && (window.__VIP_DESKTOP__ || ua.includes('Electron'))) return 'desktop';
    return 'browser';
  } catch {
    return 'browser';
  }
}

export function createPlatformAdapter(platform = null, sessionStore = null, uiStore = null) {
  const plat = platform || detectPlatform();
  const sStore = sessionStore || getAudioSessionStore();
  const uStore = uiStore || getUIStore();

  switch (plat) {
    case 'android':
      return new AndroidAdapter(sStore, uStore);
    case 'desktop':
      return new DesktopAdapter(sStore, uStore);
    case 'browser':
    default:
      return new BrowserAdapter(sStore, uStore);
  }
}

export { BrowserAdapter, AndroidAdapter, DesktopAdapter };
export default { detectPlatform, createPlatformAdapter };
