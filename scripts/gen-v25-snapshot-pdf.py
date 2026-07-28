#!/usr/bin/env python3
"""Generate docs/releases/VoiceIsolate_Pro_v25_Current_State.pdf"""
from pathlib import Path
from datetime import date
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.lib import colors
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
    PageBreak, ListFlowable, ListItem, HRFlowable,
)

ROOT = Path(__file__).resolve().parents[1]
out = ROOT / "docs" / "releases" / "VoiceIsolate_Pro_v25_Current_State.pdf"
out.parent.mkdir(parents=True, exist_ok=True)

styles = getSampleStyleSheet()
styles.add(ParagraphStyle(
    name="CoverTitle", parent=styles["Title"], fontSize=22, spaceAfter=8,
    textColor=colors.HexColor("#0f172a"),
))
styles.add(ParagraphStyle(
    name="CoverSub", parent=styles["Normal"], fontSize=12, alignment=1,
    textColor=colors.HexColor("#334155"), spaceAfter=6,
))
styles.add(ParagraphStyle(
    name="H1Vip", parent=styles["Heading1"], fontSize=16,
    textColor=colors.HexColor("#0e7490"), spaceBefore=14, spaceAfter=8,
))
styles.add(ParagraphStyle(
    name="H2Vip", parent=styles["Heading2"], fontSize=13,
    textColor=colors.HexColor("#155e75"), spaceBefore=10, spaceAfter=6,
))
styles.add(ParagraphStyle(
    name="BodyVip", parent=styles["Normal"], fontSize=10, leading=14,
    textColor=colors.HexColor("#1e293b"), spaceAfter=6,
))
styles.add(ParagraphStyle(
    name="SmallVip", parent=styles["Normal"], fontSize=9, leading=12,
    textColor=colors.HexColor("#475569"),
))
styles.add(ParagraphStyle(name="Cell", parent=styles["Normal"], fontSize=8.5, leading=11))
styles.add(ParagraphStyle(
    name="CellH", parent=styles["Normal"], fontSize=8.5, leading=11, textColor=colors.white,
))


def p(text, style="BodyVip"):
    return Paragraph(text, styles[style])


def bullet_list(items):
    return ListFlowable(
        [ListItem(Paragraph(i, styles["BodyVip"]), leftIndent=8, value="•") for i in items],
        bulletType="bullet", start="•", leftIndent=12, spaceBefore=2, spaceAfter=8,
    )


def table(rows, col_widths):
    data = []
    for r_i, row in enumerate(rows):
        st = styles["CellH"] if r_i == 0 else styles["Cell"]
        data.append([Paragraph(str(c), st) for c in row])
    t = Table(data, colWidths=col_widths, repeatRows=1)
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#0e7490")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#94a3b8")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [
            colors.HexColor("#f8fafc"), colors.HexColor("#eef2ff"),
        ]),
    ]))
    return t


story = []
story.append(Spacer(1, 1.2 * inch))
story.append(Paragraph("VoiceIsolate Pro", styles["CoverTitle"]))
story.append(Paragraph("v25.0.0 — Current State Product Snapshot", styles["CoverSub"]))
story.append(Paragraph(
    f"Generated {date.today().isoformat()} · 100% on-device voice isolation",
    styles["CoverSub"],
))
story.append(Spacer(1, 0.25 * inch))
story.append(HRFlowable(width="100%", thickness=1.5, color=colors.HexColor("#06b6d4")))
story.append(Spacer(1, 0.3 * inch))
story.append(p(
    "This document describes the product <b>as of v25.0.0</b>: architecture contracts, "
    "Engineer Mode slider discipline, platforms, versions, verification status, and "
    "contributor rules. Linked from the repository README and docs index."
))
story.append(Spacer(1, 0.2 * inch))
story.append(table(
    [
        ["Field", "Value"],
        ["Product version", "25.0.0"],
        ["Android versionName / versionCode", "25.0.0 / 250000"],
        ["iOS CFBundleShortVersionString / CFBundleVersion", "25.0.0 / 250000"],
        ["Electron artifact pattern", "VoiceIsolate-Pro-25.0.0-win-x64.exe"],
        ["Package manager", "pnpm ≥ 11 · Node ≥ 22"],
        ["Privacy", "100% local · no cloud audio"],
        ["Spectral contract", "Exactly one Forward STFT + one Inverse STFT"],
    ],
    [2.6 * inch, 4.0 * inch],
))

