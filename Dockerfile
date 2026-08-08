# syntax=docker/dockerfile:1

# The server runs TypeScript directly through Node's built-in type stripping, so
# there is no server build step — only the browser bundle needs building.
FROM node:22-bookworm-slim AS build
WORKDIR /app

# better-sqlite3 compiles from source when no prebuild matches this platform.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN node scripts/build-web.mjs

# Drop the toolchain from node_modules after the bundle is built, so the native
# module is compiled exactly once and the runtime image stays small.
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4000 \
    DATABASE_URL=/data/open-crm.db

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/public ./public
COPY package.json tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

# Own the data directory as the unprivileged node user before dropping root.
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/readyz" || exit 1

CMD ["node", "src/main.ts"]
