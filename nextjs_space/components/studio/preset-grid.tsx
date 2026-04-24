'use client';

import * as LucideIcons from 'lucide-react';
import { PRESETS, PresetName } from '@/lib/dsp/types';

interface Props {
  active: PresetName | null;
  onSelect: (name: PresetName) => void;
}

export function PresetGrid({ active, onSelect }: Props) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {PRESETS.map((p) => {
        const Icon: any = (LucideIcons as any)[p.icon] ?? LucideIcons.Sliders;
        const isActive = active === p.id;
        return (
          <button
            key={p.id}
            type="button"
            onClick={() => onSelect(p.id)}
            className={[
              'group relative overflow-hidden rounded-lg p-2.5 text-left transition-all duration-200',
              'border ring-0 ring-indigo-400/0',
              isActive
                ? 'border-indigo-400/70 bg-gradient-to-br from-indigo-500/25 to-purple-500/15 shadow-[0_0_0_1px_rgba(99,102,241,0.4),0_8px_24px_rgba(99,102,241,0.25)]'
                : 'border-white/5 bg-white/[0.02] hover:border-indigo-400/40 hover:bg-white/[0.04]',
            ].join(' ')}
          >
            <div className="flex items-start gap-2">
              <div
                className={[
                  'flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors',
                  isActive
                    ? 'bg-gradient-to-br from-indigo-500 to-purple-500 text-white'
                    : 'bg-white/5 text-white/60 group-hover:text-white',
                ].join(' ')}
              >
                <Icon className="h-3.5 w-3.5" />
              </div>
              <div className="min-w-0">
                <div className="text-xs font-semibold text-white/90">{p.label}</div>
                <div className="mt-0.5 text-[10px] leading-snug text-white/45 line-clamp-2">{p.description}</div>
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
