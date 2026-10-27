/**
 * VoiceIsolate Pro — Signal Glass illustrations (Layer 4: Presentation)
 *
 * Inline SVG drawings of the voice / background split: a silver original
 * recording passes a glass lens and leaves as a cyan Clean Voice ribbon and a
 * gold Background ribbon. Same-origin markup only (no images, fonts or
 * external references), deterministic geometry from core/IllustrationGeometry.
 *
 * Every drawing is decorative (`aria-hidden`) unless it is the only carrier
 * of meaning, in which case it gets role="img" and a label. Motion lives in
 * /src/ui/motion/motion.css behind the root motion flags; the markup itself
 * is a complete still, which is exactly what reduced motion shows.
 */
'use strict';

import {
  barWavePath, envelopePath, ribbonPath, strandPath, tickPath,
} from '../core/IllustrationGeometry.js';

export const ILLUSTRATION_COLORS = Object.freeze({
  voice: '#22d3ee',
  bgst: '#f5b942',
  ref: '#c3cbd5',
  canvas: '#0a0e14',
});

const C = ILLUSTRATION_COLORS;
let uidCounter = 0;
const uid = (name) => `vi-${name}-${(++uidCounter).toString(36)}`;

function svgOpen(viewBox, cls, label) {
  const a11y = label
    ? `role="img" aria-label="${label.replace(/"/g, '&quot;')}"`
    : 'aria-hidden="true"';
  return `<svg class="vi-svg ${cls}" viewBox="${viewBox}" ${a11y} focusable="false" preserveAspectRatio="xMidYMid meet">`;
}

/** Shared gradients, hatch and sweep. `p` is the per-instance id prefix. */
function defs(p, w, h) {
  return `<defs>
<linearGradient id="${p}-edge" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${C.voice}" stop-opacity=".9"/><stop offset=".55" stop-color="#e8eef5" stop-opacity=".35"/><stop offset="1" stop-color="${C.bgst}" stop-opacity=".8"/></linearGradient>
<radialGradient id="${p}-glass" cx=".38" cy=".3" r=".9"><stop offset="0" stop-color="#e8eef5" stop-opacity=".2"/><stop offset=".55" stop-color="#9fb4c6" stop-opacity=".06"/><stop offset="1" stop-color="${C.canvas}" stop-opacity=".0"/></radialGradient>
<linearGradient id="${p}-voice" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${C.voice}" stop-opacity=".15"/><stop offset=".3" stop-color="${C.voice}" stop-opacity=".95"/><stop offset="1" stop-color="#7ee8fa"/></linearGradient>
<linearGradient id="${p}-bg" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${C.bgst}" stop-opacity=".15"/><stop offset=".3" stop-color="${C.bgst}" stop-opacity=".9"/><stop offset="1" stop-color="#ffd27a" stop-opacity=".85"/></linearGradient>
<linearGradient id="${p}-ref" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${C.ref}" stop-opacity=".25"/><stop offset=".7" stop-color="${C.ref}" stop-opacity=".85"/><stop offset="1" stop-color="#e8eef5"/></linearGradient>
<linearGradient id="${p}-fadeV" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e8eef5" stop-opacity=".08"/><stop offset="1" stop-color="#e8eef5" stop-opacity="0"/></linearGradient>
<pattern id="${p}-hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><path d="M0 0V5" stroke="${C.bgst}" stroke-width="1.2" stroke-opacity=".55"/></pattern>
<linearGradient id="${p}-sweepg" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
<mask id="${p}-sweep" maskUnits="userSpaceOnUse" x="0" y="0" width="${w}" height="${h}"><rect class="vi-sweep" x="-140" y="0" width="140" height="${h}" fill="url(#${p}-sweepg)" style="--vi-run:${w + 140}px"/></mask>
</defs>`;
}

/** Fine background grid: hairlines every `step` units. */
function grid(w, h, step, opacity = 0.05) {
  let d = '';
  for (let x = step; x < w; x += step) d += `M${x} 0V${h}`;
  for (let y = step; y < h; y += step) d += `M0 ${y}H${w}`;
  return `<path d="${d}" stroke="#e8eef5" stroke-opacity="${opacity}" stroke-width=".5" fill="none"/>`;
}

