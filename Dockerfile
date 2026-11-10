# Base image pinned by digest. To bump:
#   docker pull node:24-alpine && docker inspect node:24-alpine --format '{{index .RepoDigests 0}}'
# then replace the sha256 below (used by both stages).
ARG NODE_IMAGE=node:24-alpine@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8

# ────────────────────────────────────────────────────────────────
# Builder stage: install all deps and compile TypeScript
# ────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS builder

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
FROM ${NODE_IMAGE} AS runtime

ENV NODE_ENV=production
WORKDIR /app

# Fixed uid/gid so compose (secret uid/gid) can reference them.
RUN addgroup -S -g 10001 appgroup && adduser -S -u 10001 -G appgroup appuser

# git + openssh-client: vault sync shells out to them. tini: PID 1.
RUN apk add --no-cache git openssh-client tini

# GitHub SSH host keys, verified against the fingerprints GitHub publishes
# (https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints).
# Build fails on any mismatch or missing key type.
RUN set -eu; \
    ssh-keyscan -T 10 -t rsa,ecdsa,ed25519 github.com 2>/dev/null | grep -v '^#' > /tmp/gh_keys; \
    ok=0; \
    while read -r line; do \
      echo "$line" > /tmp/one_key; \
      fp=$(ssh-keygen -lf /tmp/one_key | awk '{print $2}'); \
      case "$fp" in \
        SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s|\
        SHA256:p2QAMXNIC1TJYWeIOttrVc98/R1BUFWu3/LiyKgUfQM|\
        SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU) ok=$((ok+1)) ;; \
        *) echo "unexpected GitHub host key fingerprint: $fp" >&2; exit 1 ;; \
      esac; \
    done < /tmp/gh_keys; \
    [ "$ok" -eq 3 ] || { echo "expected 3 verified GitHub host keys, got $ok" >&2; exit 1; }; \
    cp /tmp/gh_keys /etc/ssh/ssh_known_hosts; \
    rm -f /tmp/gh_keys /tmp/one_key

# npm/npx/corepack/yarn are not needed at runtime.
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx \
      /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn*

# App code stays root-owned (world-readable, not writable by appuser).
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json

# Pre-create /data and /vault with the right ownership before switching
# user — Docker would otherwise seed named volumes as root:root on first
# mount. Local dev bind-mounts both to host-owned dirs instead and runs
# as the host uid (see docker-compose.yaml), so ownership matches there too.
RUN mkdir -p /data /vault && chown appuser:appgroup /data /vault

USER appuser

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health >/dev/null || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]
