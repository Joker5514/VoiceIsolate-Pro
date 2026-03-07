self.onmessage = async (event: MessageEvent) => {
  const { id, arrayBuffer } = event.data;
  try {
    const audioContext = new AudioContext();
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
    self.postMessage({ id, success: true, audioBuffer });
  } catch (error: unknown) {
    self.postMessage({ id, success: false, error: error instanceof Error ? error.message : String(error) });
  }
};
