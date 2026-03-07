/**
 * VoiceIsolate Pro v9.0 - Visualization Engine
 * Canvas-based waveform, spectrogram, and real-time visualizations.
 * High-DPI aware with professional rendering quality.
 */

export class Visualizer {
  /**
   * @param {string} containerId - ID of the container element holding canvases
   */
  constructor(containerId) {
    this._containerId = containerId;
    this._container = null;

    /** @type {Map<string, HTMLCanvasElement>} */
    this._canvases = new Map();

    /** @type {Map<string, CanvasRenderingContext2D>} */
    this._contexts = new Map();

    this._dpr = window.devicePixelRatio || 1;
    this._mode = 'waveform'; // 'waveform' | 'spectrogram' | 'spectrum'
    this._realtimeAnimId = null;
    this._realtimeAnalyser = null;
    this._resizeObserver = null;
    this._destroyed = false;

    // Color constants
    this._bgColor = '#0a0e12';
    this._gridColor = 'rgba(255, 255, 255, 0.06)';
    this._gridTextColor = 'rgba(255, 255, 255, 0.35)';
    this._centerLineColor = 'rgba(255, 255, 255, 0.08)';
    this._placeholderColor = 'rgba(255, 255, 255, 0.2)';
  }

  /**
   * Initialize the visualizer: locate canvases, set up contexts, attach resize handling.
   */
  init() {
    this._container = document.getElementById(this._containerId);
    if (!this._container) {
      console.warn(`[Visualizer] Container #${this._containerId} not found`);
      return;
    }

    // Discover all canvases inside the container
    const canvasEls = this._container.querySelectorAll('canvas[data-viz]');
    for (const canvas of canvasEls) {
      const id = canvas.dataset.viz;
      this._canvases.set(id, canvas);
      const ctx = canvas.getContext('2d', { alpha: false });
      this._contexts.set(id, ctx);
      this._setupCanvas(canvas);
    }

    // Fallback: look for well-known IDs if no data-viz canvases exist
    if (this._canvases.size === 0) {
      for (const name of ['original', 'processed', 'realtime', 'spectrum']) {
        const el = document.getElementById(`canvas-${name}`);
        if (el) {
          this._canvases.set(name, el);
          const ctx = el.getContext('2d', { alpha: false });
          this._contexts.set(name, ctx);
          this._setupCanvas(el);
        }
      }
    }

    // ResizeObserver for responsive canvases
    this._resizeObserver = new ResizeObserver(() => {
      if (!this._destroyed) {
        this.resize();
      }
    });
    this._resizeObserver.observe(this._container);

    // Clear all canvases initially
    for (const id of this._canvases.keys()) {
      this.clear(id);
    }
  }

  // ---------------------------------------------------------------------------
  // Waveform Drawing
  // ---------------------------------------------------------------------------

  /**
   * Draw a static waveform from a Float32Array audio buffer.
   * Uses min/max aggregation per pixel column for accurate representation.
   * @param {string} canvasId - Target canvas identifier
   * @param {Float32Array} audioData - Audio samples (typically -1..1)
   * @param {string} [color='#00d4aa'] - Waveform stroke color
   */
  drawWaveform(canvasId, audioData, color = '#00d4aa') {
    const canvas = this._canvases.get(canvasId);
    const ctx = this._contexts.get(canvasId);
    if (!canvas || !ctx || !audioData || audioData.length === 0) return;

    const w = canvas.width;
    const h = canvas.height;
    const dpr = this._dpr;
    const displayW = w / dpr;
    const displayH = h / dpr;

    // Background
    ctx.fillStyle = this._bgColor;
    ctx.fillRect(0, 0, w, h);

    // Grid
    this._drawGrid(
      ctx, w, h,
      this._generateTimeLabels(audioData.length, 44100, displayW),
      ['-1.0', '-0.5', '0', '0.5', '1.0']
    );

    // Center line
    ctx.strokeStyle = this._centerLineColor;
    ctx.lineWidth = dpr;
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();

    // Compute min/max per pixel column
    const samplesPerPixel = audioData.length / displayW;
    const midY = h / 2;
    const amplitude = (h / 2) * 0.9; // 90% of half-height for headroom

    // Glow effect (draw wider translucent line underneath)
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = 6 * dpr;
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.3;
    ctx.lineWidth = 3 * dpr;
    ctx.beginPath();
    this._traceMinMaxWaveform(ctx, audioData, displayW, samplesPerPixel, midY, amplitude, dpr);
    ctx.stroke();
    ctx.restore();

    // Main waveform fill (min/max envelope)
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.45;
    ctx.beginPath();
    this._traceEnvelopePath(ctx, audioData, displayW, samplesPerPixel, midY, amplitude, dpr);
    ctx.fill();
    ctx.globalAlpha = 1.0;

    // Sharp center line of waveform
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.0 * dpr;
    ctx.shadowColor = color;
    ctx.shadowBlur = 4 * dpr;
    ctx.beginPath();
    this._traceMinMaxWaveform(ctx, audioData, displayW, samplesPerPixel, midY, amplitude, dpr);
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Peak indicators
    this._drawPeakIndicators(ctx, audioData, displayW, samplesPerPixel, midY, amplitude, dpr, color);
  }

