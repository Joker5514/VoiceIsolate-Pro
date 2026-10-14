// sw-boot.js — VoiceIsolate Pro
// Loaded as a module by Landing (/index.html) and Engineer (/app/index.html):
// registers the offline service worker after the page's load event.
// http(s) only; Android packages and Electron skip it (see sw-register.js).
import { registerSWAfterLoad } from './sw-register.js';

registerSWAfterLoad();
