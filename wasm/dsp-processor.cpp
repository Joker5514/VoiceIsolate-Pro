/**
 * dsp-processor.cpp — VoiceIsolate Pro v6 DSP Engine
 * Compile with Emscripten: see build.sh
 *
 * Implements:
 *   - Hann-windowed OLA (FFT_SIZE=2048, HOP=512, 75% overlap)
 *   - Minimum Statistics noise floor estimator
 *   - Wiener Filter (per-bin SNR-based gain)
 *   - Spectral Gate (32 ERB-scale bands)
 */

#include <emscripten/bind.h>
#include <cmath>
#include <algorithm>
#include <cstring>

// ── KissFFT-compatible forward declarations ───────────────────────────────
// In production: link with pffft or KissFFT
// Here we provide the algorithm structure with placeholder FFT calls.
extern "C" {
  void kiss_fftr(void* cfg, const float* in, float* out);
  void kiss_fftri(void* cfg, const float* in, float* out);
}

static const int ERB_BANDS = 32;
static const float ALPHA_NOISE = 0.98f;
static const float WIENER_FLOOR = 0.01f;   // Minimum Wiener gain (prevents total silence)
static const float OVERSUB_BASE  = 1.2f;

// ── ERB (Equivalent Rectangular Bandwidth) scale helpers ─────────────────
// Maps FFT bin index to 1 of 32 perceptual bands
inline int binToERBBand(int k, int bins, float sampleRate) {
  float freq   = (float)k / bins * (sampleRate / 2.0f);
  float erb    = 21.4f * std::log10(1.0f + freq / 229.0f);
  int   band   = (int)(erb / 35.0f * ERB_BANDS);  // 35 ERB ≈ 20Hz–20kHz range
  return std::max(0, std::min(ERB_BANDS - 1, band));
}

// ── Minimum Statistics noise floor update (per bin) ──────────────────────
void updateNoiseFloor(
    const float* magSpec,
    float*       noiseFloor,
    int          bins,
    float        alpha = ALPHA_NOISE
) {
  for (int k = 0; k < bins; k++) {
    float tracked = alpha * noiseFloor[k] + (1.0f - alpha) * magSpec[k];
    noiseFloor[k] = std::min(tracked, magSpec[k]);  // Always take minimum
  }
}

// ── Wiener filter gain per bin ────────────────────────────────────────────
// H(k) = sqrt( max(SNR, 0) / (1 + SNR) ) — MMSE-STSA approximation
float wienerGain(float magSig, float magNoise, float overSub) {
  float sigPow   = magSig   * magSig;
  float noisePow = magNoise * magNoise;
  float priorSNR = std::max(sigPow - overSub * noisePow, 0.0f)
                   / (noisePow + 1e-12f);
  float postSNR  = sigPow / (noisePow + 1e-12f);
  float vk       = priorSNR / (1.0f + priorSNR) * postSNR;
  // Gordon-Newell approximation of parabolic cylinder function
  float gain     = (priorSNR / (1.0f + priorSNR))
                   * std::exp(0.5f * std::expint_approx(-vk));  // simplified
  return std::max(WIENER_FLOOR, std::min(1.0f, std::sqrt(gain)));
}

// Simpler but still effective Wiener approximation for production fallback
float wienerGainSimple(float mag, float noiseFloor, float overSub) {
  float snr  = std::max(mag - overSub * noiseFloor, 0.0f) / (mag + 1e-12f);
  return std::max(WIENER_FLOOR, std::sqrt(snr));
}

// ── 32-band ERB Spectral Gate ─────────────────────────────────────────────
void spectralGateERB(
    float* magSpec,
    const float* noiseFloor,
    int   bins,
    float threshold,
    float sampleRate = 48000.0f
) {
  // Compute per-band energy ratios
  float bandEnergy[ERB_BANDS]  = {0};
  float bandNoise[ERB_BANDS]   = {0};
  int   bandCount[ERB_BANDS]   = {0};

  for (int k = 0; k < bins; k++) {
    int b = binToERBBand(k, bins, sampleRate);
    bandEnergy[b] += magSpec[k] * magSpec[k];
    bandNoise[b]  += noiseFloor[k] * noiseFloor[k];
    bandCount[b]++;
  }

  // Gate entire bands below SNR threshold
  for (int k = 0; k < bins; k++) {
    int   b    = binToERBBand(k, bins, sampleRate);
    float bsnr = (bandCount[b] > 0)
                 ? bandEnergy[b] / (bandNoise[b] + 1e-12f)
                 : 1.0f;
    if (bsnr < threshold) {
      magSpec[k] *= 0.005f;  // Near-zero, not absolute zero — avoids spectral holes
    }
  }
}

