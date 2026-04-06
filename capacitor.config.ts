import type { CapacitorConfig } from '@capacitor/cli';

// FIX 11: canonical Capacitor config — capacitor.config.json deleted to avoid dual-config conflict
const config: CapacitorConfig = {
  appId: 'pro.voiceisolate.app',
  appName: 'VoiceIsolate Pro',
  webDir: 'build',
  server: {
    androidScheme: 'https', // required for SharedArrayBuffer on Android
    cleartext: false,
  },
  android: {
    allowMixedContent: false,
    captureInput: true,
    webContentsDebuggingEnabled: false,
    // Required for AudioWorklet + SharedArrayBuffer on Android
    appendUserAgent: 'VoiceIsolatePro/22.1',
    backgroundColor: '#0a0a0f',
    minWebViewVersion: 90,
  },
  ios: {
    contentInset: 'automatic',
    allowsLinkPreview: false,
    scrollEnabled: true,
    appendUserAgent: 'VoiceIsolatePro/22.1',
    backgroundColor: '#0a0a0f',
    preferredContentMode: 'mobile',
    limitsNavigationsToAppBoundDomains: true,
    webContentsDebuggingEnabled: false,
  },
  plugins: {
    // No native plugins needed — all processing is in-browser WebAssembly
    SplashScreen: {
      launchShowDuration: 2000,
      launchAutoHide: true,
      backgroundColor: '#0a0a0f',
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#0a0a0f',
    },
    Keyboard: {
      resize: 'body',
      resizeOnFullScreen: true,
    },
  },
};

export default config;
