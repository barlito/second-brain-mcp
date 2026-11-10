# ────────────────────────────────────────────────────────────────
# Builder stage: install all deps and compile TypeScript
# ────────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# better-sqlite3 is a native module; no musl prebuilt is published for this
# platform, so it compiles from source during npm ci.
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build
RUN npm prune --omit=dev

# ────────────────────────────────────────────────────────────────
# Runtime stage: production deps only + compiled output
# ────────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /app

RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# vault/git.ts shells out to the git CLI at runtime (not just build time).
RUN apk add --no-cache git

COPY --from=builder --chown=appuser:appgroup /app/node_modules ./node_modules
COPY --from=builder --chown=appuser:appgroup /app/dist ./dist
COPY --from=builder --chown=appuser:appgroup /app/package.json ./package.json

# Pre-create /data and /vault with the right ownership before switching
# user — Docker would otherwise seed named volumes as root:root on first
# mount. Local dev bind-mounts both to host-owned dirs instead and runs
# as the host uid (see docker-compose.yaml), so ownership matches there too.
RUN mkdir -p /data /vault && chown appuser:appgroup /data /vault

USER appuser

EXPOSE 3000

CMD ["node", "dist/server.js"]
