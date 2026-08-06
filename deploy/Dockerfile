FROM node:lts-alpine
ENV NODE_ENV=production
ENV PORT=3000
WORKDIR /usr/src/app

# Enable pnpm via corepack
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy package files
COPY ["package.json", "pnpm-lock.yaml", "./"]

# Install dependencies with pnpm (need express + server deps for COOP/COEP)
RUN pnpm install --prod --frozen-lockfile && mv node_modules ../

# Copy application files
COPY . .

# Serve via Express server.js so COOP/COEP/CORP headers enable SharedArrayBuffer
# (plain `serve public` does NOT set isolation headers — SAB/worklets break).
EXPOSE 3000
RUN chown -R node /usr/src/app
USER node
CMD ["node", "server.js"]