  /**
   * Trace the center-of-range waveform path (average of min and max per column).
   */
  _traceMinMaxWaveform(ctx, data, displayW, samplesPerPixel, midY, amplitude, dpr) {
    let moved = false;
    for (let px = 0; px < displayW; px++) {
      const start = Math.floor(px * samplesPerPixel);
      const end = Math.min(Math.floor((px + 1) * samplesPerPixel), data.length);
      let min = 1.0;
      let max = -1.0;
      for (let i = start; i < end; i++) {
        const s = data[i];
        if (s < min) min = s;
        if (s > max) max = s;
      }
      const avgY = midY - ((min + max) / 2) * amplitude;
      const x = px * dpr;
      if (!moved) {
        ctx.moveTo(x, avgY);
        moved = true;
      } else {
        ctx.lineTo(x, avgY);
      }
    }
  }

  /**
   * Trace the filled envelope path (min on top pass, max on bottom pass).
   */
  _traceEnvelopePath(ctx, data, displayW, samplesPerPixel, midY, amplitude, dpr) {
    const mins = [];
    const maxs = [];
    for (let px = 0; px < displayW; px++) {
      const start = Math.floor(px * samplesPerPixel);
      const end = Math.min(Math.floor((px + 1) * samplesPerPixel), data.length);
      let min = 1.0;
      let max = -1.0;
      for (let i = start; i < end; i++) {
        const s = data[i];
        if (s < min) min = s;
        if (s > max) max = s;
      }
      mins.push(min);
      maxs.push(max);
    }

    // Top edge (max values, which render upward since Y is inverted)
    ctx.moveTo(0, midY - maxs[0] * amplitude);
    for (let px = 1; px < displayW; px++) {
      ctx.lineTo(px * dpr, midY - maxs[px] * amplitude);
    }
    // Bottom edge (min values, going right to left)
    for (let px = displayW - 1; px >= 0; px--) {
      ctx.lineTo(px * dpr, midY - mins[px] * amplitude);
    }
    ctx.closePath();
  }

