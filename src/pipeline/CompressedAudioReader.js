/**
 * Sequential compressed-audio reader for chunked extraction.
 *
 * MP4/M4A AAC and MPEG-1 Layer III are demuxed locally and decoded with
 * WebCodecs when the browser provides AudioDecoder. Packet bytes stay in the
 * source file; only the current PCM window is materialized. There is no
 * media-element fallback here: a realtime capture that cannot be aligned
 * would shift the recording, and a shifted file is not a successful extract.
 */
'use strict';

import { SAMPLE_RATE, MAX_CHANNELS } from '../core/audio-config.js';
import { resampleWindow, sourceSpan } from './resample-window.js';

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function fourcc(buf, at) {
  return String.fromCharCode(buf[at], buf[at + 1], buf[at + 2], buf[at + 3]);
}

function* walkBoxes(buf, start, end) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let at = start;
  while (at + 8 <= end) {
    let size = view.getUint32(at);
    const type = fourcc(buf, at + 4);
    let header = 8;
    if (size === 1) {
      if (at + 16 > end) return;
      size = Number(view.getBigUint64(at + 8));
      header = 16;
    } else if (size === 0) {
      size = end - at;
    }
    if (!Number.isFinite(size) || size < header || at + size > end) return;
    yield { type, start: at + header, end: at + size };
    at += size;
  }
}

function findChild(buf, start, end, type) {
  for (const box of walkBoxes(buf, start, end)) {
    if (box.type === type) return box;
  }
  return null;
}

function readDescLen(buf, offset, end) {
  let len = 0;
  let n = 0;
  while (n < 4 && offset + n < end) {
    const b = buf[offset + n];
    n += 1;
    len = (len << 7) | (b & 0x7f);
    if ((b & 0x80) === 0) break;
  }
  return { len, next: offset + n };
}

function audioSpecificConfig(buf, esds) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let at = esds.start + 4;
  const end = esds.end;
  while (at + 2 <= end) {
    const tag = buf[at];
    const { len, next } = readDescLen(buf, at + 1, end);
    const body = next;
    if (tag === 0x05 && body + len <= end) return buf.subarray(body, body + len);
    if (tag === 0x03 || tag === 0x04) {
      at = body + (tag === 0x03 ? 3 : 13);
      continue;
    }
    at = body + len;
  }
  void view;
  return null;
}

function parseStsd(buf, box) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const count = view.getUint32(box.start + 4);
  if (!count) return null;
  let at = box.start + 8;
  if (at + 8 > box.end) return null;
  const entryEnd = at + view.getUint32(at);
  const type = fourcc(buf, at + 4);
  if (type !== 'mp4a' || entryEnd > box.end) return null;
  const channels = view.getUint16(at + 16 + 8);
  const rateFixed = view.getUint32(at + 16 + 16);
  const sampleRate = rateFixed >>> 16;
  let description = null;
  for (const child of walkBoxes(buf, at + 36, Math.min(entryEnd, box.end))) {
    if (child.type === 'esds') description = audioSpecificConfig(buf, child);
  }
  return { codec: 'mp4a.40.2', channels, sampleRate, description };
}

function parseElstMediaTime(buf, trak) {
  const edts = findChild(buf, trak.start, trak.end, 'edts');
  if (!edts) return 0;
  const elst = findChild(buf, edts.start, edts.end, 'elst');
  if (!elst) return 0;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const version = buf[elst.start];
  const count = view.getUint32(elst.start + 4);
  if (!count) return 0;
  if (version === 1) {
    if (elst.start + 24 > elst.end) return 0;
    const mediaTime = view.getBigInt64(elst.start + 16);
    return mediaTime > 0n ? Number(mediaTime) : 0;
  }
  if (elst.start + 16 > elst.end) return 0;
  const mediaTime = view.getInt32(elst.start + 12);
  return mediaTime > 0 ? mediaTime : 0;
}

function parseMdhdTimescale(buf, box) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const version = buf[box.start];
  const at = box.start + 4 + (version === 1 ? 16 : 8);
  if (at + 4 > box.end) return null;
  return view.getUint32(at);
}

