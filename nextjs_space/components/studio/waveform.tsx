'use client';

import { useEffect, useRef } from 'react';

interface WaveformProps {
  buffer: AudioBuffer | null;
  color: string;
  height?: number;
  playhead?: number; // seconds
  duration?: number;
}

export function Waveform({ buffer, color, height = 120, playhead, duration }: WaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Re-draw when buffer changes or canvas resizes
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    drawWaveform(canvas, buffer, color);

    const parent = canvas.parentElement;
    if (!parent) return;
    const ro = new ResizeObserver(() => drawWaveform(canvas, buffer, color));
    ro.observe(parent);
    return () => ro.disconnect();
  }, [buffer, color]);

  const pct =
    playhead !== undefined && duration && duration > 0
      ? Math.max(0, Math.min(1, playhead / duration))
      : 0;

  return (
    <div className="relative w-full overflow-hidden rounded-lg bg-black/40 ring-1 ring-white/5" style={{ height }}>
      <canvas ref={canvasRef} className="h-full w-full block" />
      {buffer && playhead !== undefined && duration ? (
        <div
          className="pointer-events-none absolute top-0 bottom-0 w-[2px] bg-white/80 shadow-[0_0_8px_rgba(255,255,255,0.8)]"
          style={{ left: `${pct * 100}%` }}
        />
      ) : null}
      {!buffer ? (
        <div className="absolute inset-0 flex items-center justify-center text-xs text-white/30">
          No audio loaded
        </div>
      ) : null}
    </div>
  );
}

function drawWaveform(canvas: HTMLCanvasElement, buffer: AudioBuffer | null, color: string) {
  const parent = canvas.parentElement;
  const dpr = window.devicePixelRatio || 1;
  const w = (parent?.clientWidth ?? canvas.clientWidth) * dpr;
  const h = (parent?.clientHeight ?? canvas.clientHeight) * dpr;
  canvas.width = Math.max(2, Math.floor(w));
  canvas.height = Math.max(2, Math.floor(h));
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Background gradient
  const bgGrad = ctx.createLinearGradient(0, 0, 0, canvas.height);
  bgGrad.addColorStop(0, 'rgba(255,255,255,0.02)');
  bgGrad.addColorStop(1, 'rgba(255,255,255,0.00)');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Centre line
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, canvas.height / 2);
  ctx.lineTo(canvas.width, canvas.height / 2);
  ctx.stroke();

  if (!buffer) return;

  // Down-mix first channel for visualisation
  const ch = buffer.getChannelData(0);
  const samplesPerPx = Math.max(1, Math.floor(ch.length / canvas.width));

  // Filled bar style
  const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
  grad.addColorStop(0, color);
  grad.addColorStop(0.5, color);
  grad.addColorStop(1, color + '55');
  ctx.fillStyle = grad;

  for (let x = 0; x < canvas.width; x++) {
    const start = x * samplesPerPx;
    let min = 1;
    let max = -1;
    for (let i = 0; i < samplesPerPx; i++) {
      const v = ch[start + i] ?? 0;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const y1 = (1 - (max * 0.95 + 1) / 2) * canvas.height;
    const y2 = (1 - (min * 0.95 + 1) / 2) * canvas.height;
    ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1));
  }
}
