/* @ds-bundle: {"format":3,"namespace":"VoiceIsolateProDesignSystem_38f745","components":[{"name":"LevelMeter","sourcePath":"components/audio/LevelMeter.jsx"},{"name":"ParamSlider","sourcePath":"components/audio/ParamSlider.jsx"},{"name":"ProcessLoader","sourcePath":"components/audio/ProcessLoader.jsx"},{"name":"Spectrogram","sourcePath":"components/audio/Spectrogram.jsx"},{"name":"Waveform","sourcePath":"components/audio/Waveform.jsx"},{"name":"Badge","sourcePath":"components/core/Badge.jsx"},{"name":"Button","sourcePath":"components/core/Button.jsx"},{"name":"Card","sourcePath":"components/core/Card.jsx"},{"name":"IconButton","sourcePath":"components/core/IconButton.jsx"},{"name":"Input","sourcePath":"components/core/Input.jsx"},{"name":"Select","sourcePath":"components/core/Select.jsx"},{"name":"StatusPill","sourcePath":"components/core/StatusPill.jsx"},{"name":"Switch","sourcePath":"components/core/Switch.jsx"}],"sourceHashes":{"Header.jsx":"856bd28a9dad","VizPanel.jsx":"7822ecfae206","components/audio/LevelMeter.jsx":"5323c4c12b52","components/audio/ParamSlider.jsx":"97aea8a94921","components/audio/ProcessLoader.jsx":"707e1782f499","components/audio/Spectrogram.jsx":"f1cb930d8ccb","components/audio/Waveform.jsx":"bc38325af069","components/core/Badge.jsx":"a1ef51e0035d","components/core/Button.jsx":"5376c8c51c0a","components/core/Card.jsx":"44dbbc122364","components/core/IconButton.jsx":"bee03a702550","components/core/Input.jsx":"78e1906962cf","components/core/Select.jsx":"f348c4c7fe84","components/core/StatusPill.jsx":"b649ac33981b","components/core/Switch.jsx":"39732110cd4c","ui_kits/engineer/ControlRail.jsx":"dbca9a961110","ui_kits/engineer/Icons.jsx":"6d9e7863213f","ui_kits/engineer/StemPanel.jsx":"d626af80bd7f","ui_kits/engineer/TitleBar.jsx":"ac4e1c3fff53","ui_kits/engineer/Transport.jsx":"441b97f43b38"},"inlinedExternals":[],"unexposedExports":[]} */

(() => {

const __ds_ns = (window.VoiceIsolateProDesignSystem_38f745 = window.VoiceIsolateProDesignSystem_38f745 || {});

const __ds_scope = {};

(__ds_ns.__errors = __ds_ns.__errors || []);

// Header.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
// Header.jsx — top app bar: brand, UI-scale stepper, session stat readouts.
function HeaderStat({
  label,
  value,
  accent
}) {
  return /*#__PURE__*/React.createElement("div", {
    className: "ew-hstat"
  }, /*#__PURE__*/React.createElement("span", {
    className: "ew-hstat__v",
    style: accent ? null : {
      color: 'var(--text-hi)'
    }
  }, value), /*#__PURE__*/React.createElement("span", {
    className: "ew-hstat__l"
  }, label));
}
function Header({
  stats,
  scale,
  onScale,
  onSaveScale
}) {
  const {
    Button,
    Badge
  } = window.VoiceIsolateProDesignSystem_38f745;
  return /*#__PURE__*/React.createElement("header", {
    className: "ew-hdr"
  }, /*#__PURE__*/React.createElement("div", {
    className: "ew-hdr__left"
  }, /*#__PURE__*/React.createElement("div", {
    className: "ew-hdr__icon",
    "aria-label": "VoiceIsolate Pro",
    "data-comment-anchor": "3fe7137db0-div-17-9"
  }, /*#__PURE__*/React.createElement("svg", {
    width: "20",
    height: "20",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "#fff",
    strokeWidth: "2.5",
    strokeLinecap: "round"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M12 1v22M8 5v14M4 9v6M16 5v14M20 9v6"
  }))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h1", {
    className: "ew-hdr__title"
  }, "VoiceIsolate ", /*#__PURE__*/React.createElement("em", null, "Pro"), " ", /*#__PURE__*/React.createElement("span", {
    className: "ew-hdr__ver"
  }, "v25.0")), /*#__PURE__*/React.createElement("div", {
    className: "ew-hdr__badges"
  }, /*#__PURE__*/React.createElement(Badge, {
    variant: "accent"
  }, "Engineer Mode"), /*#__PURE__*/React.createElement(Badge, null, "32-Stage Deca-Pass")))), /*#__PURE__*/React.createElement("div", {
    className: "ew-hdr__scale",
    role: "group",
    "aria-label": "UI scale"
  }, /*#__PURE__*/React.createElement("button", {
    className: "ew-step",
    type: "button",
    "aria-label": "Decrease UI scale",
    onClick: () => onScale(-5)
  }, "\u2212"), /*#__PURE__*/React.createElement("span", {
    className: "ew-step__val"
  }, scale, "%"), /*#__PURE__*/React.createElement("button", {
    className: "ew-step",
    type: "button",
    "aria-label": "Increase UI scale",
    onClick: () => onScale(5)
  }, "+"), /*#__PURE__*/React.createElement("button", {
    className: "ew-step ew-step--text",
    type: "button",
    onClick: onSaveScale
  }, "Save")), /*#__PURE__*/React.createElement("div", {
    className: "ew-hdr__stats"
  }, stats.map(s => /*#__PURE__*/React.createElement(HeaderStat, _extends({
    key: s.label
  }, s)))), /*#__PURE__*/React.createElement("div", {
    className: "ew-hdr__actions"
  }, /*#__PURE__*/React.createElement(Button, {
    variant: "outline",
    size: "sm"
  }, "How It Works")));
}
window.Header = Header;
})(); } catch (e) { __ds_ns.__errors.push({ path: "Header.jsx", error: String((e && e.message) || e) }); }

