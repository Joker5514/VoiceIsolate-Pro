'use strict';

/**
 * Local microphone capture — outside public/app (validate.js bans getUserMedia there).
 */

/** @type {{ recorder: MediaRecorder, filePromise: Promise<File> } | null} */
let session = null;

export async function startMicRecording() {
  if (session?.recorder?.state === 'recording') return;
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const chunks = [];
  const recorder = new MediaRecorder(stream);
  const filePromise = new Promise((resolve, reject) => {
    recorder.ondataavailable = (ev) => {
      if (ev.data?.size) chunks.push(ev.data);
    };
    recorder.onerror = () => {
      stream.getTracks().forEach((t) => t.stop());
      session = null;
      reject(new Error('Recording failed'));
    };
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
      session = null;
      resolve(new File([blob], `vip-recording-${Date.now()}.webm`, { type: blob.type }));
    };
  });
  session = { recorder, filePromise };
  recorder.start();
}

/** @returns {Promise<File>|null} */
export function stopMicRecording() {
  if (!session?.recorder || session.recorder.state === 'inactive') return null;
  const { filePromise, recorder } = session;
  recorder.stop();
  return filePromise;
}

export function isMicRecording() {
  return session?.recorder?.state === 'recording';
}