/** Tilted glass lens with rim gradient, concentric detail and highlight. */
function lens(p, cx, cy, rx, ry, tilt = -12) {
  return `<g class="vi-lens" transform="rotate(${tilt} ${cx} ${cy})">
<ellipse cx="${cx}" cy="${cy}" rx="${rx + 5}" ry="${ry + 6}" fill="none" stroke="${C.voice}" stroke-opacity=".07" stroke-width="5"/>
<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="url(#${p}-glass)" stroke="#e8eef5" stroke-opacity=".35" stroke-width="1"/>
<ellipse cx="${cx}" cy="${cy}" rx="${rx * 0.78}" ry="${ry * 0.86}" fill="none" stroke="#e8eef5" stroke-opacity=".1" stroke-width=".6"/>
<ellipse cx="${cx}" cy="${cy}" rx="${rx * 0.52}" ry="${ry * 0.7}" fill="none" stroke="#e8eef5" stroke-opacity=".07" stroke-width=".6"/>
<ellipse class="vi-lens__rim" cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="none" stroke="url(#${p}-edge)" stroke-width="2.2"/>
<path d="M${cx - rx * 0.55} ${cy - ry * 0.7}Q${cx - rx * 0.1} ${cy - ry * 1.02} ${cx + rx * 0.45} ${cy - ry * 0.78}" fill="none" stroke="#fff" stroke-opacity=".45" stroke-width="1.4" stroke-linecap="round"/>
</g>`;
}

/** Ribbon with a soft wide underlay instead of an SVG blur filter (cheaper). */
function ribbon(d, grad, width, cls) {
  return `<g class="${cls}"><path d="${d}" fill="none" stroke="url(#${grad})" stroke-opacity=".16" stroke-width="${width * 4}" stroke-linecap="round"/><path d="${d}" fill="none" stroke="url(#${grad})" stroke-width="${width}" stroke-linecap="round"/><path d="${d}" fill="none" stroke="#fff" stroke-opacity=".35" stroke-width=".7" stroke-linecap="round"/></g>`;
}

function label(x, y, text, color, anchor = 'start') {
  return `<g class="vi-tag"><circle cx="${x}" cy="${y - 3.5}" r="2.4" fill="${color}"/><text class="vi-label" x="${anchor === 'end' ? x - 7 : x + 7}" y="${y}" text-anchor="${anchor}">${text}</text></g>`;
}

/**
 * How-it-works feature drawing: original -> lens -> voice + background.
 * viewBox 720 x 300.
 */
export function splitIllustration() {
  const p = uid('split');
  const W = 720; const H = 300;
  const cx = 362; const cy = 150;
  const mix = barWavePath({ x: 28, y: cy, width: 236, height: 130, bars: 58, kind: 'mix', seed: 7 });
  const mixEnv = envelopePath({ x: 28, y: cy, width: 236, height: 150, points: 40, kind: 'mix', seed: 9 });
  const strandA = strandPath({ x: 250, y: cy, width: 92, amplitude: 9, cycles: 2.5, phase: 0 });
  const strandB = strandPath({ x: 250, y: cy, width: 92, amplitude: 9, cycles: 2.5, phase: Math.PI });
  const voiceRib = ribbonPath(386, cy - 6, 700, 74);
  const bgRib = ribbonPath(386, cy + 6, 700, 228);
  const voiceBars = barWavePath({ x: 470, y: 74, width: 226, height: 72, bars: 46, kind: 'speech', seed: 11 });
  const bgBed = envelopePath({ x: 470, y: 228, width: 226, height: 40, points: 46, kind: 'bed', seed: 13 });
  const ticks = tickPath({ x: 28, y: 274, width: 668, count: 57, major: 8 });
  return `${svgOpen(`0 0 ${W} ${H}`, 'vi-split', 'One recording passes a glass lens and splits into a cyan clean voice ribbon and a gold background ribbon.')}
${defs(p, W, H)}
${grid(W, H, 36, 0.045)}
<path d="${ticks}" stroke="#e8eef5" stroke-opacity=".22" stroke-width=".8"/>
<path d="${mixEnv}" fill="url(#${p}-fadeV)" stroke="${C.ref}" stroke-opacity=".18" stroke-width=".6"/>
<path class="vi-mix" d="${mix}" stroke="url(#${p}-ref)" stroke-width="2" stroke-linecap="round"/>
<g class="vi-braid"><path d="M244 ${cy}H344" stroke="${C.ref}" stroke-opacity=".12" stroke-width="22" stroke-linecap="round"/>
<path d="${strandA}" fill="none" stroke="${C.voice}" stroke-width="1.6" stroke-opacity=".85"/><path d="${strandB}" fill="none" stroke="${C.bgst}" stroke-width="1.6" stroke-opacity=".8"/></g>
${lens(p, cx, cy, 30, 92)}
${ribbon(voiceRib, `${p}-voice`, 3.4, 'vi-ribbon vi-ribbon--voice')}
${ribbon(bgRib, `${p}-bg`, 3, 'vi-ribbon vi-ribbon--bg')}
<path class="vi-voicebars" d="${voiceBars}" stroke="${C.voice}" stroke-width="2" stroke-linecap="round" stroke-opacity=".9"/>
<path d="${bgBed}" fill="url(#${p}-hatch)" stroke="${C.bgst}" stroke-opacity=".5" stroke-width=".7"/>
<g mask="url(#${p}-sweep)" class="vi-sheen"><path d="${voiceBars}" stroke="#e9fbff" stroke-width="2.2" stroke-linecap="round"/><path d="${mix}" stroke="#ffffff" stroke-opacity=".7" stroke-width="2" stroke-linecap="round"/><path d="${voiceRib}" fill="none" stroke="#e9fbff" stroke-width="3.6" stroke-linecap="round"/></g>
${label(30, 66, 'ORIGINAL', C.ref)}
${label(470, 30, 'CLEAN VOICE', C.voice)}
${label(470, 286, 'BACKGROUND', C.bgst)}
</svg>`;
}

