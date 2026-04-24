import dynamic from 'next/dynamic';
import { AudioLines, Activity, Cpu, Infinity as InfinityIcon } from 'lucide-react';

const Studio = dynamic(() => import('@/components/studio/studio'), {
  ssr: false,
  loading: () => (
    <div className="mx-auto mt-10 w-full max-w-[1280px] animate-pulse px-6">
      <div className="h-10 w-56 rounded bg-white/5" />
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-[300px_1fr_280px]">
        <div className="h-[600px] rounded-2xl bg-white/[0.03]" />
        <div className="h-[600px] rounded-2xl bg-white/[0.03]" />
        <div className="h-[600px] rounded-2xl bg-white/[0.03]" />
      </div>
    </div>
  ),
});

export default function Page() {
  return (
    <main className="relative min-h-screen overflow-x-hidden">
      {/* Decorative orbs */}
      <div className="studio-orb" style={{ width: 420, height: 420, background: '#6366f1', top: -120, left: -120 }} />
      <div className="studio-orb" style={{ width: 320, height: 320, background: '#a855f7', bottom: -80, right: -60, animationDelay: '-8s' }} />
      <div className="studio-orb" style={{ width: 220, height: 220, background: '#06b6d4', top: '40%', left: '55%', animationDelay: '-14s' }} />

      {/* Header */}
      <header className="relative z-10 border-b border-white/5 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1280px] items-center justify-between px-4 py-4 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="brand-pulse flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 via-fuchsia-500 to-purple-500 shadow-[0_8px_24px_rgba(99,102,241,0.5)]">
              <AudioLines className="h-5 w-5 text-white" />
            </div>
            <div>
              <h1 className="bg-gradient-to-r from-white to-cyan-300 bg-clip-text text-lg font-extrabold tracking-tight text-transparent sm:text-xl">
                VoiceIsolate Pro
              </h1>
              <div className="text-[10px] font-medium uppercase tracking-[0.25em] text-white/40">
                Studio • v1.0
              </div>
            </div>
          </div>
          <div className="hidden items-center gap-2 md:flex">
            <Badge icon={<Activity className="h-3 w-3 text-emerald-400" />} label="Engine online" value="READY" />
            <Badge icon={<Cpu className="h-3 w-3 text-cyan-400" />} label="Web Audio API" value="12-STAGE" />
            <Badge icon={<InfinityIcon className="h-3 w-3 text-indigo-400" />} label="100% local" value="NO UPLOAD" />
          </div>
        </div>
      </header>

      {/* Hero tagline */}
      <section className="relative z-10 mx-auto max-w-[1280px] px-4 pt-6 sm:px-6">
        <p className="max-w-2xl text-sm leading-relaxed text-white/60 sm:text-base">
          Upload any recording and strip away every hiss, hum, room reflection and background voice —
          leaving your <span className="font-semibold text-white">voice</span> in pristine clarity.
          Twelve professional DSP stages run right in the browser. Nothing ever leaves your device.
        </p>
      </section>

      <Studio />

      {/* Footer */}
      <footer className="relative z-10 mt-8 border-t border-white/5 py-6">
        <div className="mx-auto flex max-w-[1280px] flex-col items-center justify-between gap-2 px-4 text-xs text-white/40 sm:flex-row sm:px-6">
          <div>
            Copyright © 2026 Randy Jordan — All Rights Reserved.
          </div>
          <div className="font-mono text-[11px] text-white/30">
            Built with Web Audio API • Next.js 14 • TypeScript
          </div>
        </div>
      </footer>
    </main>
  );
}

function Badge({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 rounded-full border border-white/5 bg-white/[0.03] px-3 py-1.5 text-[10px] text-white/50">
      {icon}
      <span>{label}</span>
      <span className="font-mono font-semibold text-cyan-300">{value}</span>
    </div>
  );
}