// VizPanel.jsx
try { (() => {
// VizPanel.jsx — right column: transport (A/B compare) + 9 visualization tabs.
const NS_VZ = window.VoiceIsolateProDesignSystem_38f745;
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// Deterministic PRNG so each viz is stable per seed.
function rng(seed) {
  let s = seed * 9301 + 49297;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}
function VizCanvas({
  type,
  seed = 4,
  height = 200,
  playhead = 0,
  themeKey,
  active
}) {
  const ref = React.useRef(null);
  React.useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const W = cv.offsetWidth || 600,
      H = height;
    cv.width = W * dpr;
    cv.height = H * dpr;
    const ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);
    const red = cssVar('--red-600') || '#dc2626';
    const red2 = cssVar('--red-400') || '#f87171';
    const hot = cssVar('--signal-hot') || '#f97316';
    const ok = cssVar('--ok') || '#34d399';
    const info = cssVar('--info') || '#60a5fa';
    const dim = cssVar('--text-dim') || '#5e5e78';
    const border = cssVar('--border-strong') || '#2a2a30';
    const r = rng(seed);
    ctx.strokeStyle = border;
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.moveTo(0, H / 2);
    ctx.lineTo(W, H / 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
    if (type === 'aura') {
      const cx = W / 2,
        cy = H / 2;
      for (let ring = 8; ring >= 1; ring--) {
        const rad = ring / 8 * Math.min(W, H) * 0.46;
        ctx.beginPath();
        for (let a = 0; a <= Math.PI * 2 + 0.1; a += 0.12) {
          const wob = 1 + Math.sin(a * (3 + ring) + ring) * 0.08 * (r() + 0.5);
          const x = cx + Math.cos(a) * rad * wob,
            y = cy + Math.sin(a) * rad * wob;
          a === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.strokeStyle = ring % 2 ? red : hot;
        ctx.globalAlpha = 0.12 + ring / 8 * 0.35;
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    } else if (type === 'topo') {
      ctx.lineWidth = 1;
      for (let row = 0; row < 14; row++) {
        ctx.beginPath();
        const base = row / 14 * H;
        for (let x = 0; x <= W; x += 6) {
          const y = base + Math.sin(x * 0.02 + row * 0.6 + seed) * 10 * Math.sin(x * 0.004 + row);
          x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        const t = row / 14;
        ctx.strokeStyle = t < 0.5 ? red : hot;
        ctx.globalAlpha = 0.25 + t * 0.5;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    } else if (type === 'swarm') {
      const N = 220;
      for (let i = 0; i < N; i++) {
        const x = r() * W,
          y = r() * H;
        const d = Math.abs(y - H / 2) / (H / 2);
        ctx.beginPath();
        ctx.arc(x, y, 1 + r() * 2.2, 0, Math.PI * 2);
        ctx.fillStyle = d < 0.4 ? red : d < 0.7 ? hot : info;
        ctx.globalAlpha = 0.3 + (1 - d) * 0.6;
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    } else if (type === 'liquid') {
      const grad = ctx.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0, red);
      grad.addColorStop(1, hot);
      ctx.fillStyle = grad;
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      ctx.moveTo(0, H);
      for (let x = 0; x <= W; x += 5) {
        const y = H * 0.55 + Math.sin(x * 0.016 + seed) * 22 + Math.sin(x * 0.05) * 8 * r();
        ctx.lineTo(x, y);
      }
      ctx.lineTo(W, H);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 0.35;
      ctx.beginPath();
      ctx.moveTo(0, H);
      for (let x = 0; x <= W; x += 5) {
        const y = H * 0.7 + Math.cos(x * 0.02 + seed * 2) * 16;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(W, H);
      ctx.closePath();
      ctx.fillStyle = red2;
      ctx.fill();
      ctx.globalAlpha = 1;
    } else if (type === 'clusters') {
      const speakers = [red, info, ok, hot];
      const segs = 26;
      let x = 0;
      for (let i = 0; i < segs; i++) {
        const w = (0.3 + r()) * (W / segs);
        const sp = speakers[Math.floor(r() * speakers.length)];
        ctx.fillStyle = sp;
        ctx.globalAlpha = 0.55;
        ctx.fillRect(x, H * 0.3, w - 2, H * 0.4);
        x += w;
        if (x > W) break;
      }
      ctx.globalAlpha = 1;
    } else if (type === 'freq') {
      const bars = 64,
        bw = W / bars;
      for (let i = 0; i < bars; i++) {
        const h = (r() * 0.7 + Math.sin(i * 0.3) * 0.2 + 0.2) * H;
        const t = i / bars;
        ctx.fillStyle = t < 0.6 ? red : hot;
        ctx.globalAlpha = 0.8;
        ctx.fillRect(i * bw, H - h, bw - 1, h);
      }
      ctx.globalAlpha = 1;
    }
    if ((type === 'aura' || type === 'topo' || type === 'liquid') && playhead > 0) {
      ctx.strokeStyle = red2;
      ctx.globalAlpha = 0.7;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(playhead * W, 0);
      ctx.lineTo(playhead * W, H);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }, [type, seed, height, playhead, themeKey, active]);
  return /*#__PURE__*/React.createElement("canvas", {
    ref: ref,
    className: "ew-canvas",
    style: {
      height,
      width: '100%',
      display: 'block'
    }
  });
}
const TABS = [{
  id: 'spectrogram',
  label: 'Spectrogram'
}, {
  id: 'waveform',
  label: 'Waveform'
}, {
  id: 'abcompare',
  label: 'A/B'
}, {
  id: 'lufs',
  label: 'LUFS'
}, {
  id: 'clusters',
  label: 'Clusters'
}, {
  id: 'aura',
  label: 'Aura'
}, {
  id: 'topo',
  label: '3D Topo'
}, {
  id: 'swarm',
  label: 'Swarm'
}, {
  id: 'liquid',
  label: 'Liquid'
}];
function Transport({
  playing,
  onToggle,
  cur,
  dur,
  pct,
  version,
  onVersion
}) {
  const {
    IconButton,
    Button
  } = NS_VZ;
  const I = window.Icons;
  return /*#__PURE__*/React.createElement("div", {
    className: "ew-card ew-transport"
  }, /*#__PURE__*/React.createElement("button", {
    className: "ew-tp__play",
    type: "button",
    onClick: onToggle,
    "aria-label": playing ? 'Pause' : 'Play'
  }, playing ? /*#__PURE__*/React.createElement(I.Pause, {
    size: 16
  }) : /*#__PURE__*/React.createElement(I.Play, {
    size: 16
  })), /*#__PURE__*/React.createElement("button", {
    className: "ew-tp__btn",
    type: "button",
    "aria-label": "Stop"
  }, /*#__PURE__*/React.createElement(I.Stop, {
    size: 14
  })), /*#__PURE__*/React.createElement("button", {
    className: "ew-tp__btn",
    type: "button",
    "aria-label": "Rewind"
  }, /*#__PURE__*/React.createElement(I.SkipBack, {
    size: 14
  })), /*#__PURE__*/React.createElement("button", {
    className: "ew-tp__btn",
    type: "button",
    "aria-label": "Forward"
  }, /*#__PURE__*/React.createElement(I.SkipFwd, {
    size: 14
  })), /*#__PURE__*/React.createElement("span", {
    className: "ew-tp__time ew-mono"
  }, cur), /*#__PURE__*/React.createElement("input", {
    type: "range",
    className: "ew-tp__seek",
    min: "0",
    max: "100",
    value: pct,
    readOnly: true,
    style: {
      '--pct': pct + '%'
    },
    "aria-label": "Playback position"
  }), /*#__PURE__*/React.createElement("span", {
    className: "ew-tp__time ew-mono ew-faint"
  }, dur), /*#__PURE__*/React.createElement("div", {
    className: "ew-tp__speed"
  }, /*#__PURE__*/React.createElement("label", {
    className: "ew-faint"
  }, "Speed"), /*#__PURE__*/React.createElement("select", {
    "aria-label": "Playback speed",
    defaultValue: "1"
  }, /*#__PURE__*/React.createElement("option", {
    value: "0.5"
  }, "0.5\xD7"), /*#__PURE__*/React.createElement("option", {
    value: "0.75"
  }, "0.75\xD7"), /*#__PURE__*/React.createElement("option", {
    value: "1"
  }, "1\xD7"), /*#__PURE__*/React.createElement("option", {
    value: "1.5"
  }, "1.5\xD7"), /*#__PURE__*/React.createElement("option", {
    value: "2"
  }, "2\xD7"))), /*#__PURE__*/React.createElement("button", {
    className: `ew-tp__ab ew-tp__ab--${version}`,
    type: "button",
    onClick: onVersion,
    "aria-label": "A/B compare"
  }, /*#__PURE__*/React.createElement("span", {
    className: "ew-tp__abtag"
  }, version), /*#__PURE__*/React.createElement("span", null, version === 'A' ? 'Original' : 'Processed')));
}
function AnalysisDeck({
  themeKey,
  playhead
}) {
  const {
    Spectrogram,
    Waveform
  } = NS_VZ;
  const speakers = [{
    id: 'S1',
    color: 'var(--red-500)',
    pct: 58
  }, {
    id: 'S2',
    color: 'var(--info)',
    pct: 24
  }, {
    id: 'S3',
    color: 'var(--ok)',
    pct: 12
  }, {
    id: 'S4',
    color: 'var(--signal-hot)',
    pct: 6
  }];
  return /*#__PURE__*/React.createElement("div", {
    className: "ew-card ew-analysis",
    "data-comment-anchor": "496eee54c3-div-175-5"
  }, /*#__PURE__*/React.createElement("div", {
    className: "ew-viz__hdr"
  }, /*#__PURE__*/React.createElement("span", {
    className: "ew-kicker"
  }, "Live Analysis"), /*#__PURE__*/React.createElement("span", {
    className: "ew-mono ew-faint",
    style: {
      fontSize: 'var(--fs-3xs)'
    }
  }, "always-on \xB7 local")), /*#__PURE__*/React.createElement("div", {
    className: "ew-analysis__grid"
  }, /*#__PURE__*/React.createElement("div", {
    className: "ew-analysis__cell"
  }, /*#__PURE__*/React.createElement("div", {
    className: "ew-ablabel ew-mono"
  }, "Spectrograph"), /*#__PURE__*/React.createElement(Spectrogram, {
    seed: 14,
    height: 92
  })), /*#__PURE__*/React.createElement("div", {
    className: "ew-analysis__cell"
  }, /*#__PURE__*/React.createElement("div", {
    className: "ew-ablabel ew-mono"
  }, "Wave Analyzer"), /*#__PURE__*/React.createElement(Waveform, {
    seed: 21,
    height: 92,
    playhead: playhead
  })), /*#__PURE__*/React.createElement("div", {
    className: "ew-analysis__cell"
  }, /*#__PURE__*/React.createElement("div", {
    className: "ew-ablabel ew-mono"
  }, "Voice / Speaker ID"), /*#__PURE__*/React.createElement(VizCanvas, {
    type: "clusters",
    seed: 5,
    height: 56,
    themeKey: themeKey,
    active: true
  }), /*#__PURE__*/React.createElement("div", {
    className: "ew-speakers"
  }, speakers.map(s => /*#__PURE__*/React.createElement("span", {
    key: s.id,
    className: "ew-speaker ew-mono"
  }, /*#__PURE__*/React.createElement("span", {
    className: "ew-speaker__dot",
    style: {
      background: s.color
    }
  }), s.id, " \xB7 ", s.pct, "%"))))));
}
function VizPanel({
  themeKey,
  playing,
  onToggle,
  playhead,
  fileLoaded
}) {
  const {
    Waveform,
    Spectrogram,
    IconButton
  } = NS_VZ;
  const [tab, setTab] = React.useState('spectrogram');
  const [version, setVersion] = React.useState('A');
  const secs = Math.round(playhead * 252);
  const fmt = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  return /*#__PURE__*/React.createElement("section", {
    className: "ew-col"
  }, /*#__PURE__*/React.createElement(Transport, {
    playing: playing,
    onToggle: onToggle,
    cur: fmt(secs),
    dur: "4:12",
    pct: Math.round(playhead * 100),
    version: version,
    onVersion: () => setVersion(v => v === 'A' ? 'B' : 'A')
  }), /*#__PURE__*/React.createElement("div", {
    className: "ew-card ew-viz"
  }, /*#__PURE__*/React.createElement("div", {
    className: "ew-viz__hdr"
  }, /*#__PURE__*/React.createElement("span", {
    className: "ew-kicker"
  }, "Visualizations"), /*#__PURE__*/React.createElement("button", {
    className: "ew-step",
    type: "button",
    "aria-label": "Fullscreen"
  }, /*#__PURE__*/React.createElement(window.Icons.Maximize, {
    size: 13
  }))), /*#__PURE__*/React.createElement("div", {
    className: "ew-tabs",
    role: "tablist"
  }, TABS.map(t => /*#__PURE__*/React.createElement("button", {
    key: t.id,
    type: "button",
    role: "tab",
    className: `ew-tab${tab === t.id ? ' ew-tab--active' : ''}`,
    "aria-selected": tab === t.id,
    onClick: () => setTab(t.id)
  }, t.label))), /*#__PURE__*/React.createElement("div", {
    className: "ew-viz__body"
  }, tab === 'spectrogram' && /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "ew-legend ew-mono"
  }, "Live spectrum rail \xB7 scrolling spectrogram \xB7 local-only render"), /*#__PURE__*/React.createElement(Spectrogram, {
    seed: 3,
    height: 190
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 8
    }
  }, /*#__PURE__*/React.createElement(VizCanvas, {
    type: "freq",
    seed: 11,
    height: 72,
    themeKey: themeKey,
    active: true
  }))), tab === 'waveform' && /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "ew-legend ew-mono"
  }, "Static waveform \xB7 live playhead during transport"), /*#__PURE__*/React.createElement(Waveform, {
    seed: 7,
    height: 150,
    playhead: playhead,
    selection: [0.30, 0.62]
  })), tab === 'abcompare' && /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "ew-legend ew-mono"
  }, "Original vs processed overlay"), /*#__PURE__*/React.createElement("div", {
    className: "ew-abgrid"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "ew-ablabel ew-mono"
  }, "A \xB7 Original"), /*#__PURE__*/React.createElement(Waveform, {
    seed: 7,
    height: 110,
    color: "var(--text-dim)",
    playhead: playhead
  })), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "ew-ablabel ew-mono",
    style: {
      color: 'var(--red-400)'
    }
  }, "B \xB7 Processed"), /*#__PURE__*/React.createElement(Waveform, {
    seed: 7,
    height: 110,
    playhead: playhead
  })))), tab === 'lufs' && /*#__PURE__*/React.createElement("div", {
    className: "ew-lufs"
  }, [['-23.0', 'Integrated LUFS'], ['-20.0', 'Short-Term LUFS'], ['-1.2', 'True Peak dBTP'], ['7.4', 'LRA']].map(([v, l]) => /*#__PURE__*/React.createElement("div", {
    key: l,
    className: "ew-lufs__cell"
  }, /*#__PURE__*/React.createElement("div", {
    className: "ew-lufs__v ew-mono"
  }, v), /*#__PURE__*/React.createElement("div", {
    className: "ew-lufs__l"
  }, l)))), tab === 'clusters' && /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "ew-legend ew-mono"
  }, "Speaker diarization \xB7 4 clusters detected"), /*#__PURE__*/React.createElement(VizCanvas, {
    type: "clusters",
    seed: 5,
    height: 120,
    themeKey: themeKey,
    active: true
  })), tab === 'aura' && /*#__PURE__*/React.createElement(VizCanvas, {
    type: "aura",
    seed: 9,
    height: 210,
    playhead: playhead,
    themeKey: themeKey,
    active: true
  }), tab === 'topo' && /*#__PURE__*/React.createElement(VizCanvas, {
    type: "topo",
    seed: 2,
    height: 210,
    playhead: playhead,
    themeKey: themeKey,
    active: true
  }), tab === 'swarm' && /*#__PURE__*/React.createElement(VizCanvas, {
    type: "swarm",
    seed: 8,
    height: 210,
    themeKey: themeKey,
    active: true
  }), tab === 'liquid' && /*#__PURE__*/React.createElement(VizCanvas, {
    type: "liquid",
    seed: 6,
    height: 210,
    playhead: playhead,
    themeKey: themeKey,
    active: true
  }))), /*#__PURE__*/React.createElement(SignalBridge, {
    playhead: playhead
  }));
}
window.VizPanel = VizPanel;
})(); } catch (e) { __ds_ns.__errors.push({ path: "VizPanel.jsx", error: String((e && e.message) || e) }); }