story.append(PageBreak())
story.append(p("1. Overview", "H1Vip"))
story.append(p(
    "VoiceIsolate Pro extracts studio-quality speech from noisy audio and video "
    "<b>entirely on-device</b>. Surfaces: Landing Stem-Split (/), Engineer Mode (/app/), "
    "and Downloads. Upload-only workflow — live microphone capture is intentionally disabled."
))
story.append(p("1.1 Workflow", "H2Vip"))
story.append(bullet_list([
    "<b>Upload</b> — accept File only (no PCM decode freeze).",
    "<b>Analyze</b> — decode, map speech/noise/music/whisper/impulse; joint Analyzer↔WhisperHunter map.",
    "<b>Process</b> — offline ML isolation (once per file) + single-pass spectral cleanup.",
    "<b>Live-Mix</b> — real-time gate/de-esser/EQ/comp via AudioWorklet; sliders never re-run ML.",
    "<b>Export</b> — WAV (and video re-mux where applicable), forensic audit log.",
]))
story.append(p("1.2 Hard constraints (non-negotiable)", "H2Vip"))
story.append(table(
    [
        ["Constraint", "Rule"],
        ["Privacy", "No user audio or derivatives leave the device."],
        ["Single STFT / iSTFT", "One forward + one inverse per offline spectral path."],
        ["No live mic", "getUserMedia forbidden; Permissions-Policy microphone=()."],
        ["Sliders ≠ re-inference", "UI controls GainNodes / AudioParams only after stems exist."],
        ["Models", "Same-origin /app/models/*.onnx or desktop seed — no CDN scripts."],
        ["Worklet ring buffer", "Do not change voice-isolate-processor.js pointer math without explicit task."],
    ],
    [1.8 * inch, 4.8 * inch],
))

story.append(p("2. Engineer Mode v25 — Slider discipline", "H1Vip"))
story.append(p(
    "v25 is a <b>hardening / polish</b> pass — not an architecture rewrite. "
    "Visible slider ranges stay as displayed; safer behavior lives in the "
    "<b>mapping / calibration</b> layer only."
))
story.append(p("2.1 Calibration curves", "H2Vip"))
story.append(bullet_list([
    "<b>voiceIso</b>: raw 0–72 ≈ linear (default 72 preserved). Above 72: cubic ease-out; UI 100 → effective ≈ 86.",
    "<b>bgSuppress</b>: linear to 60; upper range log-taper (max effective ≈ 88).",
    "<b>crosstalkCancel</b>: power-curve soft-start; further scaled by stereo channel-difference gate.",
    "API: pure calibrate(sliderId, rawValue) and getEffectiveDspParams(rawParams) in slider-calibration.js.",
]))
story.append(p("2.2 Coupling and soft clamps", "H2Vip"))
story.append(bullet_list([
    "High effective voiceIso can cap bgSuppress unless a speech-safe band (≈800–3400 Hz coverage) exists.",
    "Protected speech window: minimum band width enforced on effective edges only.",
    "Soft clamp de-risks extreme iso + suppress + narrow band (gargling / pumping risk).",
    "Dev logging: set globalThis.VIP_DEBUG_CALIBRATION = true.",
]))
story.append(p("2.3 Lock UI", "H2Vip"))
story.append(bullet_list([
    "Every slider row: SVG padlock, data-locked, cyan protected accent (not red, not disabled gray).",
    "toggleSliderLock(id); persist vip-slider-locks in localStorage.",
    "Locked: no drag, no preset overwrite, no reset unless full reset chosen; Reset Unlocked Only available.",
]))
story.append(p("2.4 Metrics, sections, overlay", "H2Vip"))
story.append(bullet_list([
    "Single updateAudioMetrics() for Voice %, Noise %, SNR dB (header + strip + neon pulse).",
    "Collapsible native details/summary for major UI sections.",
    "Processing overlay variants: uploading → decoding → analyzing → separating → isolating → reconstructing → exporting; always hidden in runPipeline finally.",
]))

story.append(PageBreak())
story.append(p("3. Platforms and version matrix", "H1Vip"))
story.append(table(
    [
        ["Surface", "Technology", "Version sync"],
        ["Web", "Vercel + Express local", "package.json 25.0.0"],
        ["Android", "Capacitor + Gradle", "versionName 25.0.0 · versionCode 250000"],
        ["Desktop", "Electron + electron-builder", "artifact VoiceIsolate-Pro-25.0.0-*"],
        ["iOS (secondary v1 scope)", "Capacitor plist", "25.0.0 / 250000 when built"],
    ],
    [1.6 * inch, 2.2 * inch, 2.8 * inch],
))
story.append(Spacer(1, 0.1 * inch))
story.append(p(
    "Run pnpm mobile:sync-version after any package.json version bump. "
    "GitHub Release binaries are published separately; until a v25 release is uploaded, "
    "latest may still resolve to prior v24 assets."
))

