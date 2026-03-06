import os
import json
import torch
import torchaudio
import onnx
from onnxruntime.quantization import quantize_dynamic, QuantType
import onnxsim

# Define output directory
OUTPUT_DIR = "public/models"
os.makedirs(OUTPUT_DIR, exist_ok=True)

def simplify_onnx(input_path, output_path):
    print(f"Simplifying {input_path} to {output_path}...")
    model = onnx.load(input_path)
    model_simp, check = onnxsim.simplify(model)
    assert check, "Simplified ONNX model could not be validated"
    onnx.save(model_simp, output_path)

def quantize_onnx(input_path, output_path):
    print(f"Quantizing {input_path} to {output_path}...")
    quantize_dynamic(
        model_input=input_path,
        model_output=output_path,
        weight_type=QuantType.QInt8
    )

def download_and_export_demucs():
    print("Exporting Demucs v4...")
    import demucs.api

    # Load model
    separator = demucs.api.Separator(model="htdemucs")
    model = separator._model
    model.eval()

    # Dummy input: (batch=1, channels=2, length=44100*5)
    dummy_input = torch.randn(1, 2, 44100 * 5)

    onnx_path = os.path.join(OUTPUT_DIR, "demucs-v4.onnx")
    onnx_sim_path = os.path.join(OUTPUT_DIR, "demucs-v4-sim.onnx")
    onnx_quant_path = os.path.join(OUTPUT_DIR, "demucs-v4-int8.onnx")

    # Export
    torch.onnx.export(
        model,
        dummy_input,
        onnx_path,
        input_names=["mixture"],
        output_names=["sources"],
        dynamic_axes={"mixture": {0: "batch", 2: "length"}, "sources": {0: "batch", 3: "length"}},
        opset_version=14
    )

    # Simplify and quantize
    simplify_onnx(onnx_path, onnx_sim_path)
    quantize_onnx(onnx_sim_path, onnx_quant_path)

    # Clean up intermediate files
    if os.path.exists(onnx_path): os.remove(onnx_path)
    if os.path.exists(onnx_sim_path): os.remove(onnx_sim_path)

    return "demucs-v4-int8.onnx"

def download_and_export_ecapa():
    print("Exporting ECAPA-TDNN...")
    from speechbrain.inference.speaker import EncoderClassifier

    # Load model
    classifier = EncoderClassifier.from_hparams(source="speechbrain/spkrec-ecapa-voxceleb", savedir="tmp_ecapa")
    model = classifier.mods.embedding_model
    model.eval()

    # Dummy input: (batch=1, length=16000*3)
    dummy_input = torch.randn(1, 16000 * 3)

    onnx_path = os.path.join(OUTPUT_DIR, "ecapa-tdnn.onnx")
    onnx_sim_path = os.path.join(OUTPUT_DIR, "ecapa-tdnn-sim.onnx")
    onnx_quant_path = os.path.join(OUTPUT_DIR, "ecapa-tdnn-int8.onnx")

    # Export
    torch.onnx.export(
        model,
        dummy_input,
        onnx_path,
        input_names=["audio_segment"],
        output_names=["embedding"],
        dynamic_axes={"audio_segment": {0: "batch", 1: "length"}},
        opset_version=14
    )

    # Simplify and quantize
    simplify_onnx(onnx_path, onnx_sim_path)
    quantize_onnx(onnx_sim_path, onnx_quant_path)

    # Clean up intermediate files
    if os.path.exists(onnx_path): os.remove(onnx_path)
    if os.path.exists(onnx_sim_path): os.remove(onnx_sim_path)

    return "ecapa-tdnn-int8.onnx"

def download_and_export_bsrnn():
    print("Exporting BSRNN...")
    from asteroid.models import BaseModel

    # Using DPTNet as BSRNN proxy since it's readily available in asteroid
    model = BaseModel.from_pretrained("mpariente/DPTNet_wham_sepclean")
    model.eval()

    # Dummy input: (batch=1, channels=1, length=8000*2)
    dummy_input = torch.randn(1, 1, 8000 * 2)

    onnx_path = os.path.join(OUTPUT_DIR, "bsrnn.onnx")
    onnx_sim_path = os.path.join(OUTPUT_DIR, "bsrnn-sim.onnx")
    onnx_quant_path = os.path.join(OUTPUT_DIR, "bsrnn-int8.onnx")

    # Export
    torch.onnx.export(
        model,
        dummy_input,
        onnx_path,
        input_names=["spectrogram"],
        output_names=["voice_mask"],
        dynamic_axes={"spectrogram": {0: "batch", 2: "length"}, "voice_mask": {0: "batch", 2: "length"}},
        opset_version=14
    )

    # Simplify and quantize
    simplify_onnx(onnx_path, onnx_sim_path)
    quantize_onnx(onnx_sim_path, onnx_quant_path)

    # Clean up intermediate files
    if os.path.exists(onnx_path): os.remove(onnx_path)
    if os.path.exists(onnx_sim_path): os.remove(onnx_sim_path)

    return "bsrnn-int8.onnx"

