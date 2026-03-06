import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';

const ffmpeg = new FFmpeg();

self.onmessage = async (e: MessageEvent) => {
  const { id, type, payload } = e.data;

  try {
    if (type === 'init') {
      await initFFmpeg();
      self.postMessage({ id, success: true });
      return;
    }

    if (type === 'decode') {
      const pcmFloatArray = await decodeAudio(payload.fileData, payload.fileName);
      self.postMessage(
        { id, success: true, data: { pcm: pcmFloatArray, sampleRate: 44100, channels: 1 } },
        [pcmFloatArray.buffer] // Transfer ownership
      );
    }
  } catch (error: any) {
    self.postMessage({ id, success: false, error: error.message });
  }
};

async function initFFmpeg() {
  if (ffmpeg.loaded) return;
  
  const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm';
  await ffmpeg.load({
    coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
    wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
  });
}

async function decodeAudio(fileData: Uint8Array, fileName: string): Promise<Float32Array> {
  const inputName = `input_${fileName}`;
  const outputName = `output_${Date.now()}.raw`;

  // Write file to FFmpeg's virtual filesystem
  await ffmpeg.writeFile(inputName, fileData);

  // Execute decoding: Output to 44.1kHz (-ar), mono (-ac 1), 32-bit float little-endian (-f f32le)
  const code = await ffmpeg.exec([
    '-i', inputName,
    '-ar', '44100',
    '-ac', '1',
    '-f', 'f32le',
    outputName
  ]);

  if (code !== 0) {
    throw new Error('FFmpeg processing failed.');
  }

  // Read output back into JS memory
  const outputData = await ffmpeg.readFile(outputName) as Uint8Array;
  
  // Cleanup virtual file system to prevent memory leaks
  await ffmpeg.deleteFile(inputName);
  await ffmpeg.deleteFile(outputName);

  // Convert Uint8Array to Float32Array
  return new Float32Array(outputData.buffer, outputData.byteOffset, outputData.byteLength / 4);
}
