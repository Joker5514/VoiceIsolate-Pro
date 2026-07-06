FROM node:lts-alpine
ENV NODE_ENV=production
WORKDIR /usr/src/app

# Enable pnpm via corepack
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy package files
COPY ["package.json", "pnpm-lock.yaml", "./"]

# Install dependencies with pnpm
RUN pnpm install --prod --frozen-lockfile && mv node_modules ../

# Copy application files
COPY . .

EXPOSE 3000
RUN chown -R node /usr/src/app
USER node
CMD ["npx", "serve", "public", "-l", "3000", "--cors"]
