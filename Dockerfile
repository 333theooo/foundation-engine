# Production image for Atrium Studio.
#
# Multi-stage so the runtime image carries no build toolchain and no source:
# dependencies, then build, then a minimal runner using Next's standalone
# output. The result is a few hundred megabytes rather than a few gigabytes.

# ---------------------------------------------------------------- dependencies
FROM node:22-bookworm-slim AS deps
WORKDIR /app

# `openssl` is needed by Prisma's query engine.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY scripts/copy-wasm.mjs ./scripts/copy-wasm.mjs
RUN npm ci

# ---------------------------------------------------------------------- build
FROM node:22-bookworm-slim AS build
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Prisma's client is generated from the schema, not committed.
RUN npx prisma generate
ENV NEXT_TELEMETRY_DISABLED=1
# Standalone output: see the comment in next.config.ts.
ENV BUILD_STANDALONE=true
RUN npm run build

# --------------------------------------------------------------------- runtime
FROM node:22-bookworm-slim AS runner
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Run as a non-root user.
RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs nextjs

COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=build --chown=nextjs:nodejs /app/public ./public

# Migrations and the Prisma CLI, so `prisma migrate deploy` can run on release.
COPY --from=build --chown=nextjs:nodejs /app/prisma ./prisma
COPY --from=build --chown=nextjs:nodejs /app/prisma.config.ts ./prisma.config.ts

RUN mkdir -p /data/storage && chown -R nextjs:nodejs /data/storage
VOLUME /data/storage

USER nextjs
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