/** Seven compact glyphs for the processing pipeline cards (120 x 56). */
const PIPELINE_GLYPHS = {
  input(p) {
    const w = barWavePath({ x: 24, y: 32, width: 28, height: 18, bars: 9, kind: 'mix', seed: 3 });
    return `<path d="M16 8h28l8 8v32H16z" fill="url(#${p}-fadeV)" stroke="${C.ref}" stroke-opacity=".7"/><path d="M44 8v8h8" fill="none" stroke="${C.ref}" stroke-opacity=".7"/><path d="${w}" stroke="${C.ref}" stroke-width="1.6" stroke-linecap="round"/><path class="vi-arrow" d="M66 28h34m-7-6 7 6-7 6" fill="none" stroke="${C.ref}" stroke-opacity=".6" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>`;
  },
  decode(p) {
    const w = strandPath({ x: 10, y: 28, width: 52, amplitude: 13, cycles: 1.5, points: 30 });
    let dots = '';
    for (let i = 0; i < 9; i++) {
      const x = 68 + i * 5.5;
      const y = 28 + Math.sin((i / 8) * Math.PI * 3) * 13;
      dots += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="1.5" fill="${C.voice}"/><path d="M${x.toFixed(1)} 28V${y.toFixed(1)}" stroke="${C.voice}" stroke-opacity=".35" stroke-width=".8"/>`;
    }
    return `<path d="M8 28H112" stroke="#e8eef5" stroke-opacity=".12"/><path d="${w}" fill="none" stroke="url(#${p}-ref)" stroke-width="1.6"/>${dots}`;
  },
  separate(p) {
    return `<path d="M8 28C24 22 30 34 46 28" fill="none" stroke="${C.ref}" stroke-width="1.6"/>${lens(p, 58, 28, 8, 20, -10)}${ribbon(ribbonPath(66, 26, 112, 10), `${p}-voice`, 2, 'vi-ribbon vi-ribbon--voice')}${ribbon(ribbonPath(66, 30, 112, 46), `${p}-bg`, 2, 'vi-ribbon vi-ribbon--bg')}`;
  },
  spectral() {
    const rand = (i, j) => (Math.sin(i * 12.9898 + j * 78.233) * 43758.5453) % 1;
    let cells = '';
    for (let i = 0; i < 14; i++) {
      for (let j = 0; j < 6; j++) {
        const v = Math.abs(rand(i, j));
        const voiceBand = j >= 2 && j <= 3 && i % 4 !== 3;
        const fill = voiceBand ? C.voice : C.ref;
        const op = voiceBand ? 0.35 + 0.55 * v : 0.06 + 0.16 * v;
        cells += `<rect x="${12 + i * 7}" y="${8 + j * 7}" width="6" height="6" rx="1" fill="${fill}" fill-opacity="${op.toFixed(2)}"/>`;
      }
    }
    return `${cells}<rect x="10" y="20" width="100" height="16" rx="3" fill="none" stroke="${C.voice}" stroke-opacity=".6" stroke-dasharray="2 2"/>`;
  },
  reconstruct(p) {
    let cells = '';
    for (let j = 0; j < 5; j++) cells += `<rect x="${10 + (j % 2) * 7}" y="${10 + j * 8}" width="6" height="6" rx="1" fill="${C.voice}" fill-opacity="${(0.25 + j * 0.12).toFixed(2)}"/>`;
    const out = barWavePath({ x: 60, y: 28, width: 50, height: 36, bars: 14, kind: 'speech', seed: 5 });
    return `${cells}<path d="M28 28C40 28 44 28 54 28" stroke="url(#${p}-voice)" stroke-width="1.6"/><path d="${out}" stroke="${C.voice}" stroke-width="2" stroke-linecap="round"/>`;
  },
  livemix() {
    const fader = (x, color, cap) => `<path d="M${x} 8V48" stroke="#e8eef5" stroke-opacity=".15" stroke-width="3" stroke-linecap="round"/><path d="M${x} ${cap}V48" stroke="${color}" stroke-width="3" stroke-linecap="round"/><rect class="vi-cap" x="${x - 7}" y="${cap - 3}" width="14" height="6" rx="2" fill="#dfe6ee" stroke="${color}"/>`;
    let ticks = '';
    for (let i = 0; i < 9; i++) ticks += `M${52} ${8 + i * 5}h${i % 4 === 0 ? 8 : 4}`;
    return `${fader(30, C.voice, 16)}${fader(86, C.bgst, 32)}<path d="${ticks}" stroke="#e8eef5" stroke-opacity=".3" stroke-width=".8"/>`;
  },
  export(p) {
    const w = barWavePath({ x: 24, y: 30, width: 26, height: 16, bars: 8, kind: 'speech', seed: 21 });
    return `<path d="M16 8h28l8 8v32H16z" fill="url(#${p}-fadeV)" stroke="${C.voice}" stroke-opacity=".7"/><path d="M44 8v8h8" fill="none" stroke="${C.voice}" stroke-opacity=".7"/><path d="${w}" stroke="${C.voice}" stroke-width="1.6" stroke-linecap="round"/><path class="vi-arrow" d="M84 12v26m-7-7 7 7 7-7M72 46h24" fill="none" stroke="${C.ref}" stroke-opacity=".7" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>`;
  },
};

export const PIPELINE_GLYPH_NAMES = Object.freeze(Object.keys(PIPELINE_GLYPHS));

export function pipelineGlyph(name) {
  const draw = PIPELINE_GLYPHS[name];
  if (!draw) return '';
  const p = uid(`pipe-${name}`);
  return `${svgOpen('0 0 120 56', `vi-glyph vi-glyph--${name}`)}${defs(p, 120, 56)}${draw(p)}</svg>`;
}

/**
 * Drop-zone drawing (320 x 132): a file drops toward the lens; the lens
 * splits the silver recording into cyan voice and gold background.
 */
export function dropIllustration() {
  const p = uid('drop');
  const W = 320; const H = 140;
  const cx = 160; const cy = 82;
  const mix = barWavePath({ x: 18, y: cy, width: 112, height: 50, bars: 26, kind: 'mix', seed: 31 });
  const voice = barWavePath({ x: 196, y: cy - 20, width: 106, height: 30, bars: 24, kind: 'speech', seed: 33 });
  const bed = envelopePath({ x: 196, y: cy + 26, width: 106, height: 18, points: 24, kind: 'bed', seed: 35 });
  return `${svgOpen(`0 0 ${W} ${H}`, 'vi-drop')}
${defs(p, W, H)}
${grid(W, H, 16, 0.04)}
<path class="vi-mix" d="${mix}" stroke="url(#${p}-ref)" stroke-width="2" stroke-linecap="round"/>
<path d="M126 ${cy}H146" stroke="${C.ref}" stroke-opacity=".35" stroke-width="1.2" stroke-dasharray="2 3"/>
${lens(p, cx, cy, 14, 36, -8)}
<g class="vi-out">
${ribbon(ribbonPath(172, cy - 3, 196, cy - 20, 0.5), `${p}-voice`, 2, 'vi-ribbon vi-ribbon--voice')}
${ribbon(ribbonPath(172, cy + 3, 196, cy + 26, 0.5), `${p}-bg`, 2, 'vi-ribbon vi-ribbon--bg')}
<path class="vi-voicebars" d="${voice}" stroke="${C.voice}" stroke-width="2" stroke-linecap="round"/>
<path d="${bed}" fill="url(#${p}-hatch)" stroke="${C.bgst}" stroke-opacity=".55" stroke-width=".7"/>
</g>
<g mask="url(#${p}-sweep)" class="vi-sheen"><path d="${mix}" stroke="#fff" stroke-opacity=".8" stroke-width="2" stroke-linecap="round"/><path d="${voice}" stroke="#e9fbff" stroke-width="2.2" stroke-linecap="round"/></g>
<g class="vi-file"><path d="M148 6h18l7 7v22h-25z" fill="${C.canvas}" stroke="#e8eef5" stroke-opacity=".7"/><path d="M166 6v7h7" fill="none" stroke="#e8eef5" stroke-opacity=".7"/><path d="M160 38v8m-4-4 4 4 4-4" fill="none" stroke="${C.voice}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="${barWavePath({ x: 153, y: 22, width: 14, height: 10, bars: 5, kind: 'mix', seed: 2 })}" stroke="${C.ref}" stroke-width="1.4" stroke-linecap="round"/></g>
</svg>`;
}

/**
 * Engineer empty state (640 x 230): ruler, three aligned lanes (silver
 * original outline, solid cyan voice, hatched gold background), loop region
 * and a parked playhead. The lanes are a drawing, not the user's audio.
 */
export function engineerEmptyIllustration() {
  const p = uid('eng');
  const W = 640; const H = 230;
  const x0 = 116; const lw = 504;
  const ruler = tickPath({ x: x0, y: 14, width: lw, count: 65, major: 8, minorH: 3, majorH: 7 });
  let times = '';
  for (let i = 0; i <= 8; i++) times += `<text class="vi-label vi-label--mono" x="${x0 + (lw * i) / 8 + 3}" y="30">0${Math.floor(i / 2)}:${i % 2 ? '30' : '00'}</text>`;
  const orig = envelopePath({ x: x0, y: 70, width: lw, height: 44, points: 90, kind: 'mix', seed: 41 });
  const voice = barWavePath({ x: x0, y: 128, width: lw, height: 50, bars: 120, kind: 'speech', seed: 43 });
  const bed = envelopePath({ x: x0, y: 186, width: lw, height: 30, points: 90, kind: 'bed', seed: 45 });
  const lane = (y, name, color) => `<rect x="12" y="${y - 22}" width="${W - 24}" height="44" rx="6" fill="#e8eef5" fill-opacity=".02" stroke="#e8eef5" stroke-opacity=".06"/><circle cx="26" cy="${y}" r="3" fill="${color}"/><text class="vi-label" x="36" y="${y + 3.5}">${name}</text>`;
  return `${svgOpen(`0 0 ${W} ${H}`, 'vi-engineer')}
${defs(p, W, H)}
<path d="${ruler}" stroke="#e8eef5" stroke-opacity=".28" stroke-width=".8"/>${times}
<rect class="vi-loop" x="${x0 + lw * 0.42}" y="40" width="${lw * 0.22}" height="${H - 46}" fill="#e8eef5" fill-opacity=".035" stroke="#e8eef5" stroke-opacity=".12" stroke-dasharray="3 3"/>
${lane(70, 'Original', C.ref)}${lane(128, 'Clean Voice', C.voice)}${lane(186, 'Background', C.bgst)}
<path d="${orig}" fill="none" stroke="${C.ref}" stroke-opacity=".75" stroke-width="1"/>
<path class="vi-voicebars" d="${voice}" stroke="${C.voice}" stroke-width="1.6" stroke-linecap="round" stroke-opacity=".9"/>
<path d="${bed}" fill="url(#${p}-hatch)" stroke="${C.bgst}" stroke-opacity=".5" stroke-width=".7"/>
<g mask="url(#${p}-sweep)" class="vi-sheen"><path d="${voice}" stroke="#e9fbff" stroke-width="1.8" stroke-linecap="round"/><path d="${orig}" fill="none" stroke="#fff" stroke-width="1.2"/></g>
<path class="vi-playhead" d="M${x0 + lw * 0.3} 36V${H - 4}" stroke="#fff" stroke-opacity=".8" stroke-width="1.2"/><path d="M${x0 + lw * 0.3 - 5} 36h10l-5 6z" fill="#fff" fill-opacity=".85"/>
</svg>`;
}

const BUILDERS = {
  split: splitIllustration,
  drop: dropIllustration,
  'engineer-empty': engineerEmptyIllustration,
};
for (const name of PIPELINE_GLYPH_NAMES) BUILDERS[`pipeline-${name}`] = () => pipelineGlyph(name);

export const ILLUSTRATION_NAMES = Object.freeze(Object.keys(BUILDERS));

/** Markup for a named illustration, or '' for an unknown name. */
export function illustrationMarkup(name) {
  const build = BUILDERS[name];
  return build ? build() : '';
}

/**
 * Fill every `[data-vip-illustration]` host under `root` once.
 * @returns {number} hosts filled
 */
export function mountIllustrations(root = globalThis.document) {
  if (!root?.querySelectorAll) return 0;
  let n = 0;
  for (const host of root.querySelectorAll('[data-vip-illustration]')) {
    if (host.dataset.vipIllustrated === '1') continue;
    const markup = illustrationMarkup(host.dataset.vipIllustration);
    if (!markup) continue;
    host.insertAdjacentHTML('afterbegin', markup);
    host.dataset.vipIllustrated = '1';
    n += 1;
  }
  return n;
}
