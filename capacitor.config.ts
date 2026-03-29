import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.voiceisolatepro.app',
  appName: 'VoiceIsolate Pro',
  webDir: 'build',
  server: {
    androidScheme: 'https',
    // Allow cross-origin isolation headers needed for SharedArrayBuffer
    cleartext: false,
  },
  android: {
    allowMixedContent: false,
    captureInput: true,
    webContentsDebuggingEnabled: false,
    // Required for AudioWorklet + SharedArrayBuffer on Android
    appendUserAgent: 'VoiceIsolatePro/21.0',
  },
  ios: {
    contentInset: 'automatic',
    allowsLinkPreview: false,
    scrollEnabled: true,
    appendUserAgent: 'VoiceIsolatePro/21.0',
  },
  plugins: {
    // No native plugins needed — all processing is in-browser WebAssembly
  },
};

export default config;
