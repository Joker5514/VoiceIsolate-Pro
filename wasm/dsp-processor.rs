//! dsp-processor.rs — VoiceIsolate Pro v6 DSP Engine (Rust/WASM alternative)
//! Compile with: wasm-pack build wasm/ --target web --release
//!
//! Cargo.toml dependencies:
//!   wasm-bindgen = "0.2"
//!   js-sys = "0.3"

use wasm_bindgen::prelude::*;

const ERB_BANDS: usize   = 32;
const ALPHA_NOISE: f32   = 0.98;
const WIENER_FLOOR: f32  = 0.01;
const OLA_SCALE_75: f32  = 2.0 / 3.0;  // Normalization for 75% overlap Hann OLA

// ── ERB band mapping ─────────────────────────────────────────────────────
fn bin_to_erb_band(k: usize, bins: usize, sample_rate: f32) -> usize {
    let freq = k as f32 / bins as f32 * (sample_rate / 2.0);
    let erb  = 21.4 * (1.0 + freq / 229.0_f32).log10();
    let band = (erb / 35.0 * ERB_BANDS as f32) as usize;
    band.min(ERB_BANDS - 1)
}

// ── Minimum Statistics noise floor (per bin) ─────────────────────────────
fn update_noise_floor(mag_spec: &[f32], noise_floor: &mut [f32]) {
    for (k, (m, nf)) in mag_spec.iter().zip(noise_floor.iter_mut()).enumerate() {
        let tracked = ALPHA_NOISE * *nf + (1.0 - ALPHA_NOISE) * m;
        *nf = tracked.min(*m);
    }
}

// ── Wiener gain (simple MMSE approximation) ───────────────────────────────
fn wiener_gain(mag: f32, noise_floor: f32, over_sub: f32) -> f32 {
    let snr = ((mag - over_sub * noise_floor).max(0.0)) / (mag + 1e-12);
    snr.sqrt().max(WIENER_FLOOR)
}

// ── ERB-scale spectral gate ───────────────────────────────────────────────
fn spectral_gate_erb(mag_spec: &mut [f32], noise_floor: &[f32], threshold: f32, sample_rate: f32) {
    let bins = mag_spec.len();
    let mut band_energy = [0.0f32; ERB_BANDS];
    let mut band_noise  = [0.0f32; ERB_BANDS];
    let mut band_count  = [0usize; ERB_BANDS];

    for k in 0..bins {
        let b = bin_to_erb_band(k, bins, sample_rate);
        band_energy[b] += mag_spec[k] * mag_spec[k];
        band_noise[b]  += noise_floor[k] * noise_floor[k];
        band_count[b]  += 1;
    }

    for k in 0..bins {
        let b    = bin_to_erb_band(k, bins, sample_rate);
        let bsnr = if band_count[b] > 0 {
            band_energy[b] / (band_noise[b] + 1e-12)
        } else { 1.0 };
        if bsnr < threshold {
            mag_spec[k] *= 0.005;
        }
    }
}

// ── Main OLA block processing (exported to JS via wasm-bindgen) ───────────
#[wasm_bindgen]
pub fn process_block(
    input:        &[f32],
    output:       &mut [f32],
    in_buf:       &mut [f32],
    out_buf:      &mut [f32],
    overlap_buf:  &mut [f32],
    window:       &[f32],
    noise_floor:  &mut [f32],
    noise_reduction: f32,
    gain_linear:     f32,
    fft_size:     usize,
    hop:          usize,
) {
    let bins     = fft_size / 2 + 1;
    let over_sub = 1.2 + noise_reduction * 0.8;  // 1.2 – 2.0

    // 1. Hann analysis window
    for i in 0..fft_size {
        in_buf[i] = if i < hop { input[i] } else { 0.0 } * window[i];
    }

    // 2. Magnitude spectrum (replace with real FFT in production)
    for k in 0..bins {
        out_buf[k] = in_buf[k.min(fft_size - 1)].abs();
    }

    // 3. Minimum Statistics noise floor update
    update_noise_floor(&out_buf[..bins].to_vec(), &mut noise_floor[..bins]);

    // 4. Per-bin Wiener gain
    for k in 0..bins {
        let g = wiener_gain(out_buf[k], noise_floor[k] * 1.5, over_sub);
        out_buf[k] *= g;
    }

    // 5. ERB spectral gate
    let gate_threshold = 1.5 + noise_reduction * 3.0;
    spectral_gate_erb(&mut out_buf[..bins], &noise_floor[..bins], gate_threshold, 48000.0);

    // 6. IFFT (replace with real IFFT in production)
    for i in 0..fft_size {
        out_buf[i] = out_buf[i.min(bins - 1)] / fft_size as f32;
    }

    // 7. Synthesis Hann window
    for i in 0..fft_size {
        out_buf[i] *= window[i];
    }

    // 8. Overlap-Add
    for i in 0..fft_size {
        out_buf[i] += overlap_buf[i];
    }
    overlap_buf[..hop].copy_from_slice(&out_buf[hop..2 * hop]);
    overlap_buf[hop..].fill(0.0);

    // 9. Output with OLA normalization + gain
    for i in 0..hop.min(output.len()) {
        output[i] = out_buf[i] * OLA_SCALE_75 * gain_linear;
    }
}

#[wasm_bindgen]
pub fn wiener_gain_export(mag: f32, noise_floor: f32, over_sub: f32) -> f32 {
    wiener_gain(mag, noise_floor, over_sub)
}