function readMvhdDuration(bytes, data, moov) {
  const movieHeader = findChild(bytes, moov.start, moov.end, 'mvhd');
  if (!movieHeader) return null;
  const version = bytes[movieHeader.start];
  if (version !== 0 && version !== 1) return null;
  const timescaleOffset = movieHeader.start + (version === 1 ? 20 : 12);
  const durationOffset = movieHeader.start + (version === 1 ? 24 : 16);
  const durationBytes = version === 1 ? 8 : 4;
  if (timescaleOffset + 4 > movieHeader.end || durationOffset + durationBytes > movieHeader.end) return null;
  const timescale = data.getUint32(timescaleOffset);
  const rawTicks = version === 1 ? data.getBigUint64(durationOffset) : BigInt(data.getUint32(durationOffset));
  const unknownTicks = rawTicks === 0n || rawTicks === 0xffffffffn || rawTicks === 0xffffffffffffffffn;
  const ticks = unknownTicks || rawTicks > BigInt(Number.MAX_SAFE_INTEGER) ? 0 : Number(rawTicks);
  return { timescale, ticks };
}

function readMehdTicks(bytes, data, moov, mvex) {
  const mehd = mvex ? findChild(bytes, mvex.start, mvex.end, 'mehd') : null;
  if (!mehd) return 0;
  const fragmentVersion = bytes[mehd.start];
  const fragmentOffset = mehd.start + 4;
  const fragmentTicks = fragmentVersion === 1 && fragmentOffset + 8 <= mehd.end
    ? data.getBigUint64(fragmentOffset)
    : fragmentOffset + 4 <= mehd.end ? BigInt(data.getUint32(fragmentOffset)) : 0n;
  return fragmentTicks > 0n && fragmentTicks <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(fragmentTicks) : 0;
}

function readMp4Tracks(bytes, data, moov, movieTimescale) {
  const tracks = [];
  for (const trak of walkBoxes(bytes, moov.start, moov.end)) {
    if (trak.type !== 'trak') continue;
    const mdia = findChild(bytes, trak.start, trak.end, 'mdia');
    if (!mdia) continue;
    const mdhd = findChild(bytes, mdia.start, mdia.end, 'mdhd');
    const hdlr = findChild(bytes, mdia.start, mdia.end, 'hdlr');
    const tkhd = findChild(bytes, trak.start, trak.end, 'tkhd');
    const minf = findChild(bytes, mdia.start, mdia.end, 'minf');
    const stbl = minf ? findChild(bytes, minf.start, minf.end, 'stbl') : null;
    const handler = hdlr && hdlr.start + 12 <= hdlr.end ? fourcc(bytes, hdlr.start + 8) : '';
    let id = null;
    let tkhdSeconds = null;
    if (tkhd) {
      const version = bytes[tkhd.start];
      if (version === 0 || version === 1) {
        const idOffset = tkhd.start + (version === 1 ? 20 : 12);
        const durationOffset = tkhd.start + (version === 1 ? 28 : 20);
        const durationBytes = version === 1 ? 8 : 4;
        if (idOffset + 4 <= tkhd.end && durationOffset + durationBytes <= tkhd.end) {
          id = data.getUint32(idOffset);
          const raw = version === 1 ? data.getBigUint64(durationOffset) : BigInt(data.getUint32(durationOffset));
          const ticks = raw > BigInt(Number.MAX_SAFE_INTEGER) ? 0 : Number(raw);
          if (movieTimescale > 0 && ticks > 0) tkhdSeconds = ticks / movieTimescale;
        }
      }
    }
    let timescale = null;
    let mdhdSeconds = null;
    if (mdhd) {
      const version = bytes[mdhd.start];
      if (version === 0 || version === 1) {
        const timescaleOffset = mdhd.start + (version === 1 ? 20 : 12);
        const durationOffset = mdhd.start + (version === 1 ? 24 : 16);
        const durationBytes = version === 1 ? 8 : 4;
        if (timescaleOffset + 4 <= mdhd.end && durationOffset + durationBytes <= mdhd.end) {
          timescale = data.getUint32(timescaleOffset);
          const raw = version === 1 ? data.getBigUint64(durationOffset) : BigInt(data.getUint32(durationOffset));
          const ticks = raw > BigInt(Number.MAX_SAFE_INTEGER) ? 0 : Number(raw);
          if (timescale > 0 && ticks > 0) mdhdSeconds = ticks / timescale;
        }
      }
    }
    tracks.push({ id, handler, timescale, mdhdSeconds, tkhdSeconds, stbl });
  }
  return tracks;
}

