# Toolchain pinned to the repository's own contract: Node major from
# .node-version (and CI), pnpm from package.json "packageManager".
ARG NODE_MAJOR=24
FROM node:${NODE_MAJOR}-alpine
ENV PORT=3000
WORKDIR /usr/src/app

RUN corepack enable && corepack prepare pnpm@11.3.0 --activate

# Complete install inputs, so the frozen lockfile and lifecycle scripts run as
# in CI: pnpm-workspace.yaml carries the overrides/allowBuilds the lockfile was
# resolved with (without it: ERR_PNPM_LOCKFILE_CONFIG_MISMATCH), packages/ is
# the workspace member, and postinstall runs scripts/setup-{ort,three}.js
# (CommonJS via scripts/package.json) against the vendored public/lib.
COPY ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc", "./"]
COPY packages ./packages
COPY ["scripts/package.json", "scripts/setup-ort.js", "scripts/setup-three.js", "./scripts/"]
COPY public/lib ./public/lib
RUN NODE_ENV=production pnpm install --prod --frozen-lockfile

# Copy application files (.dockerignore keeps node_modules and .env out).
COPY . .
ENV NODE_ENV=production

# Serve via Express server.js so COOP/COEP/CORP headers enable SharedArrayBuffer
# (plain `serve public` does NOT set isolation headers — SAB/worklets break).
# Production start requires LICENSE_JWT_SECRET (server refuses without it).
EXPOSE 3000
RUN chown -R node /usr/src/app
USER node
CMD ["node", "server.js"]