// components/audio/LevelMeter.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** LevelMeter — horizontal signal meter with red→amber→bone peak gradient. */
function LevelMeter({
  label,
  value = 0,
  peak,
  unit = 'dB',
  className = '',
  ...rest
}) {
  const v = Math.max(0, Math.min(100, value));
  const display = unit === 'dB' ? `${value <= 0 ? '-∞' : (value - 100).toFixed(1)}` : `${Math.round(value)}${unit}`;
  return /*#__PURE__*/React.createElement("div", _extends({
    className: ['vip-meter', className].filter(Boolean).join(' ')
  }, rest), label && /*#__PURE__*/React.createElement("span", {
    className: "vip-meter__label"
  }, label), /*#__PURE__*/React.createElement("span", {
    className: "vip-meter__track"
  }, /*#__PURE__*/React.createElement("span", {
    className: "vip-meter__fill",
    style: {
      width: `${v}%`
    }
  }), peak != null && /*#__PURE__*/React.createElement("span", {
    style: {
      position: 'absolute',
      top: 0,
      bottom: 0,
      left: `${Math.max(0, Math.min(100, peak))}%`,
      width: '2px',
      background: 'var(--signal-peak)',
      opacity: 0.9
    }
  })), /*#__PURE__*/React.createElement("span", {
    className: "vip-meter__val"
  }, display));
}
Object.assign(__ds_scope, { LevelMeter });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/audio/LevelMeter.jsx", error: String((e && e.message) || e) }); }

// components/audio/ParamSlider.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * ParamSlider — the signature control surface row: label · track · mono readout.
 * The red fill tracks the value automatically.
 */