// ── Main OLA block processing function (exported to JS) ──────────────────
void processBlock(
    const float* input,
    float*       output,
    float*       inBuf,
    float*       outBuf,
    float*       overlapBuf,
    const float* window,
    float*       noiseFloor,
    float        noiseReduction,
    float        gainLinear,
    int          fftSize,
    int          hop
) {
  const int bins = fftSize / 2 + 1;
  const float overSub = OVERSUB_BASE + noiseReduction * 0.8f;  // 1.2 – 2.0 range

  // ── 1. Copy input + apply Hann analysis window ────────────────────────
  for (int i = 0; i < fftSize; i++) {
    inBuf[i] = (i < hop ? input[i] : 0.0f) * window[i];
  }

  // ── 2. Forward FFT (real-to-complex) — link KissFFT/pffft here ────────
  // kiss_fftr(fft_cfg, inBuf, (float*)spectrum);
  // Placeholder: use magnitude of inBuf directly for demonstration
  float* magSpec = outBuf;  // [bins] — replace with |spectrum[k]|
  for (int k = 0; k < bins; k++) {
    magSpec[k] = std::abs(inBuf[k < fftSize ? k : fftSize - 1]);
  }

  // ── 3. Update noise floor (Minimum Statistics) ───────────────────────
  updateNoiseFloor(magSpec, noiseFloor, bins);

  // ── 4. Per-bin Wiener gain ─────────────────────────────────────────────
  for (int k = 0; k < bins; k++) {
    float g    = wienerGainSimple(magSpec[k], noiseFloor[k] * 1.5f, overSub);
    magSpec[k] *= g;
  }

  // ── 5. ERB-scale Spectral Gate ─────────────────────────────────────────
  float gateThreshold = 1.5f + noiseReduction * 3.0f;  // 1.5–4.5 SNR threshold
  spectralGateERB(magSpec, noiseFloor, bins, gateThreshold);

  // ── 6. Inverse FFT — link here ─────────────────────────────────────────
  // kiss_fftri(ifft_cfg, (float*)spectrum, outBuf);
  // Normalize IFFT output by 1/fftSize
  for (int i = 0; i < fftSize; i++) {
    outBuf[i] = magSpec[i < bins ? i : bins - 1] / (float)fftSize;
  }

  // ── 7. Synthesis Hann window ───────────────────────────────────────────
  for (int i = 0; i < fftSize; i++) {
    outBuf[i] *= window[i];
  }

  // ── 8. Overlap-Add ─────────────────────────────────────────────────────
  for (int i = 0; i < fftSize; i++) {
    outBuf[i] += overlapBuf[i];
  }
  // Save second half to overlap buffer
  std::memcpy(overlapBuf, outBuf + hop, hop * sizeof(float));
  std::memset(overlapBuf + hop, 0, (fftSize - hop) * sizeof(float));

  // ── 9. Output first hop samples with final gain ─────────────────────
  const float olaScale = 2.0f / 3.0f;  // Normalization for 75% overlap Hann OLA
  for (int i = 0; i < hop; i++) {
    output[i] = outBuf[i] * olaScale * gainLinear;
  }
}

// ── Emscripten bindings ───────────────────────────────────────────────────
EMSCRIPTEN_BINDINGS(dsp_module) {
  emscripten::function("processBlock",      &processBlock,      emscripten::allow_raw_pointers());
  emscripten::function("updateNoiseFloor",  &updateNoiseFloor,  emscripten::allow_raw_pointers());
  emscripten::function("spectralGateERB",   &spectralGateERB,   emscripten::allow_raw_pointers());
  emscripten::function("wienerGainSimple",  &wienerGainSimple);
}
