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

# GitHub SSH host keys: vendored (no network at build), verified against the
# fingerprints GitHub publishes
# (https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints).
# Refresh: take ssh_keys from https://api.github.com/meta, prefix each with
# "github.com ", update docker/github_known_hosts and the fingerprints below.
# Build fails on any mismatch or missing key type.
COPY --chmod=644 docker/github_known_hosts /etc/ssh/ssh_known_hosts
RUN set -eu; \
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
    done < /etc/ssh/ssh_known_hosts; \
    [ "$ok" -eq 3 ] || { echo "expected 3 verified GitHub host keys, got $ok" >&2; exit 1; }; \
    rm -f /tmp/one_key

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

# Probe every 2s during start so Traefik routes to a new task quickly (stop-first rollouts).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --start-interval=2s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health >/dev/null || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]