function ParamSlider({
  label,
  value = 50,
  min = 0,
  max = 100,
  step = 1,
  unit = '',
  format,
  onChange,
  className = '',
  ...rest
}) {
  const pct = (value - min) / (max - min) * 100;
  const display = format ? format(value) : `${value}${unit}`;
  return /*#__PURE__*/React.createElement("div", {
    className: ['vip-slider', className].filter(Boolean).join(' ')
  }, /*#__PURE__*/React.createElement("span", {
    className: "vip-slider__label"
  }, label), /*#__PURE__*/React.createElement("input", _extends({
    type: "range",
    className: "vip-slider__input",
    min: min,
    max: max,
    step: step,
    value: value,
    onChange: e => onChange && onChange(parseFloat(e.target.value)),
    style: {
      '--pct': `${pct}%`
    }
  }, rest)), /*#__PURE__*/React.createElement("span", {
    className: "vip-slider__val"
  }, display));
}
Object.assign(__ds_scope, { ParamSlider });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/audio/ParamSlider.jsx", error: String((e && e.message) || e) }); }

// components/audio/ProcessLoader.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const DEFAULT_STAGES = [{
  id: 'decode',
  label: 'Decoding'
}, {
  id: 'analyze',
  label: 'Analyzing'
}, {
  id: 'separate',
  label: 'Separating'
}, {
  id: 'render',
  label: 'Rendering'
}];

/**
 * ProcessLoader — staged audio-processing indicator.
 * A spectral scan-bar runs while the engine works; below it, the
 * pipeline stages light up red as each completes. The active stage
 * pulses and shows live percent. Unique to VoiceIsolate Pro.
 */
function ProcessLoader({
  stages = DEFAULT_STAGES,
  active = 0,
  progress = 0,
  // 0..100 within the active stage
  bars = 48,
  className = '',
  style,
  ...rest
}) {
  const activeStage = stages[Math.max(0, Math.min(active, stages.length - 1))];
  return /*#__PURE__*/React.createElement("div", _extends({
    className: ['vip-ploader', className].filter(Boolean).join(' '),
    style: {
      background: 'var(--canvas-bg)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-lg)',
      padding: 'var(--sp-7)',
      ...style
    },
    role: "progressbar",
    "aria-valuenow": Math.round(progress),
    "aria-valuemin": 0,
    "aria-valuemax": 100,
    "aria-label": activeStage ? activeStage.label : 'Processing'
  }, rest), /*#__PURE__*/React.createElement("div", {
    className: "vip-ploader__scan",
    style: {
      display: 'flex',
      alignItems: 'flex-end',
      gap: 2,
      height: 46,
      marginBottom: 'var(--sp-6)'
    }
  }, Array.from({
    length: bars
  }).map((_, i) => /*#__PURE__*/React.createElement("span", {
    key: i,
    className: "vip-ploader__bar",
    style: {
      flex: 1,
      borderRadius: 1,
      background: 'linear-gradient(180deg, var(--red-400), var(--red-700))',
      animation: `vip-scan 1.05s ${i / bars * 0.9}s ease-in-out infinite`
    }
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 'var(--sp-5)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      font: 'var(--fw-semibold) var(--fs-sm)/1 var(--font-ui)',
      color: 'var(--text-hi)'
    }
  }, activeStage ? activeStage.label : 'Complete', /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--text-dim)'
    }
  }, "\u2026")), /*#__PURE__*/React.createElement("span", {
    style: {
      font: 'var(--fw-semibold) var(--fs-sm)/1 var(--font-mono)',
      fontVariantNumeric: 'tabular-nums',
      color: 'var(--red-400)'
    }
  }, String(Math.round(progress)).padStart(2, '0'), "%")), /*#__PURE__*/React.createElement("div", {
    className: "vip-ploader__rail",
    style: {
      display: 'flex',
      alignItems: 'center'
    }
  }, stages.map((s, i) => {
    const state = i < active ? 'done' : i === active ? 'active' : 'pending';
    return /*#__PURE__*/React.createElement(React.Fragment, {
      key: s.id
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 6,
        flex: 'none',
        width: 18
      }
    }, /*#__PURE__*/React.createElement("span", {
      className: `vip-ploader__node vip-ploader__node--${state}`,
      style: {
        width: 11,
        height: 11,
        borderRadius: '50%',
        flex: 'none',
        border: '2px solid',
        borderColor: state === 'pending' ? 'var(--border-strong)' : 'var(--red-600)',
        background: state === 'done' ? 'var(--red-600)' : state === 'active' ? 'var(--red-wash)' : 'transparent',
        boxShadow: state === 'active' ? '0 0 0 4px var(--red-wash)' : 'none',
        animation: state === 'active' ? 'vip-node-pulse 1.1s ease-in-out infinite' : 'none'
      }
    })), i < stages.length - 1 && /*#__PURE__*/React.createElement("span", {
      style: {
        flex: 1,
        height: 2,
        margin: '0 4px',
        borderRadius: 1,
        background: i < active ? 'var(--red-600)' : 'var(--border-strong)',
        transition: 'background var(--dur-base) var(--ease-out)'
      }
    }));
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      marginTop: 'var(--sp-4)'
    }
  }, stages.map((s, i) => /*#__PURE__*/React.createElement("span", {
    key: s.id,
    style: {
      font: 'var(--fw-bold) var(--fs-3xs)/1 var(--font-mono)',
      letterSpacing: 'var(--ls-wide)',
      textTransform: 'uppercase',
      color: i === active ? 'var(--red-400)' : i < active ? 'var(--text-2)' : 'var(--text-ghost)',
      transition: 'color var(--dur-base) var(--ease-out)'
    }
  }, s.label))));
}
Object.assign(__ds_scope, { ProcessLoader });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/audio/ProcessLoader.jsx", error: String((e && e.message) || e) }); }

// components/audio/Spectrogram.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * Spectrogram — canvas FFT heatmap using the forensic magnitude ramp
 * (void → red → amber → bone). Deterministic procedural energy field.
 */
function Spectrogram({
  seed = 3,
  cols = 220,
  rows = 64,
  height = 150,
  className = '',
  style,
  ...rest
}) {
  const canvasRef = React.useRef(null);
  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    let s = seed * 4129 + 7901;
    const rnd = () => {
      s = (s * 9301 + 49297) % 233280;
      return s / 233280;
    };

    // magnitude ramp stops (forensic)
    const ramp = [[0.00, [11, 11, 16]], [0.30, [91, 20, 20]], [0.55, [220, 38, 38]], [0.78, [249, 115, 22]], [0.92, [253, 230, 138]], [1.00, [255, 247, 237]]];
    const colorAt = m => {
      m = Math.max(0, Math.min(1, m));
      for (let i = 1; i < ramp.length; i++) {
        if (m <= ramp[i][0]) {
          const [a0, c0] = ramp[i - 1],
            [a1, c1] = ramp[i];
          const f = (m - a0) / (a1 - a0);
          return `rgb(${c0.map((c, k) => Math.round(c + (c1[k] - c) * f)).join(',')})`;
        }
      }
      return 'rgb(255,247,237)';
    };
    const cw = w / cols;
    const ch = h / rows;
    // precompute per-column voice energy (formant bands move over time)
    for (let x = 0; x < cols; x++) {
      const t = x / cols;
      const voiced = Math.sin(t * Math.PI * 4) * 0.5 + 0.5 > 0.35 ? 1 : 0.15;
      const f0 = 0.12 + Math.sin(t * 7) * 0.03; // fundamental band
      const f1 = 0.30 + Math.sin(t * 5 + 1) * 0.05; // formant 1
      const f2 = 0.52 + Math.sin(t * 9 + 2) * 0.05; // formant 2
      for (let y = 0; y < rows; y++) {
        const fr = 1 - y / rows; // 0 bottom .. 1 top (low→high freq)
        const band = cx => Math.exp(-Math.pow((fr - cx) * 9, 2));
        let m = (band(f0) * 1.0 + band(f1) * 0.8 + band(f2) * 0.55) * voiced;
        m += (rnd() - 0.5) * 0.12; // broadband noise floor
        m *= 0.5 + fr * 0.2;
        ctx.fillStyle = colorAt(m);
        ctx.fillRect(x * cw, y * ch, cw + 0.5, ch + 0.5);
      }
    }
  }, [seed, cols, rows, height]);
  return /*#__PURE__*/React.createElement("div", _extends({
    className: className,
    style: {
      background: 'var(--canvas-bg)',
      borderRadius: 'var(--radius-md)',
      border: '1px solid var(--border)',
      overflow: 'hidden',
      ...style
    }
  }, rest), /*#__PURE__*/React.createElement("canvas", {
    ref: canvasRef,
    style: {
      display: 'block',
      width: '100%',
      height
    }
  }));
}
Object.assign(__ds_scope, { Spectrogram });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/audio/Spectrogram.jsx", error: String((e && e.message) || e) }); }

