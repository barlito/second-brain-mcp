# ────────────────────────────────────────────────────────────────
# Builder stage: install all deps and compile TypeScript
# ────────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

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

COPY --from=builder --chown=appuser:appgroup /app/node_modules ./node_modules
COPY --from=builder --chown=appuser:appgroup /app/dist ./dist
COPY --from=builder --chown=appuser:appgroup /app/package.json ./package.json

# Le volume nommé /data (base SQLite ACL, à partir de la PR2) doit être
# accessible en écriture par appuser : on prépare le répertoire et son
# ownership avant de changer d'utilisateur, car Docker le créerait
# sinon en root:root au premier démarrage du volume nommé.
RUN mkdir -p /data && chown appuser:appgroup /data

USER appuser

EXPOSE 3000

CMD ["node", "dist/server.js"]
