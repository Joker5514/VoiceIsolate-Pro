# AGENTS.md

**The single source of truth for AI contributors is [`CLAUDE.md`](CLAUDE.md).**

Read it before any change. It defines the Stem-Split & Live-Mix architecture,
the 4-layer `src/` module system, the security rules, Engineer Console UI parity
(Web · Android · Desktop share `public/app/`), and the list of deliberately
deleted legacy patterns (live-microphone ingestion, the pipeline-orchestrator
monolith, client-side auth, dev license stubs).

Do not restore deleted legacy code from git history, and do not duplicate
architectural documentation here — update `CLAUDE.md` instead so there is
exactly one document to keep correct.

**Platform packaging:** `pnpm build` → `build/` then Capacitor / Electron. Never
fork a separate Engineer UI for mobile or desktop.
