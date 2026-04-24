'use client';

import { useState } from 'react';
import {
  SlidersHorizontal,
  Volume2,
  Gauge,
  Filter as FilterIcon,
  Zap,
  ChevronDown,
  Shield,
  Waves,
  Radio,
  Settings2,
  Sparkles,
} from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { SliderField } from './slider-field';
import { DSPSettings } from '@/lib/dsp/types';

interface Props {
  settings: DSPSettings;
  update: <K extends keyof DSPSettings>(key: K, value: DSPSettings[K]) => void;
  onCommit: () => void;
}

export function ControlsPanel({ settings, update, onCommit }: Props) {
  const [open, setOpen] = useState({
    core: true,
    eq: true,
    dynamics: false,
    filter: false,
  });

  return (
    <section className="rounded-2xl border border-white/5 bg-white/[0.02] shadow-[0_8px_32px_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.05)] backdrop-blur-xl">
      <header className="flex items-center justify-between border-b border-white/5 px-4 py-3">
        <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-white/80">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-gradient-to-br from-indigo-500 to-purple-500 text-white">
            <SlidersHorizontal className="h-3.5 w-3.5" />
          </span>
          Controls
        </h2>
      </header>
      <div className="divide-y divide-white/5">
        <Section
          title="Core Processing"
          icon={<Sparkles className="h-3.5 w-3.5" />}
          open={open.core}
          onToggle={() => setOpen((s) => ({ ...s, core: !s.core }))}
        >
          <div className="space-y-3">
            <SliderField
              label="Noise Reduction"
              value={settings.noiseReduction}
              min={0}
              max={100}
              onChange={(v) => update('noiseReduction', v)}
              unit="%"
              icon={<Shield className="h-3.5 w-3.5 text-indigo-300" />}
              hint="Spectral subtraction • profiles noise floor and subtracts with over-subtraction alpha"
            />
            <SliderField
              label="Voice Presence"
              value={settings.voicePresence}
              min={0}
              max={100}
              onChange={(v) => update('voicePresence', v)}
              unit="%"
              icon={<Radio className="h-3.5 w-3.5 text-indigo-300" />}
              hint="Boost 220Hz warmth + 2kHz presence"
            />
            <SliderField
              label="Clarity"
              value={settings.clarity}
              min={0}
              max={100}
              onChange={(v) => update('clarity', v)}
              unit="%"
              icon={<Sparkles className="h-3.5 w-3.5 text-indigo-300" />}
              hint="5.8 kHz intelligibility + 11 kHz air"
            />
            <SliderField
              label="Spectral Gate"
              value={settings.spectralGate}
              min={0}
              max={100}
              onChange={(v) => update('spectralGate', v)}
              unit="%"
              icon={<Shield className="h-3.5 w-3.5 text-indigo-300" />}
              hint="Residual-noise gate around voice activity"
            />
            <SliderField
              label="De-reverb"
              value={settings.deReverb}
              min={0}
              max={100}
              onChange={(v) => update('deReverb', v)}
              unit="%"
              icon={<Waves className="h-3.5 w-3.5 text-indigo-300" />}
              hint="Reduces room tail & mud"
            />
            <SliderField
              label="De-esser"
              value={settings.deEsser}
              min={0}
              max={100}
              onChange={(v) => update('deEsser', v)}
              unit="%"
              icon={<Zap className="h-3.5 w-3.5 text-indigo-300" />}
              disabled={!settings.deEsserEnabled}
              hint="Notch around 7.2 kHz sibilance"
            />
            <SliderField
              label="Compression"
              value={settings.compression}
              min={0}
              max={100}
              onChange={(v) => update('compression', v)}
              unit="%"
              icon={<Gauge className="h-3.5 w-3.5 text-indigo-300" />}
              hint="Dynamic range control"
            />

            <div className="space-y-2 rounded-md bg-black/30 p-3">
              <ToggleRow
                label="Electrical hum removal"
                value={settings.humRemoval}
                onChange={(v) => update('humRemoval', v)}
                right={
                  <select
                    value={settings.humFreq}
                    onChange={(e) => update('humFreq', Number(e.target.value) as 50 | 60)}
                    disabled={!settings.humRemoval}
                    className="rounded-md border border-white/10 bg-black/40 px-2 py-0.5 text-[11px] text-white/80 disabled:opacity-40"
                  >
                    <option value={50}>50 Hz</option>
                    <option value={60}>60 Hz</option>
                  </select>
                }
              />
              <ToggleRow
                label="High-pass"
                value={settings.highPass}
                onChange={(v) => update('highPass', v)}
              />
              <ToggleRow
                label="Peak normalise"
                value={settings.normalize}
                onChange={(v) => update('normalize', v)}
              />
              <ToggleRow
                label="De-esser enabled"
                value={settings.deEsserEnabled}
                onChange={(v) => update('deEsserEnabled', v)}
              />
            </div>
          </div>
        </Section>

        <Section
          title="Parametric EQ"
          icon={<SlidersHorizontal className="h-3.5 w-3.5" />}
          open={open.eq}
          onToggle={() => setOpen((s) => ({ ...s, eq: !s.eq }))}
        >
          <div className="grid grid-cols-5 gap-1.5">
            {[
              { k: 'eqLow' as const, label: '120', full: '120 Hz Low' },
              { k: 'eqLowMid' as const, label: '400', full: '400 Hz Low-mid' },
              { k: 'eqMid' as const, label: '1.8k', full: '1.8 kHz Mid' },
              { k: 'eqHighMid' as const, label: '5k', full: '5 kHz Hi-mid' },
              { k: 'eqHigh' as const, label: '12k', full: '12 kHz High' },
            ].map((b) => (
              <VerticalSlider
                key={b.k}
                label={b.label}
                full={b.full}
                value={settings[b.k]}
                onChange={(v) => update(b.k, v)}
                onCommit={onCommit}
              />
            ))}
          </div>
        </Section>

        <Section
          title="Dynamics"
          icon={<Gauge className="h-3.5 w-3.5" />}
          open={open.dynamics}
          onToggle={() => setOpen((s) => ({ ...s, dynamics: !s.dynamics }))}
        >
          <div className="space-y-4">
            <div>
              <div className="mb-2 text-[10px] uppercase tracking-widest text-white/40">Compressor</div>
              <div className="space-y-3">
                <SliderField label="Threshold" unit=" dB" value={settings.compThreshold} min={-60} max={0} onChange={(v) => update('compThreshold', v)} />
                <SliderField label="Ratio" value={settings.compRatio} min={1} max={20} step={0.5} onChange={(v) => update('compRatio', v)} />
                <SliderField label="Attack" unit=" ms" value={Math.round(settings.compAttack * 1000)} min={0} max={200} onChange={(v) => update('compAttack', v / 1000)} />
                <SliderField label="Release" unit=" ms" value={Math.round(settings.compRelease * 1000)} min={20} max={1000} onChange={(v) => update('compRelease', v / 1000)} />
              </div>
            </div>
            <div className="h-px bg-white/5" />
            <div>
              <div className="mb-2 text-[10px] uppercase tracking-widest text-white/40">Noise Gate</div>
              <div className="space-y-3">
                <SliderField label="Threshold" unit=" dB" value={settings.gateThreshold} min={-80} max={0} onChange={(v) => update('gateThreshold', v)} />
                <SliderField label="Ratio" value={settings.gateRatio} min={1} max={20} step={0.5} onChange={(v) => update('gateRatio', v)} />
                <SliderField label="Attack" unit=" ms" value={Math.round(settings.gateAttack * 1000)} min={0} max={100} onChange={(v) => update('gateAttack', v / 1000)} />
                <SliderField label="Release" unit=" ms" value={Math.round(settings.gateRelease * 1000)} min={10} max={500} onChange={(v) => update('gateRelease', v / 1000)} />
              </div>
            </div>
          </div>
        </Section>

        <Section
          title="Filters & Output"
          icon={<FilterIcon className="h-3.5 w-3.5" />}
          open={open.filter}
          onToggle={() => setOpen((s) => ({ ...s, filter: !s.filter }))}
        >
          <div className="space-y-3">
            <SliderField
              label="High-pass cutoff"
              unit=" Hz"
              value={settings.highPassFreq}
              min={20}
              max={500}
              onChange={(v) => update('highPassFreq', v)}
              disabled={!settings.highPass}
            />
            <ToggleRow
              label="Low-pass enabled"
              value={settings.lowPassEnabled}
              onChange={(v) => update('lowPassEnabled', v)}
            />
            <SliderField
              label="Low-pass cutoff"
              unit=" Hz"
              value={settings.lowPassFreq}
              min={2000}
              max={20000}
              step={100}
              onChange={(v) => update('lowPassFreq', v)}
              disabled={!settings.lowPassEnabled}
            />
            <SliderField
              label="Output gain"
              unit=" dB"
              value={settings.outputGain}
              min={-12}
              max={12}
              step={0.5}
              onChange={(v) => update('outputGain', v)}
              icon={<Volume2 className="h-3.5 w-3.5 text-indigo-300" />}
            />
          </div>
        </Section>
      </div>
    </section>
  );
}