// components/audio/Waveform.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * Waveform — canvas-rendered audio waveform in the forensic well.
 * Deterministic procedural data (seedable) so it renders identically
 * without a real audio buffer. Optional playhead + selection region.
 */
function Waveform({
  seed = 7,
  bars = 160,
  color = 'var(--red-600)',
  height = 120,
  playhead = null,
  // 0..1 or null
  selection = null,
  // [start, end] in 0..1 or null
  grid = true,
  className = '',
  style,
  ...rest
}) {
  const canvasRef = React.useRef(null);
  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // resolve CSS vars to concrete colors
    const cs = getComputedStyle(canvas);
    const resolve = c => {
      if (!c.startsWith('var(')) return c;
      const name = c.slice(4, -1).trim();
      return cs.getPropertyValue(name).trim() || '#dc2626';
    };
    const accent = resolve(color);

    // engineering grid
    if (grid) {
      ctx.strokeStyle = 'rgba(220,38,38,0.06)';
      ctx.lineWidth = 1;
      for (let gx = 0; gx <= w; gx += 32) {
        ctx.beginPath();
        ctx.moveTo(gx, 0);
        ctx.lineTo(gx, h);
        ctx.stroke();
      }
      ctx.strokeStyle = 'rgba(255,255,255,0.04)';
      ctx.beginPath();
      ctx.moveTo(0, h / 2);
      ctx.lineTo(w, h / 2);
      ctx.stroke();
    }

    // pseudo-random but deterministic
    let s = seed * 9301 + 49297;
    const rnd = () => {
      s = (s * 9301 + 49297) % 233280;
      return s / 233280;
    };
    const mid = h / 2;
    const gap = 2;
    const bw = Math.max(1.2, (w - bars * gap) / bars);
    const sel = selection;
    for (let i = 0; i < bars; i++) {
      const t = i / bars;
      // layered sine envelope + noise → speech-like amplitude
      const env = Math.abs(Math.sin(t * Math.PI * 3.1) * 0.5 + Math.sin(t * Math.PI * 11) * 0.25 + (rnd() - 0.5) * 0.6);
      const amp = Math.pow(env, 1.4) * (mid - 6) * (0.35 + rnd() * 0.65);
      const x = i * (bw + gap) + 1;
      const inSel = sel && t >= sel[0] && t <= sel[1];
      const past = playhead != null && t <= playhead;
      ctx.fillStyle = inSel ? accent : past ? accent : 'rgba(120,120,150,0.5)';
      ctx.globalAlpha = inSel ? 0.95 : past ? 0.85 : 0.55;
      const a = Math.max(1.5, amp);
      ctx.fillRect(x, mid - a, bw, a * 2);
    }
    ctx.globalAlpha = 1;

    // selection overlay edges
    if (sel) {
      ctx.fillStyle = 'rgba(220,38,38,0.07)';
      ctx.fillRect(sel[0] * w, 0, (sel[1] - sel[0]) * w, h);
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1;
      [sel[0], sel[1]].forEach(p => {
        ctx.beginPath();
        ctx.moveTo(p * w, 0);
        ctx.lineTo(p * w, h);
        ctx.stroke();
      });
    }

    // playhead
    if (playhead != null) {
      const px = playhead * w;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, h);
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.moveTo(px - 4, 0);
      ctx.lineTo(px + 4, 0);
      ctx.lineTo(px, 6);
      ctx.closePath();
      ctx.fill();
    }
  }, [seed, bars, color, playhead, selection, grid, height]);
  return /*#__PURE__*/React.createElement("div", _extends({
    className: ['vip-card--well', className].filter(Boolean).join(' '),
    style: {
      background: 'var(--canvas-bg)',
      borderRadius: 'var(--radius-md)',
      border: '1px solid var(--border)',
      overflow: 'hidden',
      ...style
    }
  }, rest), /*#__PURE__*/React.createElement("canvas", {
    ref: canvasRef,
    style: {
      display: 'block',
      width: '100%',
      height
    }
  }));
}
Object.assign(__ds_scope, { Waveform });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/audio/Waveform.jsx", error: String((e && e.message) || e) }); }

// components/core/Badge.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Badge — compact mono label for status, format, and metadata tags. */
function Badge({
  variant = 'default',
  dot = false,
  children,
  className = '',
  ...rest
}) {
  const cls = ['vip-badge', variant !== 'default' && `vip-badge--${variant}`, className].filter(Boolean).join(' ');
  return /*#__PURE__*/React.createElement("span", _extends({
    className: cls
  }, rest), dot && /*#__PURE__*/React.createElement("span", {
    className: "vip-badge__dot"
  }), children);
}
Object.assign(__ds_scope, { Badge });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Badge.jsx", error: String((e && e.message) || e) }); }

// components/core/Button.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * Button — the primary action control. Red signal for primary,
 * graphite outline for secondary, ghost for inline, danger for destructive.
 */
function Button({
  variant = 'outline',
  size = 'md',
  block = false,
  recording = false,
  icon = null,
  disabled = false,
  children,
  className = '',
  ...rest
}) {
  const cls = ['vip-btn', `vip-btn--${variant}`, size === 'sm' && 'vip-btn--sm', size === 'lg' && 'vip-btn--lg', block && 'vip-btn--block', recording && 'vip-btn--rec', className].filter(Boolean).join(' ');
  return /*#__PURE__*/React.createElement("button", _extends({
    className: cls,
    disabled: disabled
  }, rest), icon, children);
}
Object.assign(__ds_scope, { Button });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Button.jsx", error: String((e && e.message) || e) }); }

// components/core/Card.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Card — graphite panel container. Optional header with kicker + title. */
function Card({
  title,
  kicker,
  actions,
  hover = false,
  flush = false,
  well = false,
  children,
  className = '',
  ...rest
}) {
  const cls = ['vip-card', hover && 'vip-card--hover', flush && 'vip-card--flush', well && 'vip-card--well', className].filter(Boolean).join(' ');
  const hasHead = title || kicker || actions;
  return /*#__PURE__*/React.createElement("div", _extends({
    className: cls
  }, rest), hasHead && /*#__PURE__*/React.createElement("div", {
    className: "vip-card__head",
    style: flush ? {
      padding: 'var(--sp-7) var(--sp-7) 0'
    } : undefined
  }, /*#__PURE__*/React.createElement("div", null, kicker && /*#__PURE__*/React.createElement("p", {
    className: "vip-card__kicker"
  }, kicker), title && /*#__PURE__*/React.createElement("h3", {
    className: "vip-card__title"
  }, title)), actions && /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 'var(--sp-3)'
    }
  }, actions)), children);
}
Object.assign(__ds_scope, { Card });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Card.jsx", error: String((e && e.message) || e) }); }

// components/core/IconButton.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** IconButton — square, icon-only control for toolbars and panel headers. */
function IconButton({
  size = 'md',
  active = false,
  disabled = false,
  label,
  children,
  className = '',
  ...rest
}) {
  const cls = ['vip-iconbtn', size === 'sm' && 'vip-iconbtn--sm', size === 'lg' && 'vip-iconbtn--lg', active && 'vip-iconbtn--active', className].filter(Boolean).join(' ');
  return /*#__PURE__*/React.createElement("button", _extends({
    className: cls,
    disabled: disabled,
    "aria-label": label,
    title: label
  }, rest), children);
}
Object.assign(__ds_scope, { IconButton });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/IconButton.jsx", error: String((e && e.message) || e) }); }

// components/core/Input.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Input — text/number field with optional label and hint. */
function Input({
  label,
  hint,
  mono = false,
  className = '',
  id,
  ...rest
}) {
  const inputCls = ['vip-input', mono && 'vip-input--mono', className].filter(Boolean).join(' ');
  const input = /*#__PURE__*/React.createElement("input", _extends({
    id: id,
    className: inputCls
  }, rest));
  if (!label && !hint) return input;
  return /*#__PURE__*/React.createElement("label", {
    className: "vip-field",
    htmlFor: id
  }, label && /*#__PURE__*/React.createElement("span", {
    className: "vip-field__label"
  }, label), input, hint && /*#__PURE__*/React.createElement("span", {
    className: "vip-field__hint"
  }, hint));
}
Object.assign(__ds_scope, { Input });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Input.jsx", error: String((e && e.message) || e) }); }