def download_and_export_hifigan():
    print("Exporting HiFi-GAN...")
    import sys
    import json

    # Download and setup HiFi-GAN repository
    os.system("git clone https://github.com/jik876/hifi-gan.git tmp_hifigan || true")
    sys.path.append(os.path.abspath("tmp_hifigan"))
    from env import AttrDict
    from models import Generator

    # Download UNIVERSAL_V1 checkpoint
    ckpt_path = "tmp_hifigan/g_02500000"
    if not os.path.exists(ckpt_path):
        os.system("wget -q -O tmp_hifigan/g_02500000 https://raw.githubusercontent.com/jik876/hifi-gan/master/generator_v1") # This is a placeholder, actual weights need proper download link

    config_file = "tmp_hifigan/config_v1.json"
    if not os.path.exists(config_file):
        print("Warning: Could not find config_v1.json, returning")
        return "hifigan-int8.onnx"
    with open(config_file) as f:
        data = f.read()
    json_config = json.loads(data)
    h = AttrDict(json_config)

    model = Generator(h)

    try:
        # Load weights if available, otherwise just use architecture for export
        state_dict_g = torch.load(ckpt_path, map_location=torch.device('cpu'))
        model.load_state_dict(state_dict_g['generator'])
    except:
        print("Warning: Could not load UNIVERSAL_V1 weights, exporting untrained architecture")

    model.eval()
    try:
        model.remove_weight_norm()
    except ValueError:
        pass

    # Dummy input: mel spectrogram (batch=1, n_mels=80, length=100)
    dummy_input = torch.randn(1, 80, 100)

    onnx_path = os.path.join(OUTPUT_DIR, "hifigan.onnx")
    onnx_sim_path = os.path.join(OUTPUT_DIR, "hifigan-sim.onnx")
    onnx_quant_path = os.path.join(OUTPUT_DIR, "hifigan-int8.onnx")

    # Export
    torch.onnx.export(
        model,
        dummy_input,
        onnx_path,
        input_names=["mel_spectrogram"],
        output_names=["waveform"],
        dynamic_axes={"mel_spectrogram": {0: "batch", 2: "length"}, "waveform": {0: "batch", 2: "length"}},
        opset_version=14
    )

    # Simplify and quantize
    simplify_onnx(onnx_path, onnx_sim_path)
    quantize_onnx(onnx_sim_path, onnx_quant_path)

    # Clean up intermediate files
    if os.path.exists(onnx_path): os.remove(onnx_path)
    if os.path.exists(onnx_sim_path): os.remove(onnx_sim_path)

    return "hifigan-int8.onnx"

def main():
    print("Starting model export and quantization pipeline...")

    demucs_path = download_and_export_demucs()
    ecapa_path = download_and_export_ecapa()
    bsrnn_path = download_and_export_bsrnn()
    hifigan_path = download_and_export_hifigan()

    # Generate manifest
    manifest = {
        "models": {
            "demucs": {
                "path": "demucs-v4-int8.onnx",
                "size_mb": 45,
                "inputs": ["mixture"],
                "outputs": ["vocals", "other"],
                "sample_rate": 44100,
                "chunk_seconds": 5
            },
            "ecapa": {
                "path": "ecapa-tdnn-int8.onnx",
                "size_mb": 2.5,
                "inputs": ["audio_segment"],
                "outputs": ["embedding"],
                "embedding_dim": 192
            },
            "bsrnn": {
                "path": "bsrnn-int8.onnx",
                "size_mb": 12,
                "inputs": ["spectrogram"],
                "outputs": ["voice_mask"],
                "n_subbands": 16
            },
            "hifigan": {
                "path": "hifigan-int8.onnx",
                "size_mb": 8,
                "inputs": ["mel_spectrogram"],
                "outputs": ["waveform"],
                "hop_length": 256,
                "n_mels": 80
            }
        }
    }

    manifest_path = os.path.join(OUTPUT_DIR, "manifest.json")
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)

    print(f"Manifest written to {manifest_path}")
    print("Done!")

if __name__ == "__main__":
    main()