function ToggleRow({
  label,
  value,
  onChange,
  right,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs text-white/70">{label}</span>
      <div className="flex items-center gap-2">
        {right}
        <Switch checked={value} onCheckedChange={onChange} />
      </div>
    </div>
  );
}

function Section({
  title,
  icon,
  children,
  open,
  onToggle,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between px-4 py-3 text-left transition hover:bg-white/[0.02]"
      >
        <span className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-widest text-white/80">
          <span className="text-indigo-300">{icon}</span>
          {title}
        </span>
        <ChevronDown className={`h-4 w-4 text-white/40 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open ? <div className="px-4 pb-4">{children}</div> : null}
    </div>
  );
}

function VerticalSlider({
  label,
  full,
  value,
  onChange,
  onCommit,
}: {
  label: string;
  full: string;
  value: number;
  onChange: (v: number) => void;
  onCommit: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-2" title={full}>
      <div className="text-[10px] font-mono text-indigo-300">
        {value >= 0 ? '+' : ''}
        {value.toFixed(1)}
      </div>
      <div className="relative h-28 w-7 rounded-full bg-white/5 overflow-hidden">
        <input
          type="range"
          min={-12}
          max={12}
          step={0.5}
          value={value}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          onMouseUp={onCommit}
          onTouchEnd={onCommit}
          aria-label={full}
          className="absolute left-1/2 top-1/2 w-28 -translate-x-1/2 -translate-y-1/2 -rotate-90 accent-indigo-500"
        />
        <div className="pointer-events-none absolute left-1/2 top-1/2 h-full w-[2px] -translate-x-1/2 bg-white/10" />
        <div
          className="pointer-events-none absolute left-1/2 h-[3px] w-4 -translate-x-1/2 rounded-sm bg-indigo-400"
          style={{ top: `calc(${((12 - value) / 24) * 100}% - 1px)` }}
        />
      </div>
      <div className="text-[10px] text-white/50">{label}</div>
    </div>
  );
}
