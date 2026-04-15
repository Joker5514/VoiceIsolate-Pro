// public/app/mediapipe-lip-sync.js
// MediaPipe FaceMesh lip-motion monitor for covert speaker cross-validation.
// Sends { active: bool } to covert-detector worker every animation frame.
// Requires: @mediapipe/face_mesh CDN script loaded in HTML.

export class LipSyncMonitor {
  #faceMesh    = null;
  #videoEl     = null;
  #worker      = null;
  #raf         = null;
  #lastActive  = false;

  static UPPER_LIP_IDX = 13;
  static LOWER_LIP_IDX = 14;
  static MAR_THRESHOLD = 0.018;

  async init(videoElement, covertWorker) {
    this.#videoEl = videoElement;
    this.#worker  = covertWorker;

    this.#faceMesh = new window.FaceMesh({
      locateFile: file =>
        `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`
    });

    this.#faceMesh.setOptions({
      maxNumFaces:            1,
      refineLandmarks:        true,
      minDetectionConfidence: 0.5,
      minTrackingConfidence:  0.5
    });

    this.#faceMesh.onResults(results => this.#onFaceResults(results));
    await this.#faceMesh.initialize();
    this.#startLoop();
  }

  #onFaceResults(results) {
    if (!results.multiFaceLandmarks || results.multiFaceLandmarks.length === 0) {
      this.#updateWorker(false);
      return;
    }
    const landmarks = results.multiFaceLandmarks[0];
    const upper = landmarks[LipSyncMonitor.UPPER_LIP_IDX];
    const lower = landmarks[LipSyncMonitor.LOWER_LIP_IDX];
    const mar = Math.abs(upper.y - lower.y);
    const isOpen = mar > LipSyncMonitor.MAR_THRESHOLD;
    if (isOpen !== this.#lastActive) {
      this.#lastActive = isOpen;
      this.#updateWorker(isOpen);
    }
  }

  #updateWorker(active) {
    this.#worker?.postMessage({ type: 'lipMotion', payload: { active } });
  }

  #startLoop() {
    const tick = async () => {
      if (this.#videoEl && !this.#videoEl.paused && !this.#videoEl.ended) {
        await this.#faceMesh.send({ image: this.#videoEl });
      }
      this.#raf = requestAnimationFrame(tick);
    };
    this.#raf = requestAnimationFrame(tick);
  }

  dispose() {
    if (this.#raf) cancelAnimationFrame(this.#raf);
    this.#faceMesh?.close();
  }
}
