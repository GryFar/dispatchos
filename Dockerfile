# DispatchOS — production Docker image
#
# Multi-stage build:
#   1. build stage: install all deps + npm run build (esbuild + vite)
#   2. runtime stage: copy bundle + prune dev deps from node_modules
#
# Key fix: esbuild externalises most server deps (except an allowlist),
# so the production node_modules must contain dotenv, express, better-sqlite3,
# bcryptjs, drizzle-orm, etc. We achieve that by copying the full
# node_modules from build stage, then running `npm prune --omit=dev` to
# strip devDependencies.

# =============================================================================
# Stage 1: build
# =============================================================================
FROM node:20-alpine AS build

RUN apk add --no-cache python3 make g++ libc6-compat

WORKDIR /app

# Reproducible install from the committed lockfile: npm ci fails loudly if
# package.json and package-lock.json disagree instead of silently resolving a
# fresh (potentially different) dependency tree at build time.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build

# Strip devDependencies — leaves only runtime deps in node_modules
RUN npm prune --omit=dev

# =============================================================================
# Stage 2: runtime
# =============================================================================
FROM node:20-alpine AS runtime

RUN apk add --no-cache libc6-compat tini

# Non-root user matching the volume uid/gid
RUN addgroup -g 1001 -S app && adduser -u 1001 -S app -G app

WORKDIR /app

# Bundle + static assets
COPY --from=build /app/dist ./dist
# Pruned production node_modules (contains dotenv, express, better-sqlite3, etc.)
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json

# Mountpoint for the persistent volume (Fly mounts this at runtime)
RUN mkdir -p /data /data/uploads /data/drive && chown -R app:app /data /app

USER app

# Git SHA passed by deploy.yml so Sentry events carry a release tag
# (server/instrument.ts reads DISPATCHOS_RELEASE). Empty on local builds.
ARG DISPATCHOS_RELEASE=""
ENV DISPATCHOS_RELEASE=$DISPATCHOS_RELEASE

ENV NODE_ENV=production \
    PORT=8080 \
    DISPATCHOS_HOST=0.0.0.0 \
    DISPATCHOS_DB_PATH=/data/dispatchos-unified.db \
    DISPATCHOS_DATA_ROOT=/data \
    DISPATCHOS_DEPLOYMENT_MODE=vds \
    DISPATCHOS_TRUST_PROXY=2

EXPOSE 8080

# tini handles PID 1 / signal forwarding so SIGTERM cleanly closes SQLite
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.cjs"]