// components/core/Select.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Select — styled native dropdown with optional label. */
function Select({
  label,
  hint,
  options = [],
  children,
  className = '',
  id,
  ...rest
}) {
  const selectCls = ['vip-select', className].filter(Boolean).join(' ');
  const select = /*#__PURE__*/React.createElement("select", _extends({
    id: id,
    className: selectCls
  }, rest), options.map(o => {
    const value = typeof o === 'string' ? o : o.value;
    const text = typeof o === 'string' ? o : o.label;
    return /*#__PURE__*/React.createElement("option", {
      key: value,
      value: value
    }, text);
  }), children);
  if (!label && !hint) return select;
  return /*#__PURE__*/React.createElement("label", {
    className: "vip-field",
    htmlFor: id
  }, label && /*#__PURE__*/React.createElement("span", {
    className: "vip-field__label"
  }, label), select, hint && /*#__PURE__*/React.createElement("span", {
    className: "vip-field__hint"
  }, hint));
}
Object.assign(__ds_scope, { Select });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Select.jsx", error: String((e && e.message) || e) }); }

// components/core/StatusPill.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** StatusPill — engine / process state indicator with a glowing dot. */
function StatusPill({
  state = 'pending',
  children,
  className = '',
  ...rest
}) {
  const cls = ['vip-pill', className].filter(Boolean).join(' ');
  return /*#__PURE__*/React.createElement("span", _extends({
    className: cls,
    "data-state": state
  }, rest), children);
}
Object.assign(__ds_scope, { StatusPill });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/StatusPill.jsx", error: String((e && e.message) || e) }); }

// components/core/Switch.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Switch — on/off toggle with optional label. Controlled via `checked`. */
function Switch({
  checked = false,
  onChange,
  label,
  disabled = false,
  className = '',
  ...rest
}) {
  const cls = ['vip-switch', checked && 'vip-switch--on', disabled && 'vip-switch--disabled', className].filter(Boolean).join(' ');
  const toggle = () => {
    if (!disabled && onChange) onChange(!checked);
  };
  return /*#__PURE__*/React.createElement("button", _extends({
    type: "button",
    role: "switch",
    "aria-checked": checked,
    className: cls,
    onClick: toggle,
    disabled: disabled
  }, rest), /*#__PURE__*/React.createElement("span", {
    className: "vip-switch__track"
  }, /*#__PURE__*/React.createElement("span", {
    className: "vip-switch__thumb"
  })), label && /*#__PURE__*/React.createElement("span", {
    className: "vip-switch__label"
  }, label));
}
Object.assign(__ds_scope, { Switch });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Switch.jsx", error: String((e && e.message) || e) }); }

// ui_kits/engineer/ControlRail.jsx
try { (() => {
// Engineer Mode — control rail (right panel: model + sliders + stems).
function ControlRail({
  params,
  onParam
}) {
  const {
    Card,
    Badge,
    Switch,
    Select,
    Button,
    ParamSlider
  } = window.VoiceIsolateProDesignSystem_38f745;
  const {
    Shield,
    Cpu
  } = window.Icons;
  const [bypassNoise, setBypassNoise] = React.useState(false);
  const [bypassDereverb, setBypassDereverb] = React.useState(false);
  return /*#__PURE__*/React.createElement("aside", {
    className: "em-rail"
  }, /*#__PURE__*/React.createElement("div", {
    className: "em-rail__section"
  }, /*#__PURE__*/React.createElement("div", {
    className: "em-panelhead"
  }, /*#__PURE__*/React.createElement("span", {
    className: "em-panelhead__title"
  }, /*#__PURE__*/React.createElement(Cpu, {
    size: 13,
    style: {
      color: 'var(--red-500)',
      marginRight: 6
    }
  }), "Model"), /*#__PURE__*/React.createElement(Badge, {
    variant: "accent"
  }, "v3.2")), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '10px 12px'
    }
  }, /*#__PURE__*/React.createElement(Select, {
    options: [{
      value: 'std',
      label: 'Standard (Fast)'
    }, {
      value: 'fwd',
      label: 'Forensic (Accurate)'
    }, {
      value: 'ult',
      label: 'Ultra (Max Quality)'
    }],
    defaultValue: "fwd"
  }), /*#__PURE__*/React.createElement("div", {
    className: "em-model-stat vip-mono",
    style: {
      marginTop: 10,
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "em-mstat"
  }, /*#__PURE__*/React.createElement("div", {
    className: "em-mstat__k"
  }, "CPU"), /*#__PURE__*/React.createElement("div", {
    className: "em-mstat__v"
  }, "12%")), /*#__PURE__*/React.createElement("div", {
    className: "em-mstat"
  }, /*#__PURE__*/React.createElement("div", {
    className: "em-mstat__k"
  }, "RAM"), /*#__PURE__*/React.createElement("div", {
    className: "em-mstat__v"
  }, "1.2 GB"))))), /*#__PURE__*/React.createElement("div", {
    className: "em-rail__section"
  }, /*#__PURE__*/React.createElement("div", {
    className: "em-panelhead"
  }, /*#__PURE__*/React.createElement("span", {
    className: "em-panelhead__title"
  }, "Noise Reduction"), /*#__PURE__*/React.createElement(Switch, {
    checked: !bypassNoise,
    onChange: v => setBypassNoise(!v)
  })), /*#__PURE__*/React.createElement("div", {
    className: "em-sliders"
  }, /*#__PURE__*/React.createElement(ParamSlider, {
    label: "Reduction",
    value: params.nr,
    onChange: v => onParam('nr', v),
    unit: "%"
  }), /*#__PURE__*/React.createElement(ParamSlider, {
    label: "Voice Gate",
    value: params.gate,
    onChange: v => onParam('gate', v),
    min: -80,
    max: 0,
    unit: " dB"
  }), /*#__PURE__*/React.createElement(ParamSlider, {
    label: "Noise Floor",
    value: params.floor,
    onChange: v => onParam('floor', v),
    min: -80,
    max: 0,
    unit: " dB"
  }), /*#__PURE__*/React.createElement(ParamSlider, {
    label: "Smooth",
    value: params.smooth,
    onChange: v => onParam('smooth', v),
    unit: "%"
  }))), /*#__PURE__*/React.createElement("div", {
    className: "em-rail__section"
  }, /*#__PURE__*/React.createElement("div", {
    className: "em-panelhead"
  }, /*#__PURE__*/React.createElement("span", {
    className: "em-panelhead__title"
  }, "De-reverb"), /*#__PURE__*/React.createElement(Switch, {
    checked: !bypassDereverb,
    onChange: v => setBypassDereverb(!v)
  })), /*#__PURE__*/React.createElement("div", {
    className: "em-sliders"
  }, /*#__PURE__*/React.createElement(ParamSlider, {
    label: "Room Size",
    value: params.room,
    onChange: v => onParam('room', v),
    unit: "%"
  }), /*#__PURE__*/React.createElement(ParamSlider, {
    label: "Tail Length",
    value: params.tail,
    onChange: v => onParam('tail', v),
    min: 0,
    max: 800,
    unit: " ms"
  }))), /*#__PURE__*/React.createElement("div", {
    className: "em-rail__section"
  }, /*#__PURE__*/React.createElement("div", {
    className: "em-panelhead"
  }, /*#__PURE__*/React.createElement("span", {
    className: "em-panelhead__title"
  }, "Output")), /*#__PURE__*/React.createElement("div", {
    className: "em-sliders"
  }, /*#__PURE__*/React.createElement(ParamSlider, {
    label: "Voice Gain",
    value: params.voiceGain,
    onChange: v => onParam('voiceGain', v),
    min: -24,
    max: 24,
    unit: " dB"
  }), /*#__PURE__*/React.createElement(ParamSlider, {
    label: "HP Filter",
    value: params.hp,
    onChange: v => onParam('hp', v),
    min: 20,
    max: 600,
    unit: " Hz"
  }), /*#__PURE__*/React.createElement(ParamSlider, {
    label: "LP Filter",
    value: params.lp,
    onChange: v => onParam('lp', v),
    min: 4000,
    max: 20000,
    unit: " Hz"
  }))), /*#__PURE__*/React.createElement("div", {
    className: "em-rail__footer"
  }, /*#__PURE__*/React.createElement(Select, {
    options: ['WAV 24-bit / 48kHz', 'WAV 32-bit float', 'FLAC', 'MP3 320kbps'],
    style: {
      marginBottom: 10
    }
  }), /*#__PURE__*/React.createElement(Button, {
    variant: "primary",
    block: true
  }, "Export Voice Stem"), /*#__PURE__*/React.createElement(Button, {
    variant: "outline",
    block: true,
    style: {
      marginTop: 8
    }
  }, "Export Noise Stem")));
}
window.ControlRail = ControlRail;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/engineer/ControlRail.jsx", error: String((e && e.message) || e) }); }