function readMp4TrackDuration(tracks) {
  const audio = tracks.filter((t) => t.handler === 'soun');
  const pool = audio.length ? audio : tracks;
  let best = null;
  for (const track of pool) {
    const seconds = track.mdhdSeconds ?? track.tkhdSeconds;
    if (Number.isFinite(seconds) && seconds > 0) best = best == null ? seconds : Math.max(best, seconds);
  }
  return best;
}

function readMp4SttsSeconds(bytes, data, tracks) {
  const audio = tracks.find((t) => t.handler === 'soun' && t.timescale > 0 && t.stbl)
    || tracks.find((t) => t.timescale > 0 && t.stbl);
  if (!audio) return null;
  const stts = findChild(bytes, audio.stbl.start, audio.stbl.end, 'stts');
  if (!stts) return null;
  let total = 0;
  const count = data.getUint32(stts.start + 4);
  for (let i = 0; i < count; i++) {
    const o = stts.start + 8 + i * 8;
    if (o + 8 > stts.end) break;
    total += data.getUint32(o) * data.getUint32(o + 4);
  }
  const seconds = total / audio.timescale;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

async function readMp4FragmentDuration(file, moofs, tracks, { signal, maxMoofBytes }) {
  const byTrack = new Map();
  const cursor = new Map();
  for (const { at, size } of moofs) {
    if (signal?.aborted) throw fail('ABORT_ERR', 'MP4 metadata read cancelled');
    if (size > maxMoofBytes) return null;
    const bytes = new Uint8Array(await file.slice(at, at + size).arrayBuffer());
    const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let headerBytes = 8;
    if (bytes.length >= 16 && data.getUint32(0) === 1) headerBytes = 16;
    for (const traf of walkBoxes(bytes, headerBytes, bytes.length)) {
      if (traf.type !== 'traf') continue;
      const tfhd = findChild(bytes, traf.start, traf.end, 'tfhd');
      if (!tfhd) continue;
      const trackId = data.getUint32(tfhd.start + 4);
      const track = tracks.find((t) => t.id === trackId);
      if (!track || !track.timescale) continue;
      const flags = (bytes[tfhd.start + 1] << 16) | (bytes[tfhd.start + 2] << 8) | bytes[tfhd.start + 3];
      let p = tfhd.start + 8;
      if (flags & 0x000001) p += 8;
      if (flags & 0x000002) p += 4;
      let defaultDuration = 0;
      if (flags & 0x000008) {
        if (p + 4 > tfhd.end) continue;
        defaultDuration = data.getUint32(p);
        p += 4;
      }
      const tfdt = findChild(bytes, traf.start, traf.end, 'tfdt');
      let startTicks = null;
      if (tfdt) {
        const version = bytes[tfdt.start];
        if (version === 1 && tfdt.start + 12 <= tfdt.end) startTicks = Number(data.getBigUint64(tfdt.start + 4));
        else if (version === 0 && tfdt.start + 8 <= tfdt.end) startTicks = data.getUint32(tfdt.start + 4);
      }
      let fragTicks = null;
      for (const trun of walkBoxes(bytes, traf.start, traf.end)) {
        if (trun.type !== 'trun') continue;
        const tflags = (bytes[trun.start + 1] << 16) | (bytes[trun.start + 2] << 8) | bytes[trun.start + 3];
        const count = data.getUint32(trun.start + 4);
        let ep = trun.start + 8;
        if (tflags & 0x000001) ep += 4;
        if (tflags & 0x000004) ep += 4;
        const entrySize = 4 * ((tflags & 0x000100 ? 1 : 0) + (tflags & 0x000200 ? 1 : 0)
          + (tflags & 0x000400 ? 1 : 0) + (tflags & 0x000800 ? 1 : 0));
        if (tflags & 0x000100) {
          let sum = 0;
          for (let i = 0; i < count; i++) {
            const o = ep + i * entrySize;
            if (o + 4 > trun.end) break;
            sum += data.getUint32(o);
          }
          fragTicks = (fragTicks ?? 0) + sum;
        } else if (defaultDuration > 0) {
          fragTicks = (fragTicks ?? 0) + defaultDuration * count;
        }
      }
      const list = byTrack.get(trackId) || [];
      const start = startTicks ?? cursor.get(trackId) ?? 0;
      list.push({ start, duration: fragTicks });
      cursor.set(trackId, fragTicks != null ? start + fragTicks : start);
      byTrack.set(trackId, list);
    }
  }
  let audioSeconds = null;
  let anySeconds = null;
  for (const [trackId, list] of byTrack) {
    const track = tracks.find((t) => t.id === trackId);
    if (!track || !track.timescale) continue;
    let prevStep = null;
    for (let i = 0; i < list.length; i++) {
      if (list[i].duration == null) {
        const next = list[i + 1];
        if (next) list[i].duration = Math.max(0, next.start - list[i].start);
        else if (prevStep != null) list[i].duration = prevStep;
        else list[i].duration = 0;
      }
      if (list[i].duration > 0) prevStep = list[i].duration;
    }
    let endTicks = 0;
    for (const frag of list) endTicks = Math.max(endTicks, frag.start + (frag.duration ?? 0));
    const seconds = endTicks / track.timescale;
    if (!Number.isFinite(seconds) || seconds <= 0) continue;
    anySeconds = anySeconds == null ? seconds : Math.max(anySeconds, seconds);
    if (track.handler === 'soun') audioSeconds = audioSeconds == null ? seconds : Math.max(audioSeconds, seconds);
  }
  return audioSeconds ?? anySeconds;
}

/**
 * Read the container-level movie duration from a bounded MP4 `moov` box.
 * This works for ordinary video MP4s even when the browser cannot expose
 * media-element metadata and no local AAC decoder is available.
 * @param {Blob} file
 * @param {{signal?: AbortSignal, maxMoovBytes?: number, moovHeaderBytes?: number}} [options]
 * @returns {Promise<{duration: number, source: string}|null>} duration in seconds and which header supplied it
 */
export async function parseMp4Duration(file, options = {}) {
  const signal = options.signal || null;
  const maxMoovBytes = Math.min(64 * 1024 * 1024, Math.max(1024, options.maxMoovBytes || 32 * 1024 * 1024));
  const moovHeaderBytes = Math.min(8 * 1024 * 1024, Math.max(1024, options.moovHeaderBytes || 1024 * 1024));
  const maxTopBoxes = 8192;
  const maxMoofs = 8192;
  const maxMoofBytes = 1024 * 1024;
  // Pass 1: walk the top-level boxes. Collect the moov position and every
  // moof position; a box whose declared size runs past EOF means the file
  // was cut off, which is a container error, not an unknown duration.
  let moovAt = -1;
  let moovSize = 0;
  let moovHeader = 8;
  const moofs = [];
  let moofsComplete = true;
  let at = 0;
  for (let count = 0; count < maxTopBoxes && at + 8 <= file.size; count++) {
    if (signal?.aborted) throw fail('ABORT_ERR', 'MP4 metadata read cancelled');
    const header = new Uint8Array(await file.slice(at, Math.min(file.size, at + 16)).arrayBuffer());
    if (header.length < 8) { moofsComplete = false; break; }
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    let size = view.getUint32(0);
    const type = fourcc(header, 4);
    let headerBytes = 8;
    if (size === 1) {
      if (header.length < 16) { moofsComplete = false; break; }
      size = Number(view.getBigUint64(8));
      headerBytes = 16;
    } else if (size === 0) {
      size = file.size - at;
    }
    if (!Number.isSafeInteger(size) || size < headerBytes) { moofsComplete = false; break; }
    if (at + size > file.size) {
      if (type === 'moov' || moovAt < 0) {
        throw fail('INCOMPLETE_CONTAINER', '[VIP][FileIngestion] The MP4 movie header (moov) is incomplete — the file may have been truncated during download or export. Re-export or re-download the file and try again.');
      }
      break;
    }
    if (type === 'moov' && moovAt < 0) {
      moovAt = at;
      moovSize = size;
      moovHeader = headerBytes;
    } else if (type === 'moof' && moofs.length < maxMoofs) {
      moofs.push({ at, size });
    }
    at += size;
  }
  if (at + 8 <= file.size) moofsComplete = false;
  if (moovAt < 0) {
    // No moov at all, and the file ends mid-box: the header the duration
    // lives in never arrived. A clean walk with no moov is not an MP4
    // duration source at all, so it falls through to the media probe.
    if (at < file.size && at + 8 > file.size) {
      throw fail('INCOMPLETE_CONTAINER', '[VIP][FileIngestion] The file ends before its MP4 movie header (moov) — the file may have been truncated during download or export. Re-export or re-download the file and try again.');
    }
    return null;
  }
  // Pass 2: read the moov. A huge moov is read as a bounded header window:
  // mvhd/mehd and the track headers live at its start, so the duration
  // sources that need them still resolve without loading tens of megabytes.
  const moovComplete = moovSize <= maxMoovBytes;
  const take = moovComplete ? moovSize : Math.min(moovSize, moovHeaderBytes);
  const bytes = new Uint8Array(await file.slice(moovAt, moovAt + take).arrayBuffer());
  if (signal?.aborted) throw fail('ABORT_ERR', 'MP4 metadata read cancelled');
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const moov = { start: moovHeader, end: bytes.length };
  const mvhd = readMvhdDuration(bytes, data, moov);
  const mvex = findChild(bytes, moov.start, moov.end, 'mvex');
  const tracks = readMp4Tracks(bytes, data, moov, mvhd?.timescale ?? 0);
  // Fragmented files: the moof timeline is authoritative. Encoders write a
  // stale or zero mvhd duration for them (10.031 s declared vs 12.023 s of
  // fragments is a real shape), so fragments outrank the movie header.
  if (mvex && moofs.length && moofsComplete) {
    const fragments = await readMp4FragmentDuration(file, moofs, tracks, { signal, maxMoofBytes });
    if (fragments != null) return { duration: fragments, source: 'mp4-fragments' };
  }
  if (mvhd && mvhd.timescale > 0 && mvhd.ticks > 0) {
    return { duration: mvhd.ticks / mvhd.timescale, source: 'mp4-mvhd' };
  }
  const mehdTicks = readMehdTicks(bytes, data, moov, mvex);
  if (mehdTicks > 0 && mvhd?.timescale > 0) {
    return { duration: mehdTicks / mvhd.timescale, source: 'mp4-mvhd' };
  }
  const trackSeconds = readMp4TrackDuration(tracks);
  if (trackSeconds != null) return { duration: trackSeconds, source: 'mp4-track' };
  if (moovComplete) {
    const sttsSeconds = readMp4SttsSeconds(bytes, data, tracks);
    if (sttsSeconds != null) return { duration: sttsSeconds, source: 'mp4-stts' };
  }
  return null;
}

function parseSampleTable(buf, stbl) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const stts = findChild(buf, stbl.start, stbl.end, 'stts');
  const stsc = findChild(buf, stbl.start, stbl.end, 'stsc');
  const stsz = findChild(buf, stbl.start, stbl.end, 'stsz');
  const stco = findChild(buf, stbl.start, stbl.end, 'stco') || findChild(buf, stbl.start, stbl.end, 'co64');
  if (!stts || !stsc || !stsz || !stco) return null;
  const wide = stco.type === 'co64';
  const deltas = [];
  const sttsCount = view.getUint32(stts.start + 4);
  for (let i = 0; i < sttsCount; i++) {
    const o = stts.start + 8 + i * 8;
    if (o + 8 > stts.end) break;
    deltas.push({ count: view.getUint32(o), delta: view.getUint32(o + 4) });
  }
  const stscCount = view.getUint32(stsc.start + 4);
  const chunks = [];
  for (let i = 0; i < stscCount; i++) {
    const o = stsc.start + 8 + i * 12;
    if (o + 12 > stsc.end) break;
    chunks.push({ first: view.getUint32(o), per: view.getUint32(o + 4) });
  }
  const sampleSize = view.getUint32(stsz.start + 4);
  const sampleCount = view.getUint32(stsz.start + 8);
  const sizes = new Array(sampleCount);
  if (sampleSize !== 0) sizes.fill(sampleSize);
  else {
    for (let i = 0; i < sampleCount; i++) sizes[i] = view.getUint32(stsz.start + 12 + i * 4);
  }
  const chunkCount = view.getUint32(stco.start + 4);
  const offsets = new Array(chunkCount);
  for (let i = 0; i < chunkCount; i++) {
    offsets[i] = wide
      ? Number(view.getBigUint64(stco.start + 8 + i * 8))
      : view.getUint32(stco.start + 8 + i * 4);
  }
  const perFor = (chunkIndex1) => {
    let per = chunks[0]?.per || 1;
    for (const row of chunks) {
      if (row.first <= chunkIndex1) per = row.per;
    }
    return per;
  };
  const samples = [];
  let sampleIndex = 0;
  let deltaRow = 0;
  let deltaLeft = deltas[0]?.count || 0;
  let time = 0;
  for (let c = 0; c < chunkCount && sampleIndex < sampleCount; c++) {
    const per = perFor(c + 1);
    let offset = offsets[c];
    for (let s = 0; s < per && sampleIndex < sampleCount; s++) {
      while (deltaRow < deltas.length && deltaLeft === 0) {
        deltaRow += 1;
        deltaLeft = deltas[deltaRow]?.count || 0;
      }
      const delta = deltas[deltaRow]?.delta || 0;
      samples.push({ offset, size: sizes[sampleIndex], time, duration: delta });
      offset += sizes[sampleIndex];
      time += delta;
      deltaLeft -= 1;
      sampleIndex += 1;
    }
  }
  return samples;
}

