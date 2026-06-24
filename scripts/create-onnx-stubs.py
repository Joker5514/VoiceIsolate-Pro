#!/usr/bin/env python3
"""
create-onnx-stubs.py — VoiceIsolate Pro

Creates minimal valid ONNX stub files for any missing models.
This ensures the app boots and shows the model status UI without crashing.

Each stub uses the Identity op to pass input through to output.
ORT-web can load these without error, even though inference is a no-op.

Input/output tensor specs (matching the real models):
  demucs_v4_quantized.onnx  -> input: float32[1,2,T]  output: float32[4,2,T]
  bsrnn_quantized.onnx      -> input: float32[1,1,F,T] output: float32[1,1,F,T]
  rnnoise.onnx              -> input: float32[1,480]   output: float32[1,480]
  nsnet2.onnx               -> input: float32[1,1,257] output: float32[1,1,257]
  silero_vad.onnx           -> input: float32[1,1,512] output: float32[1,2]
"""
import onnx
from onnx import helper, TensorProto
import os


def make_identity_model(name, input_shape, output_shape, opset=17):
    input_tensor = helper.make_tensor_value_info(
        'input', TensorProto.FLOAT, input_shape
    )
    output_tensor = helper.make_tensor_value_info(
        'output', TensorProto.FLOAT, output_shape
    )

    node = helper.make_node(
        'Identity',
        inputs=['input'],
        outputs=['output'],
        name=f'{name}_identity'
    )

    graph = helper.make_graph(
        [node],
        f'{name}_graph',
        [input_tensor],
        [output_tensor],
        initializer=[]
    )

    model = helper.make_model(
        graph,
        opset_imports=[helper.make_opsetid('', opset)],
        producer_name='VoiceIsolate-Pro',
        producer_version='1.0.0'
    )
    onnx.checker.check_model(model)
    return model


def save_model(path, model):
    os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
    onnx.save(model, path)
    print(f'Created stub: {path}')


def main():
    models = {
        'demucs': ([1, 2, 1024], [4, 2, 1024]),
        'bsrnn': ([1, 1, 257, 100], [1, 1, 257, 100]),
        'rnnoise': ([1, 480], [1, 480]),
        'nsnet2': ([1, 1, 257], [1, 1, 257]),
        'silero_vad': ([1, 1, 512], [1, 2]),
    }

    filenames = {
        'demucs': 'models/demucs_v4_quantized.onnx',
        'bsrnn': 'models/bsrnn_quantized.onnx',
        'rnnoise': 'models/rnnoise.onnx',
        'nsnet2': 'models/nsnet2.onnx',
        'silero_vad': 'models/silero_vad.onnx',
    }

    created = 0
    already_exists = 0

    for key, (inp_shape, out_shape) in models.items():
        path = filenames[key]
        if os.path.exists(path):
            print(f'Skip (exists): {path}')
            already_exists += 1
        else:
            model = make_identity_model(key, inp_shape, out_shape)
            save_model(path, model)
            created += 1

    if created == 0 and already_exists == 0:
        raise RuntimeError(
            'No model files created or found in models/ directory'
        )

    print(f'\nDone: {created} stub(s) created, '
          f'{already_exists} already existed')


if __name__ == '__main__':
    main()
