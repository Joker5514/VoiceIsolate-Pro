/**
 * One HTML media element for recordings that are not held as a full AudioBuffer.
 * Landing and Engineer share this clock. It does not start a second mixer.
 */
'use strict';

export function createMediaTransport({ onEnded } = {}) {
  const audio = typeof Audio !== 'undefined' ? new Audio() : null;
  let url = null;
  let source = 'original';
  let active = false;
  if (audio) {
    audio.preload = 'auto';
    audio.addEventListener('ended', () => {
      try { onEnded?.(); } catch { /* UI owns the message */ }
    });
  }

  function revoke(next) {
    if (url && url !== next && url.startsWith('blob:') && typeof URL !== 'undefined') {
      try { URL.revokeObjectURL(url); } catch { /* already revoked */ }
    }
  }

  return {
    active() { return active; },
    source() { return source; },
    currentTime() { return audio ? audio.currentTime || 0 : 0; },
    duration() {
      const d = audio?.duration;
      return Number.isFinite(d) ? d : 0;
    },
    isPlaying() { return !!(audio && !audio.paused && !audio.ended); },
    async use(blobOrUrl, nextSource = source) {
      if (!audio || blobOrUrl == null) return false;
      const next = typeof blobOrUrl === 'string' ? blobOrUrl : URL.createObjectURL(blobOrUrl);
      const keep = audio.currentTime || 0;
      audio.pause();
      if (next !== url) {
        revoke(next);
        url = next;
        audio.src = next;
        await new Promise((resolve) => {
          const done = () => {
            audio.removeEventListener('loadedmetadata', done);
            audio.removeEventListener('error', done);
            resolve();
          };
          audio.addEventListener('loadedmetadata', done);
          audio.addEventListener('error', done);
        });
      }
      source = nextSource;
      active = true;
      if (keep > 0 && Number.isFinite(audio.duration)) {
        audio.currentTime = Math.min(keep, Math.max(0, audio.duration - 0.01));
      }
      return true;
    },
    async play() {
      if (!audio) return;
      await audio.play();
    },
    pause() { audio?.pause(); },
    stop() {
      if (!audio) return;
      audio.pause();
      audio.currentTime = 0;
    },
    seek(seconds) {
      if (!audio || !Number.isFinite(seconds)) return;
      const dur = Number.isFinite(audio.duration) ? audio.duration : seconds;
      audio.currentTime = Math.max(0, Math.min(seconds, dur));
    },
    close() {
      if (audio) {
        audio.pause();
        audio.removeAttribute('src');
        try { audio.load(); } catch { /* ignore */ }
      }
      revoke(null);
      url = null;
      active = false;
    },
  };
}