/** @returns {Promise<{codec:string, sampleRate:number, channels:number, description:Uint8Array|null, timescale:number, samples:object[]}|null>} */
export async function parseMp4Audio(file) {
  const boxes = [];
  let at = 0;
  let moovBuf = null;
  while (at + 8 <= file.size && boxes.length < 64) {
    const headBuf = await file.slice(at, Math.min(file.size, at + 16)).arrayBuffer();
    const head = new Uint8Array(headBuf);
    const view = new DataView(headBuf);
    let size = view.getUint32(0);
    const type = fourcc(head, 4);
    let header = 8;
    if (size === 1 && head.length >= 16) {
      size = Number(view.getBigUint64(8));
      header = 16;
    } else if (size === 0) size = file.size - at;
    if (!Number.isFinite(size) || size < header) break;
    boxes.push(type);
    if (type === 'moov') {
      moovBuf = new Uint8Array(await file.slice(at, at + size).arrayBuffer());
      break;
    }
    at += size;
  }
  if (!moovBuf) return null;
  const moov = findChild(moovBuf, 0, moovBuf.length, 'moov');
  if (!moov) return null;
  let audio = null;
  let samples = null;
  let timescale = null;
  for (const trak of walkBoxes(moovBuf, moov.start, moov.end)) {
    if (trak.type !== 'trak') continue;
    const mdia = findChild(moovBuf, trak.start, trak.end, 'mdia');
    if (!mdia) continue;
    const mdhd = findChild(moovBuf, mdia.start, mdia.end, 'mdhd');
    const minf = findChild(moovBuf, mdia.start, mdia.end, 'minf');
    if (!minf) continue;
    const stbl = findChild(moovBuf, minf.start, minf.end, 'stbl');
    if (!stbl) continue;
    const stsd = findChild(moovBuf, stbl.start, stbl.end, 'stsd');
    const parsed = stsd ? parseStsd(moovBuf, stsd) : null;
    if (!parsed) continue;
    audio = parsed;
    timescale = mdhd ? parseMdhdTimescale(moovBuf, mdhd) : parsed.sampleRate;
    samples = parseSampleTable(moovBuf, stbl);
    const mediaTime = parseElstMediaTime(moovBuf, trak);
    const scale = timescale || parsed.sampleRate || 1;
    audio.primingFrames = Math.max(0, Math.round(mediaTime * parsed.sampleRate / scale));
    break;
  }
  if (!audio || !samples?.length) return null;
  return { ...audio, timescale: timescale || audio.sampleRate, samples };
}

