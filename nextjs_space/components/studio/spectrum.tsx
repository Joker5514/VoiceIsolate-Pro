'use client';

import { useEffect, useRef } from 'react';

interface SpectrumProps {
  analyser: AnalyserNode | null;
  active: boolean;
  height?: number;
  color?: string;
}

export function Spectrum({ analyser, active, height = 90, color = '#6366f1' }: SpectrumProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const resize = () => {
      const parent = canvas.parentElement;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(2, Math.floor((parent?.clientWidth ?? canvas.clientWidth) * dpr));
      canvas.height = Math.max(2, Math.floor((parent?.clientHeight ?? canvas.clientHeight) * dpr));
    };
    resize();
    const ro = new ResizeObserver(resize);
    if (canvas.parentElement) ro.observe(canvas.parentElement);

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let freq: Uint8Array | null = null;

    const draw = () => {
      rafRef.current = requestAnimationFrame(draw);
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      if (!analyser || !active) {
        // Idle state: subtle baseline
        ctx.fillStyle = 'rgba(255,255,255,0.05)';
        ctx.fillRect(0, canvas.height - 2, canvas.width, 2);
        return;
      }
      if (!freq || freq.length !== analyser.frequencyBinCount) {
        freq = new Uint8Array(analyser.frequencyBinCount);
      }
      analyser.getByteFrequencyData(freq);

      const bars = 64;
      const step = Math.floor(freq.length / bars);
      const gap = Math.max(1, Math.floor(canvas.width * 0.004));
      const barW = Math.max(1, Math.floor(canvas.width / bars) - gap);

      for (let i = 0; i < bars; i++) {
        let sum = 0;
        for (let j = 0; j < step; j++) sum += freq[i * step + j] ?? 0;
        const v = sum / step / 255;
        const h = Math.max(2, v * canvas.height);
        const x = i * (barW + gap);
        const y = canvas.height - h;
        const grad = ctx.createLinearGradient(0, y, 0, canvas.height);
        grad.addColorStop(0, color);
        grad.addColorStop(1, color + '44');
        ctx.fillStyle = grad;
        ctx.fillRect(x, y, barW, h);
      }
    };
    draw();

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      ro.disconnect();
    };
  }, [analyser, active, color]);

  return (
    <div className="relative w-full overflow-hidden rounded-md bg-black/50 ring-1 ring-white/5" style={{ height }}>
      <canvas ref={canvasRef} className="h-full w-full block" />
      {!active ? (
        <div className="absolute inset-0 flex items-center justify-center text-[10px] uppercase tracking-widest text-white/30">
          Spectrum idle
        </div>
      ) : null}
    </div>
  );
}