  /**
   * Mark samples that exceed 0.98 magnitude.
   */
  _drawPeakIndicators(ctx, data, displayW, samplesPerPixel, midY, amplitude, dpr, color) {
    const peakThreshold = 0.98;
    ctx.fillStyle = '#ff4466';
    for (let px = 0; px < displayW; px++) {
      const start = Math.floor(px * samplesPerPixel);
      const end = Math.min(Math.floor((px + 1) * samplesPerPixel), data.length);
      let hasPeak = false;
      for (let i = start; i < end; i++) {
        if (Math.abs(data[i]) >= peakThreshold) {
          hasPeak = true;
          break;
        }
      }
      if (hasPeak) {
        const x = px * dpr;
        ctx.fillRect(x - dpr, 0, 2 * dpr, 3 * dpr);
        ctx.fillRect(x - dpr, midY * 2 - 3 * dpr, 2 * dpr, 3 * dpr);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Spectrogram Drawing
  // ---------------------------------------------------------------------------

  /**
   * Draw a spectrogram from a 2D magnitude array.
   * Uses log-frequency scale and a perceptual colormap.
   * @param {string} canvasId - Target canvas identifier
   * @param {Array<Float32Array>} spectralData - Array of magnitude frames (each N/2+1)
   * @param {number} sampleRate - Audio sample rate in Hz
   */
  drawSpectrogram(canvasId, spectralData, sampleRate) {
    const canvas = this._canvases.get(canvasId);
    const ctx = this._contexts.get(canvasId);
    if (!canvas || !ctx || !spectralData || spectralData.length === 0) return;

    const w = canvas.width;
    const h = canvas.height;
    const dpr = this._dpr;
    const displayW = w / dpr;
    const displayH = h / dpr;

    const numFrames = spectralData.length;
    const numBins = spectralData[0].length;
    const nyquist = sampleRate / 2;

    // Compute global max for normalization
    let globalMax = -Infinity;
    for (let f = 0; f < numFrames; f++) {
      for (let b = 0; b < numBins; b++) {
        if (spectralData[f][b] > globalMax) globalMax = spectralData[f][b];
      }
    }
    if (globalMax <= 0) globalMax = 1;

    // Create image data
    const imgData = ctx.createImageData(w, h);
    const pixels = imgData.data;

    // Minimum frequency for log scale (avoid log(0))
    const minFreqHz = 20;
    const logMin = Math.log10(minFreqHz);
    const logMax = Math.log10(nyquist);
    const logRange = logMax - logMin;

    for (let py = 0; py < h; py++) {
      // Map pixel Y to frequency (bottom = low freq, top inverted)
      const normalizedY = 1.0 - py / h;
      const logFreq = logMin + normalizedY * logRange;
      const freq = Math.pow(10, logFreq);
      const binFloat = (freq / nyquist) * (numBins - 1);
      const binLow = Math.floor(binFloat);
      const binHigh = Math.min(binLow + 1, numBins - 1);
      const binFrac = binFloat - binLow;

      for (let px = 0; px < w; px++) {
        // Map pixel X to frame
        const frameFloat = (px / w) * (numFrames - 1);
        const frameLow = Math.floor(frameFloat);
        const frameHigh = Math.min(frameLow + 1, numFrames - 1);
        const frameFrac = frameFloat - frameLow;

        // Bilinear interpolation
        const v00 = spectralData[frameLow][binLow];
        const v01 = spectralData[frameLow][binHigh];
        const v10 = spectralData[frameHigh][binLow];
        const v11 = spectralData[frameHigh][binHigh];
        const vTop = v00 + (v01 - v00) * binFrac;
        const vBot = v10 + (v11 - v10) * binFrac;
        const value = vTop + (vBot - vTop) * frameFrac;

        // Convert to dB scale, normalize
        const db = 20 * Math.log10(Math.max(value / globalMax, 1e-10));
        const normalized = Math.max(0, Math.min(1, (db + 100) / 100)); // -100dB..0dB

        const [r, g, b] = this._getColor(normalized, 0, 1);
        const idx = (py * w + px) * 4;
        pixels[idx] = r;
        pixels[idx + 1] = g;
        pixels[idx + 2] = b;
        pixels[idx + 3] = 255;
      }
    }

    ctx.putImageData(imgData, 0, 0);

    // Frequency axis labels
    const freqLabels = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]
      .filter(f => f <= nyquist);

    ctx.font = `${10 * dpr}px monospace`;
    ctx.fillStyle = this._gridTextColor;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    for (const freq of freqLabels) {
      const logPos = (Math.log10(freq) - logMin) / logRange;
      const py = (1.0 - logPos) * h;
      if (py < 10 * dpr || py > h - 10 * dpr) continue;

      // Tick line
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
      ctx.lineWidth = dpr;
      ctx.beginPath();
      ctx.moveTo(0, py);
      ctx.lineTo(w, py);
      ctx.stroke();

      // Label background for readability
      const label = this._formatFreq(freq);
      const textW = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(10, 14, 18, 0.7)';
      ctx.fillRect(w - textW - 8 * dpr, py - 7 * dpr, textW + 6 * dpr, 14 * dpr);

      ctx.fillStyle = this._gridTextColor;
      ctx.fillText(label, w - 4 * dpr, py);
    }
  }

  // ---------------------------------------------------------------------------
  // Real-time Visualizations
  // ---------------------------------------------------------------------------

  /**
   * Draw a real-time oscilloscope waveform from an AnalyserNode.
   * @param {string} canvasId - Target canvas identifier
   * @param {AnalyserNode} analyserNode - Web Audio AnalyserNode
   */
  drawRealtimeWaveform(canvasId, analyserNode) {
    const canvas = this._canvases.get(canvasId);
    const ctx = this._contexts.get(canvasId);
    if (!canvas || !ctx || !analyserNode) return;

    const bufferLength = analyserNode.fftSize;
    const dataArray = new Float32Array(bufferLength);

    const draw = () => {
      if (this._destroyed) return;
      this._realtimeAnimId = requestAnimationFrame(draw);

      analyserNode.getFloatTimeDomainData(dataArray);

      const w = canvas.width;
      const h = canvas.height;
      const dpr = this._dpr;

      // Background
      ctx.fillStyle = this._bgColor;
      ctx.fillRect(0, 0, w, h);

      // Center line
      ctx.strokeStyle = this._centerLineColor;
      ctx.lineWidth = dpr;
      ctx.beginPath();
      ctx.moveTo(0, h / 2);
      ctx.lineTo(w, h / 2);
      ctx.stroke();

      // Waveform glow
      ctx.shadowColor = '#00ff88';
      ctx.shadowBlur = 4 * dpr;
      ctx.strokeStyle = '#00ff88';
      ctx.lineWidth = 1.5 * dpr;
      ctx.beginPath();

      const sliceWidth = w / bufferLength;
      let x = 0;
      for (let i = 0; i < bufferLength; i++) {
        const v = dataArray[i];
        const y = (h / 2) - v * (h / 2) * 0.9;
        if (i === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
        x += sliceWidth;
      }
      ctx.stroke();
      ctx.shadowBlur = 0;

      // Level indicator (RMS)
      let rms = 0;
      for (let i = 0; i < bufferLength; i++) {
        rms += dataArray[i] * dataArray[i];
      }
      rms = Math.sqrt(rms / bufferLength);
      const levelDb = 20 * Math.log10(Math.max(rms, 1e-10));
      const levelText = `${levelDb.toFixed(1)} dB`;

      ctx.font = `${11 * dpr}px monospace`;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(levelText, 6 * dpr, 6 * dpr);
    };

    draw();
  }

  /**
   * Draw a real-time frequency spectrum with logarithmically grouped bars.
   * @param {string} canvasId - Target canvas identifier
   * @param {AnalyserNode} analyserNode - Web Audio AnalyserNode
   */
  drawRealtimeSpectrum(canvasId, analyserNode) {
    const canvas = this._canvases.get(canvasId);
    const ctx = this._contexts.get(canvasId);
    if (!canvas || !ctx || !analyserNode) return;

    const fftSize = analyserNode.frequencyBinCount;
    const dataArray = new Uint8Array(fftSize);

    // Pre-compute logarithmic frequency band edges for ~64 bars
    const numBars = 64;
    const bands = this._computeLogBands(numBars, fftSize, analyserNode.context.sampleRate);

    // Smoothed bar heights for animation
    const smoothed = new Float32Array(numBars);

    const draw = () => {
      if (this._destroyed) return;
      this._realtimeAnimId = requestAnimationFrame(draw);

      analyserNode.getByteFrequencyData(dataArray);

      const w = canvas.width;
      const h = canvas.height;
      const dpr = this._dpr;
      const displayW = w / dpr;

      // Background
      ctx.fillStyle = this._bgColor;
      ctx.fillRect(0, 0, w, h);

      const barWidth = (w / numBars) * 0.8;
      const barGap = (w / numBars) * 0.2;
      const maxBarHeight = h * 0.9;

      // Create gradient for bars
      const gradient = ctx.createLinearGradient(0, h, 0, 0);
      gradient.addColorStop(0, '#00d4aa');
      gradient.addColorStop(0.5, '#00e0c0');
      gradient.addColorStop(0.8, '#44ff88');
      gradient.addColorStop(1.0, '#88ffaa');

      for (let i = 0; i < numBars; i++) {
        // Average the bins in this band
        const { startBin, endBin } = bands[i];
        let sum = 0;
        let count = 0;
        for (let b = startBin; b <= endBin && b < fftSize; b++) {
          sum += dataArray[b];
          count++;
        }
        const avg = count > 0 ? sum / count : 0;
        const normalized = avg / 255;

        // Smooth the bar height (exponential moving average)
        const target = normalized * maxBarHeight;
        smoothed[i] += (target - smoothed[i]) * 0.3;
        const barHeight = smoothed[i];

        const x = i * (barWidth + barGap) + barGap / 2;

        // Bar shadow / glow
        ctx.shadowColor = '#00d4aa';
        ctx.shadowBlur = 3 * dpr;

        // Bar fill
        ctx.fillStyle = gradient;
        ctx.fillRect(x, h - barHeight, barWidth, barHeight);

        // Bright cap on top of bar
        ctx.shadowBlur = 0;
        ctx.fillStyle = '#aaffdd';
        ctx.fillRect(x, h - barHeight, barWidth, Math.min(2 * dpr, barHeight));
      }

      ctx.shadowBlur = 0;

      // Frequency labels at bottom
      ctx.font = `${9 * dpr}px monospace`;
      ctx.fillStyle = this._gridTextColor;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      const labelFreqs = [100, 500, 1000, 5000, 10000];
      const sampleRate = analyserNode.context.sampleRate;
      for (const freq of labelFreqs) {
        // Find which bar index corresponds to this frequency
        for (let i = 0; i < numBars; i++) {
          const bandCenterBin = (bands[i].startBin + bands[i].endBin) / 2;
          const bandCenterFreq = (bandCenterBin / fftSize) * (sampleRate / 2);
          if (Math.abs(bandCenterFreq - freq) / freq < 0.3) {
            const x = i * (barWidth + barGap) + barWidth / 2 + barGap / 2;
            ctx.fillText(this._formatFreq(freq), x, h - 2 * dpr);
            break;
          }
        }
      }
    };

    draw();
  }

  /**
   * Compute logarithmically spaced frequency band bin ranges.
   * @param {number} numBands - Number of output bands
   * @param {number} fftBins - Number of FFT bins (frequencyBinCount)
   * @param {number} sampleRate - Sample rate in Hz
   * @returns {Array<{startBin: number, endBin: number}>}
   */
  _computeLogBands(numBands, fftBins, sampleRate) {
    const bands = [];
    const nyquist = sampleRate / 2;
    const minFreq = 20;
    const logMin = Math.log10(minFreq);
    const logMax = Math.log10(nyquist);
    const logStep = (logMax - logMin) / numBands;

    for (let i = 0; i < numBands; i++) {
      const freqLow = Math.pow(10, logMin + logStep * i);
      const freqHigh = Math.pow(10, logMin + logStep * (i + 1));
      const startBin = Math.max(0, Math.round((freqLow / nyquist) * fftBins));
      const endBin = Math.min(fftBins - 1, Math.round((freqHigh / nyquist) * fftBins));
      bands.push({ startBin: Math.max(startBin, i === 0 ? 1 : startBin), endBin: Math.max(endBin, startBin) });
    }

    return bands;
  }

  // ---------------------------------------------------------------------------
  // Comparison Mode
  // ---------------------------------------------------------------------------

  /**
   * Draw side-by-side comparison of original and processed audio.
   * @param {Float32Array} originalData - Original audio samples
   * @param {Float32Array} processedData - Processed audio samples
   */
  drawComparison(originalData, processedData) {
    // Draw original on 'original' canvas
    if (originalData) {
      this.drawWaveform('original', originalData, '#4488ff');
      this._addCanvasLabel('original', 'Original', '#4488ff');
    }

    // Draw processed on 'processed' canvas
    if (processedData) {
      this.drawWaveform('processed', processedData, '#00d4aa');
      this._addCanvasLabel('processed', 'Processed', '#00d4aa');
    }
  }

  /**
   * Add a text label overlay to a canvas corner.
   * @param {string} canvasId - Target canvas
   * @param {string} text - Label text
   * @param {string} color - Label color
   */
  _addCanvasLabel(canvasId, text, color) {
    const ctx = this._contexts.get(canvasId);
    if (!ctx) return;
    const dpr = this._dpr;

    ctx.save();
    ctx.font = `bold ${12 * dpr}px system-ui, -apple-system, sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';

    const textW = ctx.measureText(text).width;
    const padding = 6 * dpr;
    const x = 8 * dpr;
    const y = 8 * dpr;

    // Label background
    ctx.fillStyle = 'rgba(10, 14, 18, 0.75)';
    ctx.beginPath();
    ctx.roundRect(x - padding, y - padding / 2, textW + padding * 2, 16 * dpr + padding, 4 * dpr);
    ctx.fill();

    // Label text
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  // Mode Management & Realtime Control
  // ---------------------------------------------------------------------------

  /**
   * Set the active visualization mode.
   * @param {'waveform' | 'spectrogram' | 'spectrum'} mode
   */
  setVisualizationMode(mode) {
    if (['waveform', 'spectrogram', 'spectrum'].includes(mode)) {
      this._mode = mode;
    }
  }

  /**
   * Start real-time visualization loop from an AnalyserNode.
   * @param {AnalyserNode} analyserNode - Web Audio API AnalyserNode
   */
  startRealtime(analyserNode) {
    this.stopRealtime();
    this._realtimeAnalyser = analyserNode;

    const targetCanvas = this._canvases.has('realtime') ? 'realtime' : 'processed';

    if (this._mode === 'spectrum') {
      this.drawRealtimeSpectrum(targetCanvas, analyserNode);
    } else {
      this.drawRealtimeWaveform(targetCanvas, analyserNode);
    }
  }

  /**
   * Stop the real-time animation loop.
   */
  stopRealtime() {
    if (this._realtimeAnimId !== null) {
      cancelAnimationFrame(this._realtimeAnimId);
      this._realtimeAnimId = null;
    }
    this._realtimeAnalyser = null;
  }

  // ---------------------------------------------------------------------------
  // Canvas Utilities
  // ---------------------------------------------------------------------------

  /**
   * Clear a canvas and show placeholder text.
   * @param {string} canvasId - Canvas identifier to clear
   */
  clear(canvasId) {
    const canvas = this._canvases.get(canvasId);
    const ctx = this._contexts.get(canvasId);
    if (!canvas || !ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    const dpr = this._dpr;

    ctx.fillStyle = this._bgColor;
    ctx.fillRect(0, 0, w, h);

    // Placeholder text
    ctx.fillStyle = this._placeholderColor;
    ctx.font = `${14 * dpr}px system-ui, -apple-system, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('No audio', w / 2, h / 2);
  }

  /**
   * Handle canvas resize, maintaining DPI scaling.
   */
  resize() {
    this._dpr = window.devicePixelRatio || 1;
    for (const [id, canvas] of this._canvases) {
      this._setupCanvas(canvas);
      this.clear(id);
    }
  }

  /**
   * Clean up all resources: stop animation, disconnect observer, release references.
   */
  destroy() {
    this._destroyed = true;
    this.stopRealtime();

    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }

    this._canvases.clear();
    this._contexts.clear();
    this._container = null;
  }

  // ---------------------------------------------------------------------------
  // Internal Helpers
  // ---------------------------------------------------------------------------

  /**
   * Set up a canvas for high-DPI rendering.
   * Scales the canvas backing store to match devicePixelRatio while keeping
   * the CSS layout size unchanged.
   * @param {HTMLCanvasElement} canvas
   */
  _setupCanvas(canvas) {
    const dpr = this._dpr;
    const rect = canvas.getBoundingClientRect();
    const displayW = rect.width || canvas.clientWidth || 800;
    const displayH = rect.height || canvas.clientHeight || 200;

    canvas.width = Math.round(displayW * dpr);
    canvas.height = Math.round(displayH * dpr);
    canvas.style.width = `${displayW}px`;
    canvas.style.height = `${displayH}px`;

    const ctx = canvas.getContext('2d', { alpha: false });
    if (ctx) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
    }
  }

  /**
   * Spectrogram colormap function.
   * Maps a normalized value (0..1) through a perceptual colormap:
   * dark blue -> cyan -> green -> yellow -> red
   * @param {number} value - Input value
   * @param {number} min - Minimum of range
   * @param {number} max - Maximum of range
   * @returns {[number, number, number]} RGB values (0..255)
   */
  _getColor(value, min, max) {
    const t = Math.max(0, Math.min(1, (value - min) / (max - min)));

    // Five-stop colormap
    const stops = [
      { pos: 0.0, r: 5,   g: 5,   b: 30  },  // near-black blue
      { pos: 0.2, r: 10,  g: 30,  b: 120 },  // dark blue
      { pos: 0.4, r: 0,   g: 160, b: 180 },  // cyan
      { pos: 0.6, r: 20,  g: 200, b: 50  },  // green
      { pos: 0.8, r: 240, g: 220, b: 20  },  // yellow
      { pos: 1.0, r: 240, g: 40,  b: 20  },  // red
    ];

    // Find the two stops surrounding t
    let lower = stops[0];
    let upper = stops[stops.length - 1];
    for (let i = 0; i < stops.length - 1; i++) {
      if (t >= stops[i].pos && t <= stops[i + 1].pos) {
        lower = stops[i];
        upper = stops[i + 1];
        break;
      }
    }

    const range = upper.pos - lower.pos;
    const localT = range > 0 ? (t - lower.pos) / range : 0;

    // Smooth interpolation (smoothstep for perceptual uniformity)
    const s = localT * localT * (3 - 2 * localT);

    return [
      Math.round(lower.r + (upper.r - lower.r) * s),
      Math.round(lower.g + (upper.g - lower.g) * s),
      Math.round(lower.b + (upper.b - lower.b) * s),
    ];
  }

  /**
   * Draw a measurement grid overlay on a canvas.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} width - Canvas pixel width
   * @param {number} height - Canvas pixel height
   * @param {Array<{pos: number, label: string}>} xLabels - X-axis labels with positions (0..1)
   * @param {string[]} yLabels - Y-axis labels (evenly distributed top-to-bottom)
   */
  _drawGrid(ctx, width, height, xLabels, yLabels) {
    const dpr = this._dpr;

    ctx.save();
    ctx.strokeStyle = this._gridColor;
    ctx.fillStyle = this._gridTextColor;
    ctx.lineWidth = dpr;
    ctx.font = `${9 * dpr}px monospace`;

    // Vertical grid lines (time axis)
    if (xLabels && xLabels.length > 0) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      for (const { pos, label } of xLabels) {
        const x = pos * width;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
        ctx.fillText(label, x, height - 2 * dpr);
      }
    }

    // Horizontal grid lines (amplitude axis)
    if (yLabels && yLabels.length > 0) {
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const step = height / (yLabels.length - 1);
      for (let i = 0; i < yLabels.length; i++) {
        const y = i * step;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
        ctx.fillText(yLabels[i], 4 * dpr, y);
      }
    }

    ctx.restore();
  }

