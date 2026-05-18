# DispatchOS — production Docker image
#
# Multi-stage build:
#   1. deps stage installs node_modules
#   2. build stage runs `npm run build` (esbuild + vite)
#   3. runtime stage is a minimal Alpine image with the bundle + native deps
#
# better-sqlite3 needs node-gyp / python3 / build tooling at install time on
# Alpine, so we keep that in the deps stage and copy only the compiled .node
# into the runtime image.

# =============================================================================
# Stage 1: deps
# =============================================================================
FROM node:20-alpine AS deps

RUN apk add --no-cache python3 make g++ libc6-compat

WORKDIR /app

COPY package.json package-lock.json* ./

# Use --omit=dev to skip devDependencies — but we need them for the build step,
# so install everything here, then prune in the build stage.
RUN npm install --no-audit --no-fund

# =============================================================================
# Stage 2: build
# =============================================================================
FROM node:20-alpine AS build

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Build server bundle (dist/index.cjs) + client bundle (dist/public/)
RUN npm run build

# =============================================================================
# Stage 3: runtime
# =============================================================================
FROM node:20-alpine AS runtime

# Native libs needed at runtime by better-sqlite3
RUN apk add --no-cache libc6-compat tini

# Non-root user
RUN addgroup -g 1001 -S app && adduser -u 1001 -S app -G app

WORKDIR /app

# Copy bundle + static assets from build stage
COPY --from=build /app/dist ./dist
# Compiled native dependency (better-sqlite3) lives in node_modules
COPY --from=build /app/node_modules/better-sqlite3 ./node_modules/better-sqlite3
# Hoisted runtime helpers used by better-sqlite3 / express boot
COPY --from=build /app/node_modules/bindings ./node_modules/bindings
COPY --from=build /app/node_modules/file-uri-to-path ./node_modules/file-uri-to-path
COPY --from=build /app/package.json ./package.json

# Mountpoint for the persistent volume (Fly mounts this)
RUN mkdir -p /data /data/uploads /data/drive && chown -R app:app /data /app

USER app

ENV NODE_ENV=production \
    PORT=8080 \
    DISPATCHOS_DB_PATH=/data/dispatchos-unified.db \
    DISPATCHOS_DATA_ROOT=/data \
    DISPATCHOS_DEPLOYMENT_MODE=vds \
    DISPATCHOS_TRUST_PROXY=1

EXPOSE 8080

# tini handles PID 1 / signal forwarding so SIGTERM cleanly closes SQLite
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.cjs"]
