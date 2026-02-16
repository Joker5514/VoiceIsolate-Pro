/**
 * VoiceIsolate Pro v9.0 - Audio Export Encoders
 *
 * Provides encoding to WAV (16/24-bit PCM), MP3, and FLAC, plus
 * browser download triggering, batch ZIP archive creation, and
 * export manifest generation.
 *
 * The WAV encoder is a complete, self-contained implementation with
 * proper RIFF/WAVE headers.  The ZIP creator is a minimal but
 * fully-functional implementation (local file headers + central
 * directory + EOCD) that produces valid ZIP archives.
 */

export class AudioEncoders {
  // -------------------------------------------------------------------------
  // WAV encoding
  // -------------------------------------------------------------------------

  /**
   * Encode audio channel data to a WAV file (RIFF/WAVE PCM).
   *
   * @param {Float32Array[]} channelData  Array of per-channel Float32Arrays.
   * @param {number}         sampleRate
   * @param {number}         [bitDepth=16] 16 or 24.
   * @returns {ArrayBuffer}  Complete WAV file.
   */
  static encodeWav(channelData, sampleRate, bitDepth = 16) {
    if (!channelData || channelData.length === 0) {
      throw new Error('encodeWav: channelData must be a non-empty array of Float32Arrays');
    }
    if (bitDepth !== 16 && bitDepth !== 24) {
      throw new Error('encodeWav: bitDepth must be 16 or 24');
    }

    const numChannels = channelData.length;
    const numFrames = channelData[0].length;
    const bytesPerSample = bitDepth / 8;
    const blockAlign = numChannels * bytesPerSample;
    const byteRate = sampleRate * blockAlign;
    const dataSize = numFrames * blockAlign;

    // RIFF header (12) + fmt chunk (24) + data chunk header (8) + data
    const headerSize = 44;
    const fileSize = headerSize + dataSize;
    const buffer = new ArrayBuffer(fileSize);
    const view = new DataView(buffer);

    let offset = 0;

    // --- RIFF header ---
    writeString(view, offset, 'RIFF');         offset += 4;
    view.setUint32(offset, fileSize - 8, true); offset += 4;  // file size minus RIFF header
    writeString(view, offset, 'WAVE');         offset += 4;

    // --- fmt sub-chunk ---
    writeString(view, offset, 'fmt ');         offset += 4;
    view.setUint32(offset, 16, true);          offset += 4;  // sub-chunk size (16 for PCM)
    view.setUint16(offset, 1, true);           offset += 2;  // audio format: 1 = PCM
    view.setUint16(offset, numChannels, true); offset += 2;
    view.setUint32(offset, sampleRate, true);  offset += 4;
    view.setUint32(offset, byteRate, true);    offset += 4;
    view.setUint16(offset, blockAlign, true);  offset += 2;
    view.setUint16(offset, bitDepth, true);    offset += 2;

    // --- data sub-chunk ---
    writeString(view, offset, 'data');         offset += 4;
    view.setUint32(offset, dataSize, true);    offset += 4;

    // --- Interleaved PCM samples ---
    if (bitDepth === 16) {
      for (let i = 0; i < numFrames; i++) {
        for (let ch = 0; ch < numChannels; ch++) {
          const sample = clamp(channelData[ch][i], -1, 1);
          const int16 = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
          view.setInt16(offset, int16, true);
          offset += 2;
        }
      }
    } else {
      // 24-bit PCM
      for (let i = 0; i < numFrames; i++) {
        for (let ch = 0; ch < numChannels; ch++) {
          const sample = clamp(channelData[ch][i], -1, 1);
          const int24 = Math.round(sample < 0 ? sample * 0x800000 : sample * 0x7FFFFF);
          // Write 24-bit little-endian (3 bytes).
          view.setUint8(offset,     int24 & 0xFF);
          view.setUint8(offset + 1, (int24 >> 8) & 0xFF);
          view.setUint8(offset + 2, (int24 >> 16) & 0xFF);
          offset += 3;
        }
      }
    }

    return buffer;
  }

