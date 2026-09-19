/**
 * VoiceIsolate-Pro — Unified Design Tokens (JS)
 * Single source of truth for Browser, Android, Desktop
 * Mirrors design-tokens.css for JS-driven canvas rendering
 */

export const Tokens = Object.freeze({
  surface: {
    root: '#070b10',
    panel: '#0d131b',
    raised: '#121a23',
    overlay: '#161f29',
    well: 'rgba(0,0,0,0.32)',
    scrim: 'rgba(7,11,16,0.82)',
  },
  border: {
    subtle: '#1d2a34',
    strong: '#26323d',
    focus: 'rgba(46,213,229,0.55)',
  },
  text: {
    primary: '#f4f7fa',
    secondary: '#8d9aaa',
    dim: '#7b8894',
    ghost: 'rgba(244,247,250,0.48)',
    inverse: '#070b10',
  },
  signal: {
    primary: '#2ed5e5',
    primaryStrong: '#1ab8c7',
    secondary: '#3b82f6',
    accent: '#60a5fa',
  },
  selection: {
    default: '#9b6cff',
    strong: '#7c3aed',
    // Filled-surface variant: white on `default` is 3.51:1 (< AA). Follows the
    // critical.default/critical.solid pattern — white text on the filled
    // violet uses `solid`; accents/borders keep `default`.
    solid: '#7c3aed',
    wash: 'rgba(155,108,255,0.14)',
    glow: 'rgba(155,108,255,0.32)',
  },
  success: {
    default: '#31cf7d',
    wash: 'rgba(49,207,125,0.12)',
    glow: 'rgba(49,207,125,0.32)',
  },
  warning: {
    default: '#f0b541',
    wash: 'rgba(240,181,65,0.12)',
  },
  critical: {
    default: '#ff3d4d',
    solid: '#d81f30',
    wash: 'rgba(255,61,77,0.08)',
  },
  canvas: {
    bg: '#05080c',
    waveformFill: 'rgba(46,213,229,0.85)',
    waveformStroke: '#2ed5e5',
    raw: '#ef4444',
    processed: '#2ed5e5',
    removed: '#f0b541',
    spectrogramLow: '#0a0e14',
    spectrogramMid: '#1a2a3a',
    spectrogramHigh: '#2ed5e5',
    spectrogramPeak: '#fbbf24',
  },
  overlay: {
    speech: 'rgba(46,213,229,0.22)',
    speechBorder: 'rgba(46,213,229,0.55)',
    whisper: 'rgba(155,108,255,0.22)',
    whisperBorder: 'rgba(155,108,255,0.55)',
    noise: 'rgba(141,154,170,0.18)',
    noiseBorder: 'rgba(141,154,170,0.35)',
    hum: 'rgba(240,181,65,0.18)',
    humBorder: 'rgba(240,181,65,0.45)',
    music: 'rgba(168,85,247,0.18)',
    musicBorder: 'rgba(168,85,247,0.45)',
    secondary: 'rgba(59,130,246,0.18)',
  },
  font: {
    ui: 'ui-sans-serif, system-ui, "Segoe UI", sans-serif',
    mono: 'ui-monospace, "Cascadia Code", "Segoe UI Mono", Consolas, monospace',
  },
  spacing: {
    1: '4px',
    2: '8px',
    3: '12px',
    4: '16px',
    5: '20px',
    6: '24px',
    7: '28px',
    8: '32px',
  },
  radius: {
    xs: '3px',
    sm: '4px',
    md: '6px',
    lg: '10px',
    xl: '14px',
    '2xl': '20px',
    full: '9999px',
  },
  motion: {
    easeOut: 'cubic-bezier(0.22, 0.7, 0.2, 1)',
    durFast: '0.12s',
    durBase: '0.20s',
    durSlow: '0.32s',
  },
  layout: {
    titlebarH: '56px',
    navH: '64px',
    bottomNavH: '64px',
    inspectorW: '320px',
    inspectorWlg: '380px',
    touchMin: '44px',
    touchMinLg: '48px',
  },
});

export const SemanticColors = Object.freeze({
  signal: Tokens.signal.primary,
  selection: Tokens.selection.default,
  validated: Tokens.success.default,
  uncertain: Tokens.warning.default,
  destructive: Tokens.critical.default,
});

export const Profiles = Object.freeze({
  QUICK: 'quick',
  MEETING: 'meeting',
  STUDIO: 'studio',
  FORENSIC: 'forensic',
});

export const ProfileLabels = Object.freeze({
  [Profiles.QUICK]: 'Quick',
  [Profiles.MEETING]: 'Meeting',
  [Profiles.STUDIO]: 'Studio',
  [Profiles.FORENSIC]: 'Forensic',
});

export const ComparisonModes = Object.freeze({
  RAW: 'raw',
  PROCESSED: 'processed',
  REMOVED: 'removed',
});

export const AnalysisTypes = Object.freeze({
  SPEECH: 'speech',
  WHISPER: 'whisper',
  NOISE: 'background_noise',
  HUM: 'hum',
  MUSIC: 'music',
  SECONDARY_SPEAKER: 'secondary_speaker',
});

export default Tokens;