function mp3FrameBytes(header) {
  const version = (header >>> 19) & 3;
  const layer = (header >>> 17) & 3;
  const bitrateIndex = (header >>> 12) & 0xf;
  const rateIndex = (header >>> 10) & 3;
  const padding = (header >>> 9) & 1;
  if (version !== 3 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return 0;
  const bitrates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
  const rates = [44100, 48000, 32000];
  return Math.floor((144 * bitrates[bitrateIndex] * 1000) / rates[rateIndex]) + padding;
}

/** Scan the first megabyte for MPEG-1 Layer III frames. Returns null if none. */
export async function parseMp3Frames(file) {
  const take = Math.min(file.size, 1024 * 1024);
  const buf = new Uint8Array(await file.slice(0, take).arrayBuffer());
  let at = 0;
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33 && buf.length >= 10) {
    const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    at = 10 + size;
  }
  const frames = [];
  let guard = 0;
  while (at + 4 <= buf.length && guard < 8) {
    const header = (buf[at] << 24) | (buf[at + 1] << 16) | (buf[at + 2] << 8) | buf[at + 3];
    const len = mp3FrameBytes(header >>> 0);
    if ((header >>> 21) === 0x7ff && len > 4) {
      frames.push({ offset: at, size: len });
      break;
    }
    at += 1;
    guard += 1;
  }
  if (!frames.length) return null;
  // Continue across the whole file using the first header's frame length pattern.
  const first = frames[0];
  const head = new DataView(buf.buffer, buf.byteOffset + first.offset, 4).getUint32(0);
  const rateIndex = (head >>> 10) & 3;
  const sampleRate = [44100, 48000, 32000][rateIndex];
  let cursor = first.offset;
  const all = [];
  let time = 0;
  const hop = 1152;
  let windowBuf = buf;
  let windowStart = 0;
  while (cursor + 4 <= file.size && all.length < 2_000_000) {
    if (cursor < windowStart || cursor + 4 > windowStart + windowBuf.length) {
      windowStart = cursor;
      const take = Math.min(file.size - cursor, 256 * 1024);
      windowBuf = new Uint8Array(await file.slice(cursor, cursor + take).arrayBuffer());
      if (windowBuf.length < 4) break;
    }
    const o = cursor - windowStart;
    const header = (windowBuf[o] << 24) | (windowBuf[o + 1] << 16) | (windowBuf[o + 2] << 8) | windowBuf[o + 3];
    const len = mp3FrameBytes(header >>> 0);
    if (!len || cursor + len > file.size) break;
    all.push({ offset: cursor, size: len, time, duration: hop });
    cursor += len;
    time += hop;
  }
  if (all.length < 2) return null;
  return { codec: 'mp3', sampleRate, channels: 2, description: null, timescale: sampleRate, samples: all };
}