  /**
   * Convenience wrapper for 24-bit WAV encoding.
   *
   * @param {Float32Array[]} channelData
   * @param {number}         sampleRate
   * @returns {ArrayBuffer}
   */
  static encodeWav24(channelData, sampleRate) {
    return AudioEncoders.encodeWav(channelData, sampleRate, 24);
  }

  // -------------------------------------------------------------------------
  // MP3 encoding
  // -------------------------------------------------------------------------

  /**
   * Encode audio to MP3.
   *
   * Requires the `lamejs` library to be loaded globally or importable.
   * Returns `null` with a descriptive message if lamejs is not available.
   *
   * @param {Float32Array[]} channelData  One or two channels.
   * @param {number}         sampleRate
   * @param {number}         [bitrate=192] kbps.
   * @returns {Promise<ArrayBuffer|null>}
   */
  static async encodeMp3(channelData, sampleRate, bitrate = 192) {
    // Check for lamejs availability.
    const lamejs = globalThis.lamejs || globalThis.lamejsModule;

    if (!lamejs || !lamejs.Mp3Encoder) {
      console.warn(
        '[AudioEncoders] MP3 encoding requires lamejs. ' +
          'Include lamejs (https://github.com/zhuker/lamejs) to enable MP3 export.',
      );
      return null;
    }

    const numChannels = Math.min(channelData.length, 2); // lamejs supports mono/stereo
    const numFrames = channelData[0].length;

    // Convert float [-1,1] to Int16.
    const toInt16 = (floatData) => {
      const int16 = new Int16Array(floatData.length);
      for (let i = 0; i < floatData.length; i++) {
        const s = clamp(floatData[i], -1, 1);
        int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
      return int16;
    };

    const encoder = new lamejs.Mp3Encoder(numChannels, sampleRate, bitrate);
    const mp3Chunks = [];
    const blockSize = 1152; // MPEG1 frame size

    const left = toInt16(channelData[0]);
    const right = numChannels > 1 ? toInt16(channelData[1]) : null;

    for (let i = 0; i < numFrames; i += blockSize) {
      const end = Math.min(i + blockSize, numFrames);
      const leftBlock = left.subarray(i, end);

      let mp3buf;
      if (numChannels === 1) {
        mp3buf = encoder.encodeBuffer(leftBlock);
      } else {
        const rightBlock = right.subarray(i, end);
        mp3buf = encoder.encodeBuffer(leftBlock, rightBlock);
      }

      if (mp3buf.length > 0) {
        mp3Chunks.push(mp3buf);
      }
    }

    // Flush remaining data.
    const tail = encoder.flush();
    if (tail.length > 0) {
      mp3Chunks.push(tail);
    }

    // Combine chunks into a single ArrayBuffer.
    const totalLength = mp3Chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const mp3Data = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of mp3Chunks) {
      mp3Data.set(chunk, offset);
      offset += chunk.length;
    }

    return mp3Data.buffer;
  }

  // -------------------------------------------------------------------------
  // FLAC encoding
  // -------------------------------------------------------------------------

  /**
   * Encode audio to FLAC format.
   *
   * FLAC encoding in the browser requires a dedicated library (e.g. flac.js).
   * This method returns null when the library is not available.
   *
   * @param {Float32Array[]} channelData
   * @param {number}         sampleRate
   * @returns {Promise<ArrayBuffer|null>}
   */
  static async encodeFlac(channelData, sampleRate) {
    // Check for a FLAC encoder.
    const flacEncoder = globalThis.Flac || globalThis.FlacEncoder;

    if (!flacEncoder) {
      console.warn(
        '[AudioEncoders] FLAC encoding requires flac.js or libflac.js. ' +
          'Include the library (https://github.com/nickreserved/libflac.js) to enable FLAC export.',
      );
      return null;
    }

    // If a FLAC library is available, delegate to it.
    // This is a placeholder for the actual integration which depends on
    // the specific FLAC library API.
    console.warn(
      '[AudioEncoders] FLAC encoding integration is a placeholder. ' +
        'Wire up your preferred FLAC encoder library here.',
    );
    return null;
  }

  // -------------------------------------------------------------------------
  // Download trigger
  // -------------------------------------------------------------------------

