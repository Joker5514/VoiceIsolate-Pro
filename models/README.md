# VoiceIsolate Pro ONNX Models

This directory contains the ONNX models required for the machine learning pipeline in VoiceIsolate Pro. All models run entirely locally in the browser via `onnxruntime-web`.

## Required Models & Shapes

1. **Demucs v4 (`demucs-v4-int8.onnx`)**
   - **Task:** General audio source separation
   - **Input:** `[1, 2, segment]` (float32, stereo samples)
   - **Output:** `[1, 2, segment]` (float32, separated stem)

2. **BSRNN (`bsrnn-int8.onnx`)**
   - **Task:** Music and vocals separation
   - **Input:** `[batch, freq_bins, time_frames]` (float32, mono)
   - **Output:** Identical to input shape

3. **Silero VAD (`silero-vad.onnx`)**
   - **Task:** Voice Activity Detection
   - **Input:** `[1, 512]` @ 16kHz (float32, mono samples)
   - **State Input:** `[2, 1, 64]` (float32, LSTM state for 16kHz)
   - **Output:** `[1, 1]` (float32, confidence score)

4. **ECAPA-TDNN (`ecapa-tdnn-int8.onnx`)**
   - **Task:** Speaker identification and biometric enrollment
   - **Input:** `[1, 1, samples]` (float32)
   - **Output:** `[1, 192]` (float32, speaker embedding vector)

5. **DNS v2 (`dns-int8.onnx`)**
   - **Task:** Deep Noise Suppression (Microsoft DNS Challenge)
   - **Input:** `[1, 1, frame]` (float32, frequency magnitude frame)
   - **Output:** `[1, 1, frame]` (float32, gain mask)

## Download & Conversion

To generate the required INT8 quantized ONNX files:

1. **Source repositories:**
   - Demucs: [facebookresearch/demucs](https://github.com/facebookresearch/demucs)
   - Silero VAD: [snakers4/silero-vad](https://github.com/snakers4/silero-vad)
   - SpeechBrain (ECAPA-TDNN): [speechbrain/speechbrain](https://github.com/speechbrain/speechbrain)

2. **Conversion to ONNX Int8:**
   You can use the Optimum library or ONNX Runtime tools to quantize standard FP32 ONNX models down to INT8 to reduce payload size for the web:
   ```bash
   python -m onnxruntime.quantization.preprocess --input model.onnx --output model_prep.onnx
   python -m onnxruntime.quantization.quantize --input model_prep.onnx --output model-int8.onnx --quant_format QOperator
   ```
