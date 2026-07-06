# Deployment Targets

VoiceIsolate Pro ships as a **static web app** on Vercel (canonical). These files support optional self-hosted and container deployments.

| File | Purpose |
|------|---------|
| `Dockerfile` | Container image for the static site + Express dev server |
| `compose.yaml` | Docker Compose stack (production profile) |
| `compose.debug.yaml` | Docker Compose with debug ports and hot reload |
| `render.yaml` | [Render.com](https://render.com) service definition (CSP headers) |
| `Caddyfile` | Caddy reverse-proxy with COOP/COEP for local/self-hosted |

**Production web:** configure [vercel.json](../vercel.json) and run `pnpm build` via [scripts/vercel-build.js](../scripts/vercel-build.js).

```bash
# From repo root
docker compose -f deploy/compose.yaml up --build
docker compose -f deploy/compose.debug.yaml up --build
```

**Desktop:** [electron/electron-builder.yml](../electron/electron-builder.yml) · **Android:** `pnpm build && npx cap sync android`