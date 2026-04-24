'use client';

import { Slider } from '@/components/ui/slider';

interface SliderFieldProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  hint?: string;
  disabled?: boolean;
  onChange: (v: number) => void;
  icon?: React.ReactNode;
}

export function SliderField({
  label,
  value,
  min,
  max,
  step = 1,
  unit,
  hint,
  disabled,
  onChange,
  icon,
}: SliderFieldProps) {
  return (
    <div className={disabled ? 'opacity-50 pointer-events-none' : ''}>
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-2 text-xs font-medium text-white/70">
          {icon}
          <span>{label}</span>
        </div>
        <div className="text-xs font-mono tabular-nums text-indigo-300">
          {formatVal(value, step)}
          {unit ? <span className="ml-0.5 text-white/40">{unit}</span> : null}
        </div>
      </div>
      <Slider
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={(v: number[]) => {
          const n = v?.[0];
          if (typeof n === 'number' && !Number.isNaN(n)) onChange(n);
        }}
        className="w-full"
      />
      {hint ? <div className="mt-1 text-[10px] text-white/30">{hint}</div> : null}
    </div>
  );
}

function formatVal(v: number, step: number) {
  if (step >= 1) return Math.round(v).toString();
  if (step >= 0.01) return v.toFixed(2);
  return v.toFixed(3);
}