story.append(p("4. Architecture (summary)", "H1Vip"))
story.append(p(
    "Stem-Split and Live-Mix: Phase 1 offline ML inference once per file → stems; "
    "Phase 2 real-time Live-Mix graph (gains/filters only). "
    "New code in src/ four-layer ESM; Engineer shell remains under public/app/ "
    "in maintenance with explicit v25 polish in scoped files. "
    "Authoritative contributor contract: CLAUDE.md."
))

story.append(p("5. Key modules (v25 touch list)", "H1Vip"))
story.append(table(
    [
        ["Path", "Role"],
        ["public/app/slider-calibration.js", "Discipline curves, coupling, soft clamps"],
        ["public/app/slider-map.js", "Registry, STAGES, structured SLIDER_HINTS"],
        ["public/app/slider-hint-ui.js", "Hint panels + expandable metadata"],
        ["public/app/app.js", "Locks, metrics, effective params, pipeline wiring"],
        ["public/app/index.html", "Collapsibles, metric DOM, reset unlocked"],
        ["public/app/style.css", "Lock/collapsible/hint/overlay styling"],
        ["public/app/processing-overlay.js", "Stage variants + hide-on-finally patch"],
        ["tests/slider-calibration-hardening.test.js", "Curve / clamp / lock contract tests"],
    ],
    [2.8 * inch, 3.8 * inch],
))

story.append(p("6. Verification status", "H1Vip"))
story.append(bullet_list([
    "pnpm test: full Jest suite green after v25 hardening (2400+ tests).",
    "New unit coverage: calibration points (incl. 72 and 100), coupling clamp/non-clamp, soft clamp, lock persistence.",
    "pnpm test:live: Playwright smoke may still fail a pre-existing peak &gt; 1.001 assertion; not a v25 mapping regression.",
    "ESLint: class methods use document.querySelectorAll (not bindEvents-local qsa).",
]))

story.append(p("7. Spelling and UI copy checklist", "H1Vip"))
story.append(bullet_list([
    "Product name: <b>VoiceIsolate Pro</b> (one word VoiceIsolate, space Pro).",
    "Engineer Mode labels: Voice Isolation, BG Suppress, Voice Focus Lo/Hi, Crosstalk Cancel.",
    "Controls: Reset Controls · Reset Unlocked Only · Process · Reprocess · Forensic.",
    "Metrics labels: Voice % · Noise % · SNR Gain / SNR.",
    "Section summaries: Upload · Presets and Processing Controls · Processing Pipeline · Waveform and Spectrum · Noise Reduction / Gate · EQ · Dynamics · Spectral · Advanced · Output · Separation · EXTREME.",
    "Contributor doc spelling: CLAUDE.md (not CloudMD).",
]))

story.append(p("8. Commands", "H1Vip"))
story.append(p(
    "<font face='Courier' size='8'>"
    "pnpm install · pnpm dev · pnpm test · pnpm test:live · "
    "pnpm mobile:sync-version · pnpm android:build:win · "
    "pnpm build:electron · pnpm validate · pnpm worklets:verify"
    "</font>"
))
story.append(Spacer(1, 0.25 * inch))
story.append(HRFlowable(width="100%", thickness=1, color=colors.HexColor("#94a3b8")))
story.append(p(
    f"End of snapshot · VoiceIsolate Pro v25.0.0 · {date.today().isoformat()} · "
    "Repository: github.com/Joker5514/VoiceIsolate-Pro",
    "SmallVip",
))


def on_page(canvas, doc):
    canvas.saveState()
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(colors.HexColor("#64748b"))
    canvas.drawString(0.75 * inch, 0.5 * inch, "VoiceIsolate Pro v25.0.0 — Current State")
    canvas.drawRightString(letter[0] - 0.75 * inch, 0.5 * inch, f"Page {doc.page}")
    canvas.restoreState()


doc = SimpleDocTemplate(
    str(out),
    pagesize=letter,
    leftMargin=0.75 * inch,
    rightMargin=0.75 * inch,
    topMargin=0.7 * inch,
    bottomMargin=0.7 * inch,
    title="VoiceIsolate Pro v25.0.0 Current State",
    author="VoiceIsolate Pro",
)
doc.build(story, onFirstPage=on_page, onLaterPages=on_page)
print("Wrote", out, "bytes", out.stat().st_size)