// ui_kits/engineer/Icons.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
// VoiceIsolate Pro — shared inline icons (thin 2px stroke, lucide-style).
// Exported to window for the UI-kit babel scripts.
function VipIcon({
  d,
  fill,
  size = 18,
  ...p
}) {
  return /*#__PURE__*/React.createElement("svg", _extends({
    viewBox: "0 0 24 24",
    width: size,
    height: size,
    fill: fill ? 'currentColor' : 'none',
    stroke: fill ? 'none' : 'currentColor',
    strokeWidth: "2",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }, p), d);
}
const Icons = {
  Mic: p => /*#__PURE__*/React.createElement(VipIcon, _extends({}, p, {
    d: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("rect", {
      x: "9",
      y: "2",
      width: "6",
      height: "12",
      rx: "3"
    }), /*#__PURE__*/React.createElement("path", {
      d: "M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8"
    }))
  })),
  Play: p => /*#__PURE__*/React.createElement(VipIcon, _extends({}, p, {
    fill: true,
    d: /*#__PURE__*/React.createElement("path", {
      d: "M7 4v16l13-8z"
    })
  })),
  Pause: p => /*#__PURE__*/React.createElement(VipIcon, _extends({}, p, {
    fill: true,
    d: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("rect", {
      x: "6",
      y: "4",
      width: "4",
      height: "16",
      rx: "1"
    }), /*#__PURE__*/React.createElement("rect", {
      x: "14",
      y: "4",
      width: "4",
      height: "16",
      rx: "1"
    }))
  })),
  Stop: p => /*#__PURE__*/React.createElement(VipIcon, _extends({}, p, {
    fill: true,
    d: /*#__PURE__*/React.createElement("rect", {
      x: "5",
      y: "5",
      width: "14",
      height: "14",
      rx: "2"
    })
  })),
  SkipBack: p => /*#__PURE__*/React.createElement(VipIcon, _extends({}, p, {
    fill: true,
    d: /*#__PURE__*/React.createElement("path", {
      d: "M18 5v14l-9-7zM7 5v14H5V5z"
    })
  })),
  SkipFwd: p => /*#__PURE__*/React.createElement(VipIcon, _extends({}, p, {
    fill: true,
    d: /*#__PURE__*/React.createElement("path", {
      d: "M6 5v14l9-7zM17 5v14h2V5z"
    })
  })),
  Upload: p => /*#__PURE__*/React.createElement(VipIcon, _extends({}, p, {
    d: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
      d: "M12 16V4M7 9l5-5 5 5"
    }), /*#__PURE__*/React.createElement("path", {
      d: "M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"
    }))
  })),
  Download: p => /*#__PURE__*/React.createElement(VipIcon, _extends({}, p, {
    d: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
      d: "M12 4v12M7 11l5 5 5-5"
    }), /*#__PURE__*/React.createElement("path", {
      d: "M4 20h16"
    }))
  })),
  Scissors: p => /*#__PURE__*/React.createElement(VipIcon, _extends({}, p, {
    d: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("circle", {
      cx: "6",
      cy: "6",
      r: "3"
    }), /*#__PURE__*/React.createElement("circle", {
      cx: "6",
      cy: "18",
      r: "3"
    }), /*#__PURE__*/React.createElement("path", {
      d: "M20 4 8.5 15.5M14.5 14.5 20 20M8.5 8.5 12 12"
    }))
  })),
  Layers: p => /*#__PURE__*/React.createElement(VipIcon, _extends({}, p, {
    d: /*#__PURE__*/React.createElement("path", {
      d: "M12 2 2 7l10 5 10-5zM2 17l10 5 10-5M2 12l10 5 10-5"
    })
  })),
  Gear: p => /*#__PURE__*/React.createElement(VipIcon, _extends({}, p, {
    d: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("circle", {
      cx: "12",
      cy: "12",
      r: "3"
    }), /*#__PURE__*/React.createElement("path", {
      d: "M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1"
    }))
  })),
  Shield: p => /*#__PURE__*/React.createElement(VipIcon, _extends({}, p, {
    d: /*#__PURE__*/React.createElement("path", {
      d: "M12 2 4 5v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V5z"
    })
  })),
  Lock: p => /*#__PURE__*/React.createElement(VipIcon, _extends({}, p, {
    d: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("rect", {
      x: "4",
      y: "11",
      width: "16",
      height: "10",
      rx: "2"
    }), /*#__PURE__*/React.createElement("path", {
      d: "M8 11V7a4 4 0 0 1 8 0v4"
    }))
  })),
  Cpu: p => /*#__PURE__*/React.createElement(VipIcon, _extends({}, p, {
    d: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("rect", {
      x: "6",
      y: "6",
      width: "12",
      height: "12",
      rx: "1"
    }), /*#__PURE__*/React.createElement("path", {
      d: "M9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3"
    }))
  })),
  Zap: p => /*#__PURE__*/React.createElement(VipIcon, _extends({}, p, {
    d: /*#__PURE__*/React.createElement("path", {
      d: "M13 2 4 14h7l-1 8 10-12h-7z"
    })
  })),
  Wave: p => /*#__PURE__*/React.createElement(VipIcon, _extends({}, p, {
    d: /*#__PURE__*/React.createElement("path", {
      d: "M2 12h2M6 8v8M10 4v16M14 7v10M18 9v6M22 12h0"
    })
  })),
  Folder: p => /*#__PURE__*/React.createElement(VipIcon, _extends({}, p, {
    d: /*#__PURE__*/React.createElement("path", {
      d: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"
    })
  })),
  Check: p => /*#__PURE__*/React.createElement(VipIcon, _extends({}, p, {
    d: /*#__PURE__*/React.createElement("path", {
      d: "M20 6 9 17l-5-5"
    })
  })),
  Chevron: p => /*#__PURE__*/React.createElement(VipIcon, _extends({}, p, {
    d: /*#__PURE__*/React.createElement("path", {
      d: "m9 18 6-6-6-6"
    })
  })),
  Sliders: p => /*#__PURE__*/React.createElement(VipIcon, _extends({}, p, {
    d: /*#__PURE__*/React.createElement("path", {
      d: "M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"
    })
  })),
  Volume: p => /*#__PURE__*/React.createElement(VipIcon, _extends({}, p, {
    d: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
      d: "M11 5 6 9H2v6h4l5 4z"
    }), /*#__PURE__*/React.createElement("path", {
      d: "M19 5a9 9 0 0 1 0 14M16 8a5 5 0 0 1 0 8"
    }))
  })),
  Headphones: p => /*#__PURE__*/React.createElement(VipIcon, _extends({}, p, {
    d: /*#__PURE__*/React.createElement("path", {
      d: "M3 14v-2a9 9 0 0 1 18 0v2M3 14a2 2 0 0 1 2 2v2a2 2 0 0 1-4 0v-2a2 2 0 0 1 2-2M21 14a2 2 0 0 0-2 2v2a2 2 0 0 0 4 0v-2a2 2 0 0 0-2-2"
    })
  })),
  Waveform2: p => /*#__PURE__*/React.createElement(VipIcon, _extends({}, p, {
    d: /*#__PURE__*/React.createElement("path", {
      d: "M2 10v4M6 6v12M10 9v6M14 3v18M18 7v10M22 10v4"
    })
  }))
};
if (typeof window !== 'undefined') window.Icons = Icons;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/engineer/Icons.jsx", error: String((e && e.message) || e) }); }