  /**
   * Generate time axis labels.
   * @param {number} totalSamples - Total number of audio samples
   * @param {number} sampleRate - Sample rate (Hz)
   * @param {number} displayWidth - Display width in CSS pixels
   * @returns {Array<{pos: number, label: string}>}
   */
  _generateTimeLabels(totalSamples, sampleRate, displayWidth) {
    const totalSeconds = totalSamples / sampleRate;
    const labels = [];

    // Choose label interval based on duration
    let interval;
    if (totalSeconds <= 1) interval = 0.1;
    else if (totalSeconds <= 5) interval = 0.5;
    else if (totalSeconds <= 30) interval = 2;
    else if (totalSeconds <= 120) interval = 10;
    else if (totalSeconds <= 600) interval = 30;
    else interval = 60;

    // Limit number of labels to avoid clutter
    const maxLabels = Math.floor(displayWidth / 60);
    if (totalSeconds / interval > maxLabels) {
      interval = totalSeconds / maxLabels;
    }

    for (let t = interval; t < totalSeconds; t += interval) {
      const pos = t / totalSeconds;
      let label;
      if (totalSeconds < 10) {
        label = t.toFixed(1) + 's';
      } else {
        const mins = Math.floor(t / 60);
        const secs = Math.floor(t % 60);
        label = mins > 0 ? `${mins}:${secs.toString().padStart(2, '0')}` : `${secs}s`;
      }
      labels.push({ pos, label });
    }

    return labels;
  }

  /**
   * Format a frequency value for display.
   * @param {number} hz - Frequency in Hz
   * @returns {string} Formatted string (e.g., "1.2kHz", "440Hz")
   */
  _formatFreq(hz) {
    if (hz >= 1000) {
      const khz = hz / 1000;
      return khz % 1 === 0 ? `${khz}kHz` : `${khz.toFixed(1)}kHz`;
    }
    return `${Math.round(hz)}Hz`;
  }
}

export default Visualizer;
