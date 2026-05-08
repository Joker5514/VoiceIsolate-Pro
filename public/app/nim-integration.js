export class NimIntegration {
    constructor(videoElement, canvasOverlayElement) {
        this.videoEl = videoElement;
        this.canvasOverlay = canvasOverlayElement;
        this.ctx = this.canvasOverlay.getContext('2d');
        this.isActive = false;
        this.processingInterval = null;
        this.frameRate = 15; // Process ~15 fps
    }

    start(stream) {
        this.videoEl.srcObject = stream;
        this.videoEl.play();
        this.isActive = true;

        // Sync canvas size with video
        this.videoEl.addEventListener('loadedmetadata', () => {
            this.canvasOverlay.width = this.videoEl.videoWidth;
            this.canvasOverlay.height = this.videoEl.videoHeight;
        });

        this.startProcessingLoop();
    }

    stop() {
        this.isActive = false;
        if (this.processingInterval) {
            clearInterval(this.processingInterval);
            this.processingInterval = null;
        }
        if (this.videoEl.srcObject) {
            this.videoEl.srcObject.getTracks().forEach(t => t.stop());
            this.videoEl.srcObject = null;
        }
        this.clearOverlay();
    }

    startProcessingLoop() {
        this.processingInterval = setInterval(async () => {
            if (!this.isActive || this.videoEl.paused || this.videoEl.ended) return;

            try {
                // 1. Extract 112x112 grayscale face crop
                const videoData = this.captureVideoFrame();

                // 2. Mock extracting MFCC and Audio data (in reality we would get this from AudioPipeline)
                const mockAudioBuffer = new Float32Array(1024);
                const mockMfcc = new Float32Array(13);

                // 3. Send to API
                const response = await fetch('/api/nim/detect', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        video: Array.from(videoData), // Simple encoding for mockup
                        audio: Array.from(mockAudioBuffer),
                        mfcc: Array.from(mockMfcc)
                    })
                });

                if (response.ok) {
                    const result = await response.json();
                    if (result.success && result.data.frames) {
                        this.drawOverlay(result.data.frames[0]);
                    }
                }
            } catch (err) {
                console.error("NIM processing error:", err);
            }
        }, 1000 / this.frameRate);
    }

    captureVideoFrame() {
        // Create a temporary canvas to get 112x112 grayscale crop
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = 112;
        tempCanvas.height = 112;
        const tCtx = tempCanvas.getContext('2d');

        // Draw centered crop
        const minDim = Math.min(this.videoEl.videoWidth, this.videoEl.videoHeight);
        const sx = (this.videoEl.videoWidth - minDim) / 2;
        const sy = (this.videoEl.videoHeight - minDim) / 2;

        tCtx.drawImage(this.videoEl, sx, sy, minDim, minDim, 0, 0, 112, 112);

        // Convert to grayscale
        const imgData = tCtx.getImageData(0, 0, 112, 112);
        const data = imgData.data;
        const grayscale = new Uint8Array(112 * 112);
        for (let i = 0, j=0; i < data.length; i += 4, j++) {
            // Rec. 601 Luma
            grayscale[j] = data[i] * 0.299 + data[i+1] * 0.587 + data[i+2] * 0.114;
        }
        return grayscale;
    }

    drawOverlay(frameData) {
        this.clearOverlay();
        const { bounding_box: box, speaking_score, landmarks } = frameData;

        if (!box) return;

        // Scale box from 112x112 back to video size (simplified mapping for demo)
        const minDim = Math.min(this.canvasOverlay.width, this.canvasOverlay.height);
        const offsetX = (this.canvasOverlay.width - minDim) / 2;
        const offsetY = (this.canvasOverlay.height - minDim) / 2;
        const scale = minDim / 112;

        const x = offsetX + (box.x1 * scale);
        const y = offsetY + (box.y1 * scale);
        const w = (box.x2 - box.x1) * scale;
        const h = (box.y2 - box.y1) * scale;

        // Draw bounding box
        this.ctx.lineWidth = 3;
        this.ctx.strokeStyle = speaking_score > 0.0 ? '#22c55e' : '#ef4444'; // Green if speaking, red if not
        this.ctx.strokeRect(x, y, w, h);

        // Draw label
        this.ctx.fillStyle = this.ctx.strokeStyle;
        this.ctx.font = '16px sans-serif';
        const label = `Speaker: ${speaking_score > 0 ? 'Yes' : 'No'} (${speaking_score.toFixed(2)})`;
        this.ctx.fillText(label, x, y - 5);

        // Draw landmarks
        if (landmarks) {
            this.ctx.fillStyle = '#3b82f6'; // Blue for landmarks
            landmarks.forEach(lm => {
                const lx = offsetX + (lm.x * scale);
                const ly = offsetY + (lm.y * scale);
                this.ctx.beginPath();
                this.ctx.arc(lx, ly, 3, 0, 2 * Math.PI);
                this.ctx.fill();
            });
        }
    }

    clearOverlay() {
        this.ctx.clearRect(0, 0, this.canvasOverlay.width, this.canvasOverlay.height);
    }
}
