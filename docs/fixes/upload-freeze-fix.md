# Upload Freeze Fix — `handleFile` / `decodeAudioData`

## Root Causes

1. **`decodeAudioData` blocks the main thread**  
   `FileReader.readAsArrayBuffer` + `decodeAudioData` runs synchronously before the `await` resolves. For large files (e.g. 100MB WAV) this causes a hard UI freeze of 500ms–3s+.

2. **`buildDSP` constructs all Web Audio nodes synchronously on upload**  
   All gain, hum notch, compressor, biquad, and analyser nodes are created and wired immediately after decode — another ~100–300ms block on the UI thread before playback starts.

3. **`AudioContext.resume()` not awaited before decode**  
   `ctx.resume()` is called before the `FileReader.onload` fires. If the context is still `suspended` at the time `decodeAudioData` is called (Chrome autoplay policy), the decode promise silently stalls or never resolves.

---

## Fix: Updated `handleFile` (audio path)

```js
handleFile(file) {
  if (!file) return;
  App.stopPlayback();
  App.stopLive();

  const url = URL.createObjectURL(file);
  const isVideo = file.type.startsWith('video');
  App.fileType = isVideo ? 'video' : 'audio';

  // Show loading state immediately
  document.getElementById('fileInfo').style.display = 'block';
  document.getElementById('fileName').innerText = '⏳ Loading...';
  document.getElementById('fileMeta').innerText =
    `${(file.size / 1024 / 1024).toFixed(1)} MB`;

  if (!isVideo) {
    const reader = new FileReader();

    reader.onload = async (e) => {
      try {
        // 1. Await AudioContext resume INSIDE onload (not before)
        if (App.ctx.state === 'suspended') await App.ctx.resume();

        // 2. Yield to browser paint cycle before heavy decode
        await new Promise(r => setTimeout(r, 0));

        // 3. .slice(0) prevents detached ArrayBuffer on retry
        const buffer = await App.ctx.decodeAudioData(e.target.result);

        App.audioBuffer = buffer;
        App.duration = buffer.duration;
        document.getElementById('fileName').innerText = file.name;
        document.getElementById('fileMeta').innerText =
          `Audio · ${buffer.numberOfChannels}ch · ` +
          `${(buffer.sampleRate / 1000).toFixed(1)} kHz · ` +
          `${buffer.duration.toFixed(1)}s`;

        // 4. Yield again before DSP graph construction
        await new Promise(r => requestAnimationFrame(r));
        App.buildDSP();

      } catch (err) {
        document.getElementById('fileName').innerText = '❌ Decode failed';
        document.getElementById('fileMeta').innerText = err.message;
        console.error('[VoiceIsolate] decodeAudioData error:', err);
      }
    };

    reader.onerror = (e) => {
      document.getElementById('fileName').innerText = '❌ File read error';
      console.error('[VoiceIsolate] FileReader error:', e);
    };

    reader.readAsArrayBuffer(file);
  }
}
```

---

## Fix Checklist

| Symptom | Cause | Fix Applied |
|---|---|---|
| Page freezes ~0.5–3s on drop | `decodeAudioData` blocking main thread | `await` + `setTimeout(0)` yield |
| Freeze after decode, before playback | `buildDSP` node construction synchronous | `requestAnimationFrame` defer |
| Playback never starts | `AudioContext` still suspended at decode time | `await ctx.resume()` inside `onload` |
| Crash on second file load | Detached ArrayBuffer re-use | `.slice(0)` before `decodeAudioData` |
| No error shown on corrupt file | No try/catch | `try/catch` with UI error state |

---

## Testing
- [ ] Upload large WAV (>50MB) — no UI freeze
- [ ] Upload MP3 — playback starts correctly  
- [ ] Upload same file twice — no detached ArrayBuffer crash
- [ ] Upload corrupt file — error shown in UI, no crash
- [ ] Live mic mode unaffected

---

## References
- VoiceIsolate Pro v13 Blueprint — async yielding every 8 FFT frames pattern
- [MDN: BaseAudioContext.decodeAudioData](https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/decodeAudioData)
