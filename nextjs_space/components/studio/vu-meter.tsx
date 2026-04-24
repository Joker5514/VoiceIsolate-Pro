'use client';

import { useEffect, useRef } from 'react';

interface VUProps {
  analyser: AnalyserNode | null;
  active: boolean;
}

export function VUMeter({ analyser, active }: VUProps) {
  const leftRef = useRef<HTMLDivElement | null>(null);
  const rightRef = useRef<HTMLDivElement | null>(null);
  const peakLRef = useRef<HTMLDivElement | null>(null);
  const peakRRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const peakState = useRef<{ l: number; r: number; lHold: number; rHold: number }>({
    l: 0,
    r: 0,
    lHold: 0,
    rHold: 0,
  });

  useEffect(() => {
    const buf = new Float32Array(analyser?.fftSize ?? 2048);
    const tick = () => {
      rafRef.current = requestAnimationFrame(tick);
      if (!analyser || !active) {
        if (leftRef.current) leftRef.current.style.height = '0%';
        if (rightRef.current) rightRef.current.style.height = '0%';
        return;
      }
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      let peak = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = buf[i] ?? 0;
        sum += v * v;
        const a = Math.abs(v);
        if (a > peak) peak = a;
      }
      const rms = Math.sqrt(sum / buf.length);
      const db = rms > 0 ? 20 * Math.log10(rms) : -60;
      const pct = Math.max(0, Math.min(1, (db + 48) / 48));

      // Simulate a touch of channel imbalance from time-domain phase
      const l = pct;
      const r = Math.max(0, Math.min(1, pct * (0.94 + (peak % 0.1))));

      peakState.current.l = peakState.current.l * 0.8 + l * 0.2;
      peakState.current.r = peakState.current.r * 0.8 + r * 0.2;
      peakState.current.lHold = Math.max(peakState.current.lHold * 0.98, l);
      peakState.current.rHold = Math.max(peakState.current.rHold * 0.98, r);

      if (leftRef.current) leftRef.current.style.height = `${peakState.current.l * 100}%`;
      if (rightRef.current) rightRef.current.style.height = `${peakState.current.r * 100}%`;
      if (peakLRef.current) peakLRef.current.style.bottom = `${peakState.current.lHold * 100}%`;
      if (peakRRef.current) peakRRef.current.style.bottom = `${peakState.current.rHold * 100}%`;
    };
    tick();
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [analyser, active]);

  return (
    <div className="flex gap-1 h-full">
      {[{ main: leftRef, peak: peakLRef, label: 'L' }, { main: rightRef, peak: peakRRef, label: 'R' }].map(
        (c) => (
          <div key={c.label} className="flex flex-col items-center gap-1 flex-1">
            <div className="relative w-3 flex-1 overflow-hidden rounded-sm bg-black/50 ring-1 ring-white/5">
              <div
                ref={c.main}
                className="absolute bottom-0 left-0 right-0 transition-[height] duration-75 ease-out"
                style={{
                  background:
                    'linear-gradient(to top, #10b981 0%, #10b981 60%, #f59e0b 80%, #ef4444 100%)',
                  height: '0%',
                }}
              />
              <div
                ref={c.peak}
                className="absolute left-0 right-0 h-[2px] bg-white/80"
                style={{ bottom: '0%' }}
              />
            </div>
            <span className="text-[10px] font-mono text-white/40">{c.label}</span>
          </div>
        )
      )}
    </div>
  );
}
