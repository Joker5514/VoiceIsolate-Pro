'use client';

import { useCallback, useState, useRef } from 'react';
import { UploadCloud, FileAudio2, X, CheckCircle2 } from 'lucide-react';
import { ACCEPTED_TYPES, isAcceptedFile, formatBytes } from '@/lib/dsp/media';

interface Props {
  file: File | null;
  onFile: (file: File | null) => void;
  busy?: boolean;
}

export function UploadZone({ file, onFile, busy }: Props) {
  const [hover, setHover] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const accept = useCallback(
    (f: File | null) => {
      setError(null);
      if (!f) {
        onFile(null);
        return;
      }
      if (!isAcceptedFile(f)) {
        setError('Unsupported file type. Try MP3, WAV, OGG, M4A, MP4, MOV or WEBM.');
        return;
      }
      if (f.size > 500 * 1024 * 1024) {
        setError('File is too large (max 500 MB in the browser).');
        return;
      }
      onFile(f);
    },
    [onFile]
  );

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setHover(false);
    if (busy) return;
    const f = e.dataTransfer?.files?.[0];
    if (f) accept(f);
  };

  return (
    <div>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (!busy) setHover(true);
        }}
        onDragLeave={() => setHover(false)}
        onDrop={onDrop}
        onClick={() => !busy && inputRef.current?.click()}
        className={[
          'group relative cursor-pointer rounded-xl border-2 border-dashed p-6 text-center transition-all duration-300',
          hover
            ? 'border-indigo-400 bg-indigo-500/10 scale-[1.01]'
            : 'border-white/10 bg-indigo-500/5 hover:border-indigo-400 hover:bg-indigo-500/10',
          busy ? 'pointer-events-none opacity-60' : '',
        ].join(' ')}
      >
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPTED_TYPES}
          className="hidden"
          onChange={(e) => accept(e.target.files?.[0] ?? null)}
        />
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-purple-500 shadow-[0_8px_32px_rgba(99,102,241,0.5)]">
          <UploadCloud className="h-7 w-7 text-white" />
        </div>
        <div className="mt-4 font-semibold text-white">Drop your audio or video here</div>
        <div className="mt-1 text-xs text-white/50">MP3, WAV, OGG, M4A, FLAC, MP4, MOV, WEBM, MKV • up to 500 MB</div>
      </div>

      {error ? (
        <div className="mt-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {error}
        </div>
      ) : null}

      {file ? (
        <div className="mt-3 flex items-center gap-3 rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-emerald-500/20 text-emerald-300">
            <FileAudio2 className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-emerald-200">{file.name}</div>
            <div className="text-[11px] font-mono text-white/50">{formatBytes(file.size)}</div>
          </div>
          <CheckCircle2 className="h-4 w-4 text-emerald-400" />
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onFile(null);
            }}
            className="rounded-md p-1 text-white/40 hover:bg-white/5 hover:text-white/70"
            aria-label="Remove file"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : null}
    </div>
  );
}
