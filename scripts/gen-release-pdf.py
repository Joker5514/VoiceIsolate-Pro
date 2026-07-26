#!/usr/bin/env python3
"""Generate docs/releases/VoiceIsolate_Pro_v24_Latest.pdf"""
from pathlib import Path

from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.lib.colors import HexColor
from reportlab.platypus import (
    SimpleDocTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
    PageBreak,
    HRFlowable,
)
from reportlab.lib.enums import TA_CENTER

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "releases" / "VoiceIsolate_Pro_v24_Latest.pdf"

CYAN = HexColor("#0ea5e9")
DARK = HexColor("#0b1220")
MUTED = HexColor("#64748b")
INK = HexColor("#0f172a")


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)

    styles = getSampleStyleSheet()
    styles.add(
        ParagraphStyle(
            name="CoverTitle",
            parent=styles["Title"],
            fontSize=26,
            textColor=DARK,
            spaceAfter=8,
            alignment=TA_CENTER,
            leading=32,
        )
    )
    styles.add(
        ParagraphStyle(
            name="CoverSub",
            parent=styles["Normal"],
            fontSize=12,
            textColor=MUTED,
            alignment=TA_CENTER,
            spaceAfter=6,
            leading=16,
        )
    )
    styles.add(
        ParagraphStyle(
            name="H1VIP",
            parent=styles["Heading1"],
            fontSize=16,
            textColor=CYAN,
            spaceBefore=14,
            spaceAfter=8,
            leading=20,
        )
    )
    styles.add(
        ParagraphStyle(
            name="BodyVIP",
            parent=styles["Normal"],
            fontSize=10,
            textColor=INK,
            leading=14,
            spaceAfter=6,
        )
    )
    styles.add(
        ParagraphStyle(
            name="SmallVIP",
            parent=styles["Normal"],
            fontSize=8.5,
            textColor=MUTED,
            leading=11,
            spaceAfter=4,
        )
    )
    styles.add(
        ParagraphStyle(
            name="BulletVIP",
            parent=styles["Normal"],
            fontSize=10,
            textColor=INK,
            leading=13,
            leftIndent=8,
        )
    )

    def footer(canvas, doc):
        canvas.saveState()
        canvas.setStrokeColor(CYAN)
        canvas.setLineWidth(1.2)
        canvas.line(0.75 * inch, 0.55 * inch, letter[0] - 0.75 * inch, 0.55 * inch)
        canvas.setFont("Helvetica", 8)
        canvas.setFillColor(MUTED)
        canvas.drawString(0.75 * inch, 0.35 * inch, "VoiceIsolate Pro · Confidential · Local-only audio")
        canvas.drawRightString(letter[0] - 0.75 * inch, 0.35 * inch, f"Page {doc.page}")
        canvas.restoreState()

    doc = SimpleDocTemplate(
        str(OUT),
        pagesize=letter,
        leftMargin=0.75 * inch,
        rightMargin=0.75 * inch,
        topMargin=0.7 * inch,
        bottomMargin=0.75 * inch,
        title="VoiceIsolate Pro v24 — Latest Release Notes",
        author="Conqueror Studios / Randy Jordan",
    )

    story = []
    story.append(Spacer(1, 1.2 * inch))
    story.append(Paragraph("VoiceIsolate Pro", styles["CoverTitle"]))
    story.append(Paragraph("v24.0.0 · Latest Product & Engineering Snapshot", styles["CoverSub"]))
    story.append(
        Paragraph(
            "100% on-device voice isolation · Analyzer ↔ WhisperHunter · Web · Desktop · Android",
            styles["CoverSub"],
        )
    )
    story.append(Spacer(1, 0.25 * inch))
    story.append(
        HRFlowable(width="80%", thickness=2, color=CYAN, spaceBefore=6, spaceAfter=12, hAlign="CENTER")
    )
    story.append(
        Paragraph(
            "This document summarizes the current production product (Engineer Mode + Stem-Split), "
            "the deferred-decode freeze-resistant pipeline, Analyzer↔WhisperHunter collaboration, "
            "and platform packaging for browser, Electron desktop, and Capacitor Android.",
            styles["BodyVIP"],
        )
    )
    story.append(Spacer(1, 0.2 * inch))
    story.append(Paragraph("© 2026 Randy Jordan / Conqueror Studios · Proprietary", styles["CoverSub"]))
    story.append(PageBreak())

    story.append(Paragraph("1. Product overview", styles["H1VIP"]))
    story.append(
        Paragraph(
            "VoiceIsolate Pro extracts studio-quality voice from noisy recordings without sending audio "
            "to a server. Processing is local: classical DSP + ONNX Runtime Web (WebGPU preferred, WASM "
            "fallback). Live microphone capture is intentionally disabled (upload-only).",
            styles["BodyVIP"],
        )
    )

    data = [
        [Paragraph("<b>Surface</b>", styles["BodyVIP"]), Paragraph("<b>Role</b>", styles["BodyVIP"])],
        [
            Paragraph("Landing /", styles["BodyVIP"]),
            Paragraph("Fast ML stem separation (vocals / accompaniment / noise)", styles["BodyVIP"]),
        ],
        [
            Paragraph("Engineer /app/", styles["BodyVIP"]),
            Paragraph("Full DSP suite, analysis workspace, WhisperHunter, Live-Mix", styles["BodyVIP"]),
        ],
        [Paragraph("Desktop", styles["BodyVIP"]), Paragraph("Electron shell + native save dialogs", styles["BodyVIP"])],
        [
            Paragraph("Android", styles["BodyVIP"]),
            Paragraph("Capacitor WebView, offline models, COOP/COEP hardening", styles["BodyVIP"]),
        ],
    ]
    t = Table(data, colWidths=[1.4 * inch, 5.1 * inch])
    t.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), HexColor("#e0f2fe")),
                ("GRID", (0, 0), (-1, -1), 0.4, HexColor("#94a3b8")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 6),
                ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ]
        )
    )
    story.append(t)

    story.append(Paragraph("2. Engineer Mode workflow (v24)", styles["H1VIP"]))
    story.append(
        Paragraph(
            "<b>Upload → Analyze → Isolate</b> is the disciplined path. Decode is deferred so large files "
            "no longer freeze the browser at drop time.",
            styles["BodyVIP"],
        )
    )
    for b in [
        "<b>Upload</b> — accept File only (name/size/type). Optional video picture via blob URL. No PCM decode.",
        "<b>Analyze Full Audio</b> — <i>ensureDecoded()</i> then full-file classical analysis "
        "(speech, whisper, music, noise, hum, impulses).",
        "<b>Joint map</b> — AnalyzerWhisperBridge fuses analysis with WhisperHunter environment profiling: "
        "protect voice/whisper; suppress music, horns, barks, crowd, hum, reverb.",
        "<b>Analyze + WhisperHunter</b> — one-shot apply joint plan + single-pass isolation.",
        "<b>Process / Live-Mix</b> — ML stem path when available, single STFT→ops→iSTFT spectral chain, "
        "then real-time gate/de-ess/EQ preview.",
        "<b>Export</b> — WAV (or remuxed video with processed audio).",
    ]:
        story.append(Paragraph("• " + b, styles["BulletVIP"]))

    story.append(Paragraph("3. Freeze resistance & speed", styles["H1VIP"]))
    for b in [
        "Deferred decode on Analyze / Process / Play (not at upload).",
        "No auto-pipeline on file drop — user starts work when ready.",
        "Cooperative yields: <i>scheduler.yield</i> when available, else rAF + macrotask; budgeted STFT yields.",
        "Stereo mid-channel process path halves spectral cost.",
        "Live-Mix AudioWorklets load lazily — never block upload or decode.",
        "Single-pass spectral contract — no multi-pass STFT freeze loops.",
    ]:
        story.append(Paragraph("• " + b, styles["BulletVIP"]))

    story.append(Paragraph("4. Analyzer ↔ WhisperHunter collaboration", styles["H1VIP"]))
    story.append(
        Paragraph(
            "The analysis workspace and WhisperHunter AI share one isolation map so unwanted sounds are "
            "suppressed while voices and whispers are protected and amplified (no cloud ASR, no invented words).",
            styles["BodyVIP"],
        )
    )
    data2 = [
        [Paragraph("<b>Class</b>", styles["BodyVIP"]), Paragraph("<b>Response</b>", styles["BodyVIP"])],
        [Paragraph("Music bed", styles["BodyVIP"]), Paragraph("musicKill, voiceIso, bassCrush", styles["BodyVIP"])],
        [
            Paragraph("Impulses (horns, barks)", styles["BodyVIP"]),
            Paragraph("crowdNull + NR; protect speech formants", styles["BodyVIP"]),
        ],
        [
            Paragraph("Broadband / traffic / crowd", styles["BodyVIP"]),
            Paragraph("NR, HP, isolation", styles["BodyVIP"]),
        ],
        [
            Paragraph("Hum / reverb", styles["BodyVIP"]),
            Paragraph("humRemoval, dereverb, roomCorrection", styles["BodyVIP"]),
        ],
        [
            Paragraph("Whisper / faint speech", styles["BodyVIP"]),
            Paragraph("shallower gate, whisperLift, presence boost", styles["BodyVIP"]),
        ],
    ]
    t2 = Table(data2, colWidths=[2.0 * inch, 4.5 * inch])
    t2.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), HexColor("#f3e8ff")),
                ("GRID", (0, 0), (-1, -1), 0.4, HexColor("#94a3b8")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 6),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ]
        )
    )
    story.append(t2)

    story.append(Paragraph("5. Platforms", styles["H1VIP"]))
    story.append(
        Paragraph(
            "<b>Web:</b> Vercel + COOP/COEP for SharedArrayBuffer · <b>Desktop:</b> Electron · "
            "<b>Android:</b> Capacitor, MainActivity COOP/COEP injection, lean offline model pack "
            "(BSRNN + RNNoise + VAD).",
            styles["BodyVIP"],
        )
    )

    story.append(Paragraph("6. Non-negotiable architecture constraints", styles["H1VIP"]))
    for b in [
        "Exactly one forward STFT and one inverse STFT per offline spectral branch.",
        "100% local audio processing — no cloud inference of user media.",
        "Upload-only — getUserMedia forbidden.",
        "Honest audition quality badges (high / medium / low).",
        "Models same-origin under /app/models/ with integrity checks when shipped.",
    ]:
        story.append(Paragraph("• " + b, styles["BulletVIP"]))

    story.append(Spacer(1, 0.3 * inch))
    story.append(HRFlowable(width="100%", thickness=1, color=CYAN, spaceBefore=4, spaceAfter=8))
    story.append(
        Paragraph(
            "Canonical code contract: CLAUDE.md · Architecture: docs/architecture/ · Guides: docs/guides/ · "
            "Repository: https://github.com/Joker5514/VoiceIsolate-Pro",
            styles["SmallVIP"],
        )
    )
    story.append(
        Paragraph(
            "Document generated for the latest v24 production line — Engineer Mode collaboration + deferred decode.",
            styles["SmallVIP"],
        )
    )

    doc.build(story, onFirstPage=footer, onLaterPages=footer)
    print(f"Wrote {OUT} ({OUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