// ui_kits/engineer/StemPanel.jsx
try { (() => {
// Engineer Mode — stem panel (voice / noise comparison strips).
function StemPanel({
  playing
}) {
  const {
    LevelMeter,
    Badge,
    IconButton,
    Switch
  } = window.VoiceIsolateProDesignSystem_38f745;
  const {
    Play,
    Volume,
    Scissors
  } = window.Icons;
  const stems = [{
    id: 'voice',
    label: 'Voice',
    color: 'var(--stem-voice)',
    l: playing ? 72 : 5,
    r: playing ? 63 : 4,
    lp: 88,
    rp: 81,
    badge: {
      v: 'accent',
      t: 'WAV'
    }
  }, {
    id: 'noise',
    label: 'Removed Noise',
    color: 'var(--stem-noise)',
    l: playing ? 34 : 2,
    r: playing ? 30 : 2,
    lp: 55,
    rp: 52,
    badge: {
      v: 'default',
      t: 'WAV'
    }
  }];
  const [muted, setMuted] = React.useState({
    voice: false,
    noise: false
  });
  return /*#__PURE__*/React.createElement("div", {
    className: "em-stems"
  }, stems.map(s => /*#__PURE__*/React.createElement("div", {
    key: s.id,
    className: "em-stem"
  }, /*#__PURE__*/React.createElement("div", {
    className: "em-stem__head"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "em-stem__dot",
    style: {
      background: s.color
    }
  }), /*#__PURE__*/React.createElement("span", {
    className: "em-stem__name"
  }, s.label), /*#__PURE__*/React.createElement(Badge, {
    variant: s.badge.v
  }, s.badge.t, " \xB7 48kHz")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 6,
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement(IconButton, {
    label: "Solo",
    size: "sm"
  }, /*#__PURE__*/React.createElement(Volume, {
    size: 13
  })), /*#__PURE__*/React.createElement(Switch, {
    checked: !muted[s.id],
    onChange: v => setMuted(p => ({
      ...p,
      [s.id]: !v
    }))
  }))), /*#__PURE__*/React.createElement("div", {
    className: "em-stem__meters"
  }, /*#__PURE__*/React.createElement(LevelMeter, {
    label: "L",
    value: muted[s.id] ? 0 : s.l,
    peak: muted[s.id] ? 0 : s.lp
  }), /*#__PURE__*/React.createElement(LevelMeter, {
    label: "R",
    value: muted[s.id] ? 0 : s.r,
    peak: muted[s.id] ? 0 : s.rp
  })))));
}
window.StemPanel = StemPanel;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/engineer/StemPanel.jsx", error: String((e && e.message) || e) }); }

// ui_kits/engineer/TitleBar.jsx
try { (() => {
// Engineer Mode — title bar (app chrome). Reads window.Icons + DS components.
function TitleBar({
  onExport,
  processed
}) {
  const {
    Badge,
    StatusPill,
    IconButton
  } = window.VoiceIsolateProDesignSystem_38f745;
  const {
    Gear,
    Headphones
  } = window.Icons;
  return /*#__PURE__*/React.createElement("header", {
    className: "em-titlebar"
  }, /*#__PURE__*/React.createElement("div", {
    className: "em-brand"
  }, /*#__PURE__*/React.createElement("svg", {
    className: "em-mark",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "#ef4444",
    strokeWidth: "2.5",
    strokeLinecap: "round"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M12 1v22M8 5v14M4 9v6M16 5v14M20 9v6"
  })), /*#__PURE__*/React.createElement("div", {
    className: "em-brand__txt"
  }, /*#__PURE__*/React.createElement("span", {
    className: "em-brand__name"
  }, "VoiceIsolate"), /*#__PURE__*/React.createElement("span", {
    className: "em-brand__pro"
  }, "PRO")), /*#__PURE__*/React.createElement("span", {
    className: "em-brand__div"
  }), /*#__PURE__*/React.createElement("span", {
    className: "em-brand__mode"
  }, "Engineer Mode")), /*#__PURE__*/React.createElement("div", {
    className: "em-titlebar__center"
  }, /*#__PURE__*/React.createElement("span", {
    className: "vip-badge"
  }, /*#__PURE__*/React.createElement("span", {
    className: "vip-badge__dot",
    style: {
      color: 'var(--ok)'
    }
  }), "session_04.wav"), /*#__PURE__*/React.createElement("span", {
    className: "em-meta vip-mono"
  }, "48kHz \xB7 24-bit \xB7 stereo \xB7 04:12")), /*#__PURE__*/React.createElement("div", {
    className: "em-titlebar__right"
  }, /*#__PURE__*/React.createElement(StatusPill, {
    state: "ready"
  }, "Engine Ready"), /*#__PURE__*/React.createElement("span", {
    className: "vip-pill",
    "data-state": "ready",
    title: "All processing is local",
    style: {
      color: 'var(--ok)'
    }
  }, "Local \xB7 No Upload"), /*#__PURE__*/React.createElement(IconButton, {
    label: "Monitor"
  }, /*#__PURE__*/React.createElement(Headphones, {
    size: 16
  })), /*#__PURE__*/React.createElement(IconButton, {
    label: "Settings"
  }, /*#__PURE__*/React.createElement(Gear, {
    size: 16
  }))));
}
window.TitleBar = TitleBar;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/engineer/TitleBar.jsx", error: String((e && e.message) || e) }); }

// ui_kits/engineer/Transport.jsx
try { (() => {
// Engineer Mode — transport bar (play controls + timecode + meters).
function Transport({
  playing,
  onToggle,
  time = '00:01:54',
  total = '00:04:12',
  pct = 46
}) {
  const {
    IconButton,
    LevelMeter
  } = window.VoiceIsolateProDesignSystem_38f745;
  const {
    Play,
    Pause,
    Stop,
    SkipBack,
    SkipFwd
  } = window.Icons;
  return /*#__PURE__*/React.createElement("div", {
    className: "em-transport"
  }, /*#__PURE__*/React.createElement("div", {
    className: "em-transport__controls"
  }, /*#__PURE__*/React.createElement(IconButton, {
    label: "Restart"
  }, /*#__PURE__*/React.createElement(SkipBack, {
    size: 15
  })), /*#__PURE__*/React.createElement("button", {
    className: "em-playbtn",
    onClick: onToggle,
    "aria-label": playing ? 'Pause' : 'Play'
  }, playing ? /*#__PURE__*/React.createElement(Pause, {
    size: 20
  }) : /*#__PURE__*/React.createElement(Play, {
    size: 20
  })), /*#__PURE__*/React.createElement(IconButton, {
    label: "Stop"
  }, /*#__PURE__*/React.createElement(Stop, {
    size: 14
  })), /*#__PURE__*/React.createElement(IconButton, {
    label: "Skip"
  }, /*#__PURE__*/React.createElement(SkipFwd, {
    size: 15
  }))), /*#__PURE__*/React.createElement("div", {
    className: "em-transport__time vip-mono"
  }, /*#__PURE__*/React.createElement("span", {
    className: "em-time-now"
  }, time), /*#__PURE__*/React.createElement("span", {
    className: "em-time-sep"
  }, "/"), /*#__PURE__*/React.createElement("span", {
    className: "em-time-total"
  }, total)), /*#__PURE__*/React.createElement("div", {
    className: "em-transport__meters"
  }, /*#__PURE__*/React.createElement(LevelMeter, {
    label: "L",
    value: playing ? 68 : 4,
    peak: 84
  }), /*#__PURE__*/React.createElement(LevelMeter, {
    label: "R",
    value: playing ? 61 : 3,
    peak: 79
  })));
}
window.Transport = Transport;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/engineer/Transport.jsx", error: String((e && e.message) || e) }); }

__ds_ns.LevelMeter = __ds_scope.LevelMeter;

__ds_ns.ParamSlider = __ds_scope.ParamSlider;

__ds_ns.ProcessLoader = __ds_scope.ProcessLoader;

__ds_ns.Spectrogram = __ds_scope.Spectrogram;

__ds_ns.Waveform = __ds_scope.Waveform;

__ds_ns.Badge = __ds_scope.Badge;

__ds_ns.Button = __ds_scope.Button;

__ds_ns.Card = __ds_scope.Card;

__ds_ns.IconButton = __ds_scope.IconButton;

__ds_ns.Input = __ds_scope.Input;

__ds_ns.Select = __ds_scope.Select;

__ds_ns.StatusPill = __ds_scope.StatusPill;

__ds_ns.Switch = __ds_scope.Switch;

})();
