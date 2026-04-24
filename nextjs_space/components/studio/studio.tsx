'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  Play,
  Pause,
  Square,
  Download,
  Zap,
  SlidersHorizontal,
  Sparkles,
  Waves,
  Volume2,
  RefreshCcw,
  Save,
  Undo2,
  Redo2,
  Settings2,
  FileAudio2,
  Gauge,
  Filter as FilterIcon,
  Radio as RadioIcon,
  Repeat,
  ChevronRight,
} from 'lucide-react';

import { UploadZone } from './upload-zone';
import { Waveform } from './waveform';
import { Spectrum } from './spectrum';
import { VUMeter } from './vu-meter';
import { SliderField } from './slider-field';
import { PresetGrid } from './preset-grid';
import { ControlsPanel } from './controls-panel';

import { DSPSettings, defaultSettings, PRESETS, PresetName } from '@/lib/dsp/types';
import { buildDSPGraph, processBuffer } from '@/lib/dsp/pipeline';
import { decodeAudioFromFile, formatTime } from '@/lib/dsp/media';
import { audioBufferToWav, audioBufferToMp3, downloadBlob } from '@/lib/dsp/encoders';

type PlaySource = 'orig' | 'proc';

export default function Studio() {
  const [file, setFile] = useState<File | null>(null);
  const [origBuf, setOrigBuf] = useState<AudioBuffer | null>(null);
  const [procBuf, setProcBuf] = useState<AudioBuffer | null>(null);
  const [settings, setSettings] = useState<DSPSettings>(defaultSettings);
  const [activePreset, setActivePreset] = useState<PresetName | null>('podcast');
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState({ pct: 0, stage: '' });
  const [isPlaying, setIsPlaying] = useState(false);
  const [playSource, setPlaySource] = useState<PlaySource>('orig');
  const [playhead, setPlayhead] = useState(0);
  const [volume, setVolume] = useState(0.9);
  const [livePreview, setLivePreview] = useState(true);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportFormat, setExportFormat] = useState<'wav' | 'mp3'>('wav');
  const [exportBitrate, setExportBitrate] = useState<128 | 192 | 256 | 320>(192);
  const [wavBitDepth, setWavBitDepth] = useState<16 | 24>(16);

  const [history, setHistory] = useState<DSPSettings[]>([defaultSettings]);
  const [historyIndex, setHistoryIndex] = useState(0);

  // Audio context + nodes
  const ctxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const outGainRef = useRef<GainNode | null>(null);
  const [analyserStamp, setAnalyserStamp] = useState(0);
  const startOffsetRef = useRef(0);
  const startedAtRef = useRef(0);
  const rafRef = useRef<number | null>(null);

  // Initialise AudioContext lazily on user interaction
  const ensureCtx = useCallback(() => {
    if (!ctxRef.current) {
      const AC: typeof AudioContext = window.AudioContext ?? (window as any).webkitAudioContext;
      ctxRef.current = new AC();
    }
    if (ctxRef.current.state === 'suspended') ctxRef.current.resume().catch(() => {});
    return ctxRef.current;
  }, []);

  // Load file into origBuf
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!file) {
        setOrigBuf(null);
        setProcBuf(null);
        return;
      }
      try {
        toast.loading('Decoding audio…', { id: 'decode' });
        const { buffer } = await decodeAudioFromFile(file);
        if (cancelled) return;
        setOrigBuf(buffer);
        setProcBuf(null);
        setPlayhead(0);
        startOffsetRef.current = 0;
        toast.success(
          `Loaded • ${Math.round(buffer.duration)}s • ${buffer.sampleRate} Hz • ${buffer.numberOfChannels}ch`,
          { id: 'decode' }
        );
      } catch (e: any) {
        console.error('Decode error', e);
        toast.error('Could not decode this file. It may be corrupt or use an unsupported codec.', {
          id: 'decode',
        });
        setOrigBuf(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [file]);

  // Auto-apply chosen preset settings when preset changes
  const applyPreset = useCallback((name: PresetName) => {
    const p = PRESETS.find((x) => x.id === name);
    if (!p) return;
    setSettings((prev) => {
      const next = { ...prev, ...p.settings } as DSPSettings;
      pushHistory(next);
      return next;
    });
    setActivePreset(name);
    toast.success(`Preset: ${p.label}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pushHistory = useCallback((next: DSPSettings) => {
    setHistory((h) => {
      setHistoryIndex((idx) => {
        const truncated = h.slice(0, idx + 1);
        const appended = [...truncated, next].slice(-50);
        return appended.length - 1;
      });
      const truncated = h.slice(0, historyIndex + 1);
      return [...truncated, next].slice(-50);
    });
  }, [historyIndex]);

  const updateSetting = useCallback(
    <K extends keyof DSPSettings>(key: K, value: DSPSettings[K]) => {
      setSettings((prev) => {
        const next = { ...prev, [key]: value };
        return next;
      });
      setActivePreset(null);
    },
    []
  );

  const commitHistory = useCallback(() => {
    setHistory((h) => {
      const truncated = h.slice(0, historyIndex + 1);
      const last = truncated[truncated.length - 1];
      if (last && shallowEqual(last, settings)) return h;
      const appended = [...truncated, settings].slice(-50);
      setHistoryIndex(appended.length - 1);
      return appended;
    });
  }, [historyIndex, settings]);

  const canUndo = historyIndex > 0;
  const canRedo = historyIndex < history.length - 1;

  const undo = useCallback(() => {
    if (!canUndo) return;
    const idx = historyIndex - 1;
    const prev = history[idx];
    if (prev) {
      setSettings(prev);
      setHistoryIndex(idx);
      setActivePreset(null);
    }
  }, [canUndo, history, historyIndex]);

  const redo = useCallback(() => {
    if (!canRedo) return;
    const idx = historyIndex + 1;
    const next = history[idx];
    if (next) {
      setSettings(next);
      setHistoryIndex(idx);
      setActivePreset(null);
    }
  }, [canRedo, history, historyIndex]);

  const reset = useCallback(() => {
    setSettings(defaultSettings);
    setActivePreset(null);
    pushHistory(defaultSettings);
    toast.success('Settings reset');
  }, [pushHistory]);

  // Custom user presets (localStorage)
  const [customPresets, setCustomPresets] = useState<Record<string, DSPSettings>>({});
  useEffect(() => {
    try {
      const raw = localStorage.getItem('vi_custom_presets');
      if (raw) setCustomPresets(JSON.parse(raw) ?? {});
    } catch {}
  }, []);
  const saveCustomPreset = useCallback(() => {
    const name = typeof window !== 'undefined' ? window.prompt('Save preset as:') : null;
    if (!name) return;
    const next = { ...customPresets, [name]: settings };
    setCustomPresets(next);
    try {
      localStorage.setItem('vi_custom_presets', JSON.stringify(next));
    } catch {}
    toast.success(`Saved preset “${name}”`);
  }, [customPresets, settings]);

  const loadCustomPreset = useCallback((name: string) => {
    const cp = customPresets[name];
    if (!cp) return;
    setSettings(cp);
    pushHistory(cp);
    setActivePreset(null);
    toast.success(`Loaded “${name}”`);
  }, [customPresets, pushHistory]);

  const deleteCustomPreset = useCallback((name: string) => {
    const next = { ...customPresets };
    delete next[name];
    setCustomPresets(next);
    try {
      localStorage.setItem('vi_custom_presets', JSON.stringify(next));
    } catch {}
    toast.success(`Deleted “${name}”`);
  }, [customPresets]);

  // Stop + teardown playback nodes
  const stopPlayback = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    try {
      sourceRef.current?.stop();
    } catch {}
    try {
      sourceRef.current?.disconnect();
    } catch {}
    sourceRef.current = null;
    setIsPlaying(false);
  }, []);

  useEffect(() => {
    return () => {
      stopPlayback();
      try {
        ctxRef.current?.close();
      } catch {}
    };
  }, [stopPlayback]);

  // Start playback of a given source (orig or proc)
  const play = useCallback(
    (src: PlaySource, fromOffset?: number) => {
      const ctx = ensureCtx();
      const buf = src === 'orig' ? origBuf : procBuf;
      if (!buf) {
        if (src === 'proc') toast.info('Process the audio first to play the result.');
        return;
      }
      stopPlayback();

      const bufferSource = ctx.createBufferSource();
      bufferSource.buffer = buf;
      sourceRef.current = bufferSource;

      // Build chain. If live preview, apply DSP graph on current settings;
      // otherwise pass through with gain + analyser.
      const out = ctx.createGain();
      out.gain.value = volume;
      outGainRef.current = out;

      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.7;
      analyserRef.current = analyser;

      let chain: AudioNode = bufferSource;
      if (livePreview && src === 'orig') {
        chain = buildDSPGraph(ctx, bufferSource, settings);
      }
      chain.connect(analyser);
      analyser.connect(out);
      out.connect(ctx.destination);

      const offset = fromOffset !== undefined ? fromOffset : startOffsetRef.current;
      const clampedOffset = Math.max(0, Math.min(offset, buf.duration - 0.01));
      startOffsetRef.current = clampedOffset;
      startedAtRef.current = ctx.currentTime;
      bufferSource.start(0, clampedOffset);
      setPlaySource(src);
      setIsPlaying(true);
      setAnalyserStamp((s) => s + 1);

      bufferSource.onended = () => {
        if (sourceRef.current !== bufferSource) return;
        sourceRef.current = null;
        setIsPlaying(false);
        // Loop end-of-track back to start
        startOffsetRef.current = 0;
        setPlayhead(0);
      };

      const tick = () => {
        rafRef.current = requestAnimationFrame(tick);
        const dur = buf.duration;
        const elapsed = ctx.currentTime - startedAtRef.current + clampedOffset;
        setPlayhead(Math.min(dur, Math.max(0, elapsed)));
      };
      rafRef.current = requestAnimationFrame(tick);
    },
    [ensureCtx, origBuf, procBuf, settings, livePreview, stopPlayback, volume]
  );

  const pause = useCallback(() => {
    if (!sourceRef.current || !ctxRef.current) return;
    startOffsetRef.current = playhead;
    stopPlayback();
  }, [playhead, stopPlayback]);

  const togglePlay = useCallback(
    (src: PlaySource) => {
      if (isPlaying && playSource === src) {
        pause();
      } else {
        play(src);
      }
    },
    [isPlaying, pause, play, playSource]
  );

  // Keep output gain in sync with volume
  useEffect(() => {
    if (outGainRef.current) outGainRef.current.gain.value = volume;
  }, [volume]);

  // Main processing action
  const runProcessing = useCallback(async () => {
    if (!origBuf) {
      toast.error('Upload an audio file first.');
      return;
    }
    if (processing) return;
    setProcessing(true);
    setProgress({ pct: 0, stage: 'Starting…' });
    try {
      const result = await processBuffer(origBuf, settings, (p) => {
        setProgress({ pct: Math.round(p.percent), stage: p.stage });
      });
      setProcBuf(result);
      setProgress({ pct: 100, stage: 'Complete' });
      toast.success('Processing complete');
      setPlaySource('proc');
    } catch (e: any) {
      console.error(e);
      toast.error('Processing failed: ' + (e?.message ?? 'unknown error'));
    } finally {
      setProcessing(false);
      setTimeout(() => setProgress({ pct: 0, stage: '' }), 2000);
    }
  }, [origBuf, processing, settings]);

  // Export processed audio
  const doExport = useCallback(async () => {
    if (!procBuf) {
      toast.error('Process the audio first, then export.');
      return;
    }
    setExportBusy(true);
    try {
      const base = (file?.name ?? 'voice').replace(/\.[^/.]+$/, '') + '_isolated';
      if (exportFormat === 'wav') {
        const blob = audioBufferToWav(procBuf, wavBitDepth);
        downloadBlob(blob, `${base}.wav`);
        toast.success(`Exported ${base}.wav`);
      } else {
        toast.loading('Encoding MP3…', { id: 'mp3' });
        const blob = await audioBufferToMp3(procBuf, exportBitrate, () => {});
        downloadBlob(blob, `${base}.mp3`);
        toast.success(`Exported ${base}.mp3`, { id: 'mp3' });
      }
    } catch (e: any) {
      console.error(e);
      toast.error('Export failed: ' + (e?.message ?? 'unknown'));
    } finally {
      setExportBusy(false);
    }
  }, [procBuf, file, exportFormat, exportBitrate, wavBitDepth]);

  const origDur = origBuf?.duration ?? 0;
  const procDur = procBuf?.duration ?? 0;

  const stats = useMemo(() => {
    if (!origBuf) return null;
    return {
      sampleRate: origBuf.sampleRate,
      channels: origBuf.numberOfChannels,
      duration: origBuf.duration,
      samples: origBuf.length,
    };
  }, [origBuf]);

  // Scrub through waveform
  const onScrub = useCallback(
    (pctFrac: number, source: PlaySource) => {
      const buf = source === 'orig' ? origBuf : procBuf;
      if (!buf) return;
      const t = Math.max(0, Math.min(buf.duration, pctFrac * buf.duration));
      startOffsetRef.current = t;
      setPlayhead(t);
      if (isPlaying && playSource === source) play(source, t);
    },
    [origBuf, procBuf, isPlaying, playSource, play]
  );

  return (
    <div className="relative z-10 mx-auto w-full max-w-[1280px] px-4 pb-12 sm:px-6">
      {/* Top control bar */}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/5 bg-white/[0.02] px-4 py-3 backdrop-blur-xl">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={undo}
            disabled={!canUndo}
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-white/5 bg-white/5 px-3 text-xs font-medium text-white/70 transition hover:bg-white/10 disabled:opacity-40"
          >
            <Undo2 className="h-3.5 w-3.5" /> Undo
          </button>
          <button
            type="button"
            onClick={redo}
            disabled={!canRedo}
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-white/5 bg-white/5 px-3 text-xs font-medium text-white/70 transition hover:bg-white/10 disabled:opacity-40"
          >
            <Redo2 className="h-3.5 w-3.5" /> Redo
          </button>
          <button
            type="button"
            onClick={reset}
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-white/5 bg-white/5 px-3 text-xs font-medium text-white/70 transition hover:bg-white/10"
          >
            <RefreshCcw className="h-3.5 w-3.5" /> Reset
          </button>
          <button
            type="button"
            onClick={saveCustomPreset}
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-white/5 bg-white/5 px-3 text-xs font-medium text-white/70 transition hover:bg-white/10"
          >
            <Save className="h-3.5 w-3.5" /> Save preset
          </button>
        </div>
        <div className="flex items-center gap-3 text-xs text-white/50">
          <label className="inline-flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={livePreview}
              onChange={(e) => setLivePreview(e.target.checked)}
              className="h-4 w-4 rounded border-white/20 bg-white/10 accent-indigo-500"
            />
            <span>Live preview on original</span>
          </label>
          <span className="hidden sm:inline text-white/20">•</span>
          <span className="hidden sm:inline font-mono">
            {stats ? `${stats.sampleRate} Hz • ${stats.channels}ch` : 'Ready'}
          </span>
        </div>
      </div>

      {/* Main grid */}
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-[300px_1fr_280px]">
        {/* LEFT column: upload + presets */}
        <div className="flex flex-col gap-4">
          <Panel title="Input" icon={<FileAudio2 className="h-3.5 w-3.5" />}>
            <UploadZone file={file} onFile={setFile} busy={processing} />
          </Panel>

          <Panel title="Presets" icon={<Sparkles className="h-3.5 w-3.5" />}>
            <PresetGrid active={activePreset} onSelect={applyPreset} />
            {Object.keys(customPresets).length > 0 ? (
              <div className="mt-3">
                <div className="mb-1 text-[10px] uppercase tracking-widest text-white/40">My presets</div>
                <div className="flex flex-col gap-1">
                  {Object.keys(customPresets).map((n) => (
                    <div key={n} className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => loadCustomPreset(n)}
                        className="flex-1 truncate rounded-md border border-white/5 bg-white/[0.03] px-2 py-1.5 text-left text-xs text-white/80 transition hover:bg-white/[0.06]"
                      >
                        <ChevronRight className="mr-1 inline h-3 w-3" />
                        {n}
                      </button>
                      <button
                        type="button"
                        onClick={() => deleteCustomPreset(n)}
                        className="rounded-md border border-white/5 bg-white/[0.03] px-2 py-1.5 text-[10px] text-white/40 hover:text-red-300"
                      >
                        Delete
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </Panel>

          <Panel title="Process" icon={<Zap className="h-3.5 w-3.5" />}>
            <button
              type="button"
              onClick={runProcessing}
              disabled={!origBuf || processing}
              className="group relative flex w-full items-center justify-center gap-2 overflow-hidden rounded-xl bg-gradient-to-br from-indigo-500 to-purple-500 px-4 py-3 text-sm font-bold uppercase tracking-wider text-white shadow-[0_8px_24px_rgba(99,102,241,0.45)] transition hover:-translate-y-0.5 hover:shadow-[0_16px_40px_rgba(99,102,241,0.55)] disabled:opacity-40 disabled:hover:translate-y-0"
            >
              <Zap className="h-4 w-4" /> Isolate & Enhance
            </button>
            <div className="mt-2 text-center text-[10px] text-white/40">
              12-stage DSP pipeline • 100% local
            </div>

            {progress.stage ? (
              <div className="mt-3">
                <div className="flex items-center justify-between text-[11px] text-white/50">
                  <span>{progress.stage}</span>
                  <span className="font-mono">{progress.pct}%</span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/5">
                  <div
                    className="h-full bg-gradient-to-r from-indigo-400 to-purple-500 transition-all duration-200"
                    style={{ width: `${progress.pct}%` }}
                  />
                </div>
              </div>
            ) : null}
          </Panel>

          {procBuf ? (
            <Panel title="Export" icon={<Download className="h-3.5 w-3.5" />}>
              <div className="mb-2 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setExportFormat('wav')}
                  className={[
                    'rounded-md px-3 py-2 text-xs font-semibold transition',
                    exportFormat === 'wav'
                      ? 'bg-gradient-to-br from-indigo-500 to-purple-500 text-white'
                      : 'bg-white/5 text-white/60 hover:bg-white/10',
                  ].join(' ')}
                >
                  WAV
                </button>
                <button
                  type="button"
                  onClick={() => setExportFormat('mp3')}
                  className={[
                    'rounded-md px-3 py-2 text-xs font-semibold transition',
                    exportFormat === 'mp3'
                      ? 'bg-gradient-to-br from-indigo-500 to-purple-500 text-white'
                      : 'bg-white/5 text-white/60 hover:bg-white/10',
                  ].join(' ')}
                >
                  MP3
                </button>
              </div>
              {exportFormat === 'mp3' ? (
                <div className="mb-2 flex items-center justify-between text-[11px] text-white/50">
                  <span>Bitrate</span>
                  <select
                    value={exportBitrate}
                    onChange={(e) => setExportBitrate(Number(e.target.value) as any)}
                    className="rounded-md border border-white/10 bg-black/40 px-2 py-1 text-[11px] text-white/80"
                  >
                    <option value={128}>128 kbps</option>
                    <option value={192}>192 kbps</option>
                    <option value={256}>256 kbps</option>
                    <option value={320}>320 kbps</option>
                  </select>
                </div>
              ) : (
                <div className="mb-2 flex items-center justify-between text-[11px] text-white/50">
                  <span>Bit depth</span>
                  <select
                    value={wavBitDepth}
                    onChange={(e) => setWavBitDepth(Number(e.target.value) as any)}
                    className="rounded-md border border-white/10 bg-black/40 px-2 py-1 text-[11px] text-white/80"
                  >
                    <option value={16}>16-bit PCM</option>
                    <option value={24}>24-bit PCM</option>
                  </select>
                </div>
              )}
              <button
                type="button"
                onClick={doExport}
                disabled={exportBusy}
                className="flex w-full items-center justify-center gap-2 rounded-md bg-emerald-500/90 px-3 py-2.5 text-sm font-semibold text-white shadow-[0_4px_16px_rgba(16,185,129,0.35)] transition hover:bg-emerald-500 disabled:opacity-50"
              >
                <Download className="h-4 w-4" /> {exportBusy ? 'Exporting…' : 'Download'}
              </button>
            </Panel>
          ) : null}
        </div>

        {/* CENTRE column: waveforms + player */}
        <div className="flex flex-col gap-4">
          <Panel
            title={
              <span className="flex items-center gap-2">
                <Waves className="h-3.5 w-3.5" /> Original
              </span>
            }
            accent="indigo"
            right={
              <span className="font-mono text-[11px] text-white/50">
                {formatTime(playSource === 'orig' ? playhead : 0)} / {formatTime(origDur)}
              </span>
            }
          >
            <div
              className="relative"
              onClick={(e) => {
                if (!origBuf) return;
                const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
                const x = e.clientX - rect.left;
                onScrub(x / rect.width, 'orig');
              }}
            >
              <Waveform
                buffer={origBuf}
                color="#6366f1"
                height={110}
                playhead={playSource === 'orig' ? playhead : undefined}
                duration={origDur}
              />
            </div>
            <div className="mt-3 flex items-center gap-2">
              <PlayBtn
                active={isPlaying && playSource === 'orig'}
                disabled={!origBuf}
                onClick={() => togglePlay('orig')}
                label="Play original"
                color="indigo"
              />
              <StopBtn
                disabled={!(isPlaying && playSource === 'orig')}
                onClick={() => {
                  stopPlayback();
                  startOffsetRef.current = 0;
                  setPlayhead(0);
                }}
              />
              <div className="ml-auto flex items-center gap-2 text-[11px] text-white/50">
                <Volume2 className="h-3.5 w-3.5" />
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={volume}
                  onChange={(e) => setVolume(parseFloat(e.target.value))}
                  className="accent-indigo-500"
                />
              </div>
            </div>
          </Panel>

          <Panel
            title={
              <span className="flex items-center gap-2">
                <Sparkles className="h-3.5 w-3.5" /> Processed
              </span>
            }
            accent="emerald"
            right={
              <span className="font-mono text-[11px] text-white/50">
                {formatTime(playSource === 'proc' ? playhead : 0)} / {formatTime(procDur)}
              </span>
            }
          >
            <div
              className="relative"
              onClick={(e) => {
                if (!procBuf) return;
                const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
                const x = e.clientX - rect.left;
                onScrub(x / rect.width, 'proc');
              }}
            >
              <Waveform
                buffer={procBuf}
                color="#10b981"
                height={110}
                playhead={playSource === 'proc' ? playhead : undefined}
                duration={procDur}
              />
            </div>
            <div className="mt-3 flex items-center gap-2">
              <PlayBtn
                active={isPlaying && playSource === 'proc'}
                disabled={!procBuf}
                onClick={() => togglePlay('proc')}
                label="Play processed"
                color="emerald"
              />
              <StopBtn
                disabled={!(isPlaying && playSource === 'proc')}
                onClick={() => {
                  stopPlayback();
                  startOffsetRef.current = 0;
                  setPlayhead(0);
                }}
              />
              <button
                type="button"
                onClick={() => {
                  if (playSource === 'proc') togglePlay('orig');
                  else togglePlay('proc');
                }}
                disabled={!origBuf || !procBuf}
                className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-white/5 px-3 py-1.5 text-[11px] font-semibold text-white/80 transition hover:bg-white/10 disabled:opacity-40"
              >
                <Repeat className="h-3 w-3" /> A/B toggle
              </button>
            </div>
          </Panel>

          <Panel title={<span className="flex items-center gap-2"><Gauge className="h-3.5 w-3.5" /> Monitoring</span>}>
            <div className="grid grid-cols-[1fr_auto] gap-3">
              <Spectrum
                analyser={analyserRef.current ?? null}
                active={isPlaying}
                height={110}
                color={playSource === 'proc' ? '#10b981' : '#6366f1'}
              />
              <div className="h-[110px] w-12">
                <VUMeter analyser={analyserRef.current ?? null} active={isPlaying} />
              </div>
            </div>
            <div className="mt-2 flex items-center justify-between text-[10px] text-white/40">
              <span>REAL-TIME SPECTRUM</span>
              <span>{isPlaying ? (livePreview && playSource === 'orig' ? 'LIVE PREVIEW (DSP ON)' : 'MONITORING') : 'IDLE'}</span>
            </div>
          </Panel>
        </div>

        {/* RIGHT column: controls */}
        <div className="flex flex-col gap-4">
          <ControlsPanel
            settings={settings}
            update={updateSetting}
            onCommit={commitHistory}
          />
        </div>
      </div>
    </div>
  );
}

function Panel({
  title,
  icon,
  children,
  right,
  accent,
}: {
  title: React.ReactNode;
  icon?: React.ReactNode;
  children: React.ReactNode;
  right?: React.ReactNode;
  accent?: 'indigo' | 'emerald';
}) {
  const accentBg =
    accent === 'emerald'
      ? 'bg-gradient-to-br from-emerald-500 to-teal-500'
      : 'bg-gradient-to-br from-indigo-500 to-purple-500';
  return (
    <section className="rounded-2xl border border-white/5 bg-white/[0.02] shadow-[0_8px_32px_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.05)] backdrop-blur-xl transition-all hover:border-white/10">
      <header className="flex items-center justify-between border-b border-white/5 px-4 py-3">
        <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-white/80">
          {icon ? (
            <span className={`flex h-6 w-6 items-center justify-center rounded-md ${accentBg} text-white`}>
              {icon}
            </span>
          ) : null}
          {title}
        </h2>
        {right}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

function PlayBtn({
  active,
  disabled,
  onClick,
  label,
  color,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  label: string;
  color: 'indigo' | 'emerald';
}) {
  const bg =
    color === 'emerald'
      ? 'from-emerald-500 to-teal-500 shadow-[0_4px_16px_rgba(16,185,129,0.35)]'
      : 'from-indigo-500 to-purple-500 shadow-[0_4px_16px_rgba(99,102,241,0.35)]';
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex h-9 items-center gap-2 rounded-md bg-gradient-to-br ${bg} px-3 text-xs font-semibold text-white transition hover:-translate-y-0.5 disabled:opacity-40 disabled:hover:translate-y-0`}
    >
      {active ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
      <span>{active ? 'Pause' : 'Play'}</span>
    </button>
  );
}

function StopBtn({ disabled, onClick }: { disabled?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label="Stop"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-white/10 bg-white/5 text-white/70 transition hover:bg-white/10 disabled:opacity-40"
    >
      <Square className="h-3.5 w-3.5" />
    </button>
  );
}

function shallowEqual(a: any, b: any) {
  if (a === b) return true;
  if (!a || !b) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (a[k] !== b[k]) return false;
  return true;
}