  /**
   * Trigger a browser file download.
   *
   * @param {ArrayBuffer|Blob} buffer    File content.
   * @param {string}           filename  Suggested filename.
   * @param {string}           mimeType  e.g. 'audio/wav', 'audio/mpeg'.
   */
  static createDownload(buffer, filename, mimeType) {
    const blob = buffer instanceof Blob
      ? buffer
      : new Blob([buffer], { type: mimeType });

    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);

    a.click();

    // Clean up after a short delay to ensure the download starts.
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 1000);
  }

  // -------------------------------------------------------------------------
  // Batch ZIP
  // -------------------------------------------------------------------------

  /**
   * Create a ZIP archive from an array of files.
   *
   * This is a minimal but fully-functional ZIP implementation that produces
   * valid archives compatible with all major ZIP tools.  Files are stored
   * uncompressed (method 0 / STORE) for maximum compatibility and speed.
   *
   * @param {Array<{ name: string, buffer: ArrayBuffer }>} files
   * @returns {Promise<ArrayBuffer>} Complete ZIP file.
   */
  static async createBatchZip(files) {
    if (!files || files.length === 0) {
      throw new Error('createBatchZip: files array must not be empty');
    }

    const localHeaders = [];
    const centralHeaders = [];
    let localOffset = 0;

    for (const file of files) {
      const nameBytes = new TextEncoder().encode(file.name);
      const fileData = new Uint8Array(file.buffer);
      const crc = crc32(fileData);

      // ---- Local file header (30 + nameLen + dataLen) ----
      const localHeaderSize = 30 + nameBytes.length;
      const localEntry = new ArrayBuffer(localHeaderSize + fileData.length);
      const lView = new DataView(localEntry);
      let lOff = 0;

      lView.setUint32(lOff, 0x04034b50, true);      lOff += 4;  // Local file header signature
      lView.setUint16(lOff, 20, true);               lOff += 2;  // Version needed to extract (2.0)
      lView.setUint16(lOff, 0, true);                lOff += 2;  // General purpose bit flag
      lView.setUint16(lOff, 0, true);                lOff += 2;  // Compression method: 0 = STORE
      lView.setUint16(lOff, 0, true);                lOff += 2;  // Last mod time
      lView.setUint16(lOff, 0x0021, true);           lOff += 2;  // Last mod date (1980-01-01)
      lView.setUint32(lOff, crc, true);              lOff += 4;  // CRC-32
      lView.setUint32(lOff, fileData.length, true);  lOff += 4;  // Compressed size
      lView.setUint32(lOff, fileData.length, true);  lOff += 4;  // Uncompressed size
      lView.setUint16(lOff, nameBytes.length, true); lOff += 2;  // Filename length
      lView.setUint16(lOff, 0, true);                lOff += 2;  // Extra field length

      // Filename
      new Uint8Array(localEntry, lOff, nameBytes.length).set(nameBytes);
      lOff += nameBytes.length;

      // File data
      new Uint8Array(localEntry, lOff, fileData.length).set(fileData);

      localHeaders.push(new Uint8Array(localEntry));

      // ---- Central directory header (46 + nameLen) ----
      const centralHeaderSize = 46 + nameBytes.length;
      const centralEntry = new ArrayBuffer(centralHeaderSize);
      const cView = new DataView(centralEntry);
      let cOff = 0;

      cView.setUint32(cOff, 0x02014b50, true);      cOff += 4;  // Central directory signature
      cView.setUint16(cOff, 20, true);               cOff += 2;  // Version made by
      cView.setUint16(cOff, 20, true);               cOff += 2;  // Version needed to extract
      cView.setUint16(cOff, 0, true);                cOff += 2;  // General purpose bit flag
      cView.setUint16(cOff, 0, true);                cOff += 2;  // Compression method: STORE
      cView.setUint16(cOff, 0, true);                cOff += 2;  // Last mod time
      cView.setUint16(cOff, 0x0021, true);           cOff += 2;  // Last mod date
      cView.setUint32(cOff, crc, true);              cOff += 4;  // CRC-32
      cView.setUint32(cOff, fileData.length, true);  cOff += 4;  // Compressed size
      cView.setUint32(cOff, fileData.length, true);  cOff += 4;  // Uncompressed size
      cView.setUint16(cOff, nameBytes.length, true); cOff += 2;  // Filename length
      cView.setUint16(cOff, 0, true);                cOff += 2;  // Extra field length
      cView.setUint16(cOff, 0, true);                cOff += 2;  // File comment length
      cView.setUint16(cOff, 0, true);                cOff += 2;  // Disk number start
      cView.setUint16(cOff, 0, true);                cOff += 2;  // Internal file attributes
      cView.setUint32(cOff, 0, true);                cOff += 4;  // External file attributes
      cView.setUint32(cOff, localOffset, true);      cOff += 4;  // Relative offset of local header

      // Filename
      new Uint8Array(centralEntry, cOff, nameBytes.length).set(nameBytes);

      centralHeaders.push(new Uint8Array(centralEntry));

      localOffset += localEntry.byteLength;
    }

    // ---- End of Central Directory Record (EOCD) ----
    const centralDirSize = centralHeaders.reduce((sum, h) => sum + h.length, 0);
    const centralDirOffset = localOffset;

    const eocdSize = 22;
    const eocd = new ArrayBuffer(eocdSize);
    const eView = new DataView(eocd);
    let eOff = 0;

    eView.setUint32(eOff, 0x06054b50, true);               eOff += 4;  // EOCD signature
    eView.setUint16(eOff, 0, true);                         eOff += 2;  // Disk number
    eView.setUint16(eOff, 0, true);                         eOff += 2;  // Disk with central dir
    eView.setUint16(eOff, files.length, true);              eOff += 2;  // Entries on this disk
    eView.setUint16(eOff, files.length, true);              eOff += 2;  // Total entries
    eView.setUint32(eOff, centralDirSize, true);            eOff += 4;  // Central dir size
    eView.setUint32(eOff, centralDirOffset, true);          eOff += 4;  // Central dir offset
    eView.setUint16(eOff, 0, true);                         eOff += 2;  // Comment length

    // ---- Assemble final ZIP buffer ----
    const totalSize = localOffset + centralDirSize + eocdSize;
    const zipBuffer = new Uint8Array(totalSize);
    let writeOffset = 0;

    for (const header of localHeaders) {
      zipBuffer.set(header, writeOffset);
      writeOffset += header.length;
    }
    for (const header of centralHeaders) {
      zipBuffer.set(header, writeOffset);
      writeOffset += header.length;
    }
    zipBuffer.set(new Uint8Array(eocd), writeOffset);

    return zipBuffer.buffer;
  }

  // -------------------------------------------------------------------------
  // Manifest
  // -------------------------------------------------------------------------

  /**
   * Generate a JSON manifest for a batch export.
   *
   * @param {Array<{ name: string, buffer: ArrayBuffer }>} files
   * @param {object} config  Export configuration / metadata.
   * @returns {string} JSON string.
   */
  static generateManifest(files, config = {}) {
    const manifest = {
      generator: 'VoiceIsolate Pro v9.0',
      createdAt: new Date().toISOString(),
      config,
      files: files.map((f) => ({
        name: f.name,
        size: f.buffer ? f.buffer.byteLength : 0,
      })),
      fileCount: files.length,
      totalSize: files.reduce((sum, f) => sum + (f.buffer ? f.buffer.byteLength : 0), 0),
    };

    return JSON.stringify(manifest, null, 2);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers (module-private)
// ---------------------------------------------------------------------------

/**
 * Write an ASCII string into a DataView at the given offset.
 *
 * @param {DataView} view
 * @param {number}   offset
 * @param {string}   str
 */
function writeString(view, offset, str) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

/**
 * Clamp a number between min and max.
 *
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

/**
 * Compute CRC-32 for a Uint8Array (used by ZIP file format).
 *
 * Uses a pre-computed lookup table for performance.
 *
 * @param {Uint8Array} data
 * @returns {number} Unsigned 32-bit CRC.
 */
function crc32(data) {
  // Build lookup table on first call and cache it.
  if (!crc32._table) {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[i] = c;
    }
    crc32._table = table;
  }

  const table = crc32._table;
  let crc = 0xFFFFFFFF;

  for (let i = 0; i < data.length; i++) {
    crc = table[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  }

  return (crc ^ 0xFFFFFFFF) >>> 0;
}