function codecString(info) {
  if (info.codec === 'mp3') return 'mp3';
  if (info.description && info.description.length >= 2) {
    const objectType = (info.description[0] >> 3) & 0x1f;
    const freqIndex = ((info.description[0] & 0x07) << 1) | (info.description[1] >> 7);
    const freq = ['96000', '88200', '64000', '48000', '44100', '32000', '24000', '22050', '16000', '12000', '11025', '8000', '7350'][freqIndex];
    if (objectType === 2 && freq) return `mp4a.40.2`;
  }
  return info.codec || 'mp4a.40.2';
}

async function openDecoderStream(file, info) {
  if (typeof AudioDecoder === 'undefined' || typeof EncodedAudioChunk === 'undefined') return null;
  const pending = [];
  let failed = null;
  const decoder = new AudioDecoder({
    output: (data) => pending.push(data),
    error: (error) => { failed = error; },
  });
  const config = {
    codec: codecString(info),
    sampleRate: info.sampleRate,
    numberOfChannels: Math.min(MAX_CHANNELS, info.channels || 1),
  };
  if (info.description) config.description = info.description;
  const support = await AudioDecoder.isConfigSupported(config).catch(() => ({ supported: false }));
  if (!support?.supported) {
    decoder.close();
    return null;
  }
  decoder.configure(config);
  let sampleIndex = 0;
  const sourceRate = info.sampleRate;
  // decodedEnd is the absolute source frame just past the last kept sample.
  // baseFrame is the absolute source frame of kept[0][0][0].
  let decodedEnd = 0;
  let baseFrame = 0;
  let primingLeft = Math.max(0, info.primingFrames || 0);
  let flushed = false;
  const kept = Array.from({ length: config.numberOfChannels }, () => []);
  const timescale = info.timescale || sourceRate;

  function drain() {
    while (pending.length) {
      const data = pending.shift();
      const frames = data.numberOfFrames;
      const ch = Math.min(config.numberOfChannels, data.numberOfChannels);
      const skip = Math.min(primingLeft, frames);
      primingLeft -= skip;
      const keep = frames - skip;
      if (keep > 0) {
        for (let c = 0; c < config.numberOfChannels; c++) {
          const plane = new Float32Array(keep);
          if (c < ch) {
            const full = new Float32Array(frames);
            data.copyTo(full, { planeIndex: c, format: 'f32-planar' });
            plane.set(full.subarray(skip));
          }
          kept[c].push(plane);
        }
        decodedEnd += keep;
      }
      data.close();
    }
  }

  function waitDrained() {
    return new Promise((resolve, reject) => {
      const step = () => {
        if (failed) { reject(failed); return; }
        drain();
        if ((decoder.decodeQueueSize || 0) === 0 && pending.length === 0) resolve();
        else setTimeout(step, 0);
      };
      step();
    });
  }

  async function pumpUntil(sourceFrame) {
    while (decodedEnd < sourceFrame && sampleIndex < info.samples.length) {
      if (failed) throw failed;
      const limit = Math.min(info.samples.length, sampleIndex + 16);
      for (; sampleIndex < limit; sampleIndex++) {
        const sample = info.samples[sampleIndex];
        const bytes = new Uint8Array(await file.slice(sample.offset, sample.offset + sample.size).arrayBuffer());
        decoder.decode(new EncodedAudioChunk({
          type: 'key',
          timestamp: Math.round((sample.time / timescale) * 1e6),
          duration: Math.round((sample.duration / timescale) * 1e6),
          data: bytes,
        }));
      }
      if ((decoder.decodeQueueSize || 0) > 8) await waitDrained();
    }
    await waitDrained();
    // Flush only after the last packet. Flushing mid-stream resets some decoders.
    if (!flushed && decodedEnd < sourceFrame && sampleIndex >= info.samples.length) {
      flushed = true;
      await decoder.flush().catch((error) => { failed = error; });
      if (failed) throw failed;
      drain();
    }
  }

  function materialize(absStart, count) {
    const start = absStart - baseFrame;
    const out = kept.map(() => new Float32Array(count));
    if (start < 0) return out;
    const lengths = kept[0].map((p) => p.length);
    let offset = 0;
    let part = 0;
    while (part < lengths.length && offset + lengths[part] <= start) {
      offset += lengths[part];
      part += 1;
    }
    let dst = 0;
    while (dst < count && part < lengths.length) {
      const local = start + dst - offset;
      const take = Math.min(lengths[part] - Math.max(0, local), count - dst);
      if (take > 0) {
        for (let c = 0; c < out.length; c++) out[c].set(kept[c][part].subarray(Math.max(0, local), Math.max(0, local) + take), dst);
      }
      dst += Math.max(0, take);
      offset += lengths[part];
      part += 1;
    }
    return out;
  }

  function dropBefore(absFrame) {
    let drop = absFrame - baseFrame;
    if (drop <= 0) return;
    while (drop > 0 && kept[0].length && kept[0][0].length <= drop) {
      const n = kept[0][0].length;
      drop -= n;
      baseFrame += n;
      for (const list of kept) list.shift();
    }
    if (drop > 0 && kept[0].length && kept[0][0].length > drop) {
      for (let c = 0; c < kept.length; c++) kept[c][0] = kept[c][0].subarray(drop);
      baseFrame += drop;
    }
  }

  return {
    async read(canonStart, canonCount) {
      const span = sourceSpan(sourceRate, canonStart, canonCount);
      const srcStart = Math.max(0, span.srcStart);
      const srcEnd = Math.max(srcStart + 1, span.srcEnd);
      await pumpUntil(srcEnd);
      const src = materialize(srcStart, srcEnd - srcStart);
      const out = sourceRate === SAMPLE_RATE
        ? src.map((ch) => ch.subarray(0, canonCount))
        : resampleWindow(src, srcStart, sourceRate, canonStart, canonCount);
      dropBefore(Math.max(0, srcStart - sourceRate));
      return out;
    },
    close() {
      try { decoder.close(); } catch { /* already closed */ }
      for (const list of kept) list.length = 0;
    },
  };
}

/**
 * @param {Blob} file
 * @param {object} plan
 */
export async function openCompressedReader(file, plan) {
  const name = (file.name || '').toLowerCase();
  const type = (file.type || '').toLowerCase();
  let info = null;
  if (type.includes('mp4') || type.includes('m4a') || type.includes('aac') || /\.(m4a|mp4|aac)$/.test(name)) {
    info = await parseMp4Audio(file);
  } else if (type.includes('mpeg') || type.includes('mp3') || name.endsWith('.mp3')) {
    info = await parseMp3Frames(file);
  } else {
    info = await parseMp4Audio(file);
    if (!info) info = await parseMp3Frames(file);
  }
  if (!info) {
    throw fail('CHUNK_DECODER_UNAVAILABLE', '[VIP][ChunkedExtraction] This container has no local chunk decoder (WAV, M4A/AAC, and MP3 are windowed). The file was not modified.');
  }
  const stream = await openDecoderStream(file, info);
  if (!stream) {
    throw fail('CHUNK_DECODER_UNAVAILABLE', `[VIP][ChunkedExtraction] ${info.codec} was recognized but WebCodecs cannot decode it on this device. The file was not modified.`);
  }
  void plan;
  return stream;
}
