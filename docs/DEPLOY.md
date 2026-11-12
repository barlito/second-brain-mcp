# First production deploy runbook

Target: a Docker Swarm manager running the [traefik-base](https://github.com/barlito/traefik-base) stack (network `traefik_traefik_proxy`), serving `https://second-brain.barlito.fr`.

Deploys can run via the GitHub Actions workflow (see "Deploy via GitHub Actions" below) or manually with the checklist. Known gap: no off-host backup automation.

## Deploy via GitHub Actions

`.github/workflows/deploy.yml` (manual `workflow_dispatch`, `main` only, serialized by `concurrency: deploy-prod`):

1. Runs the CI workflow (`ci.yml`).
2. Builds and pushes `ghcr.io/barlito/second-brain-mcp:<short-sha>` (and `:main`). Fails if the `<short-sha>` tag already exists (tags are immutable).
3. In the `production` environment: over SSH (`DOCKER_HOST`, pinned host key) creates the Swarm secret `vault_deploy_key` if missing, logs the node in to ghcr, runs `make backup-db` if the service exists (a failed backup aborts the deploy), runs `make deploy.prod`, waits up to 3 min for the new task to run, then checks `https://second-brain.barlito.fr/health`.

Required repo config:

- Variables: `SERVER_HOST`, `SERVER_PORT`, `SERVER_USERNAME`, `SERVER_HOST_KEY` (full `known_hosts` line; the job fails if unset).
- Secrets: `SSH_PRIVATE_KEY`, `VAULT_DEPLOY_KEY` (private key of the vault deploy key), `ADMIN_PROXY_SECRET`, `ADMIN_WEB_SECRET`.
- Optional secret `GHCR_PULL_TOKEN`: long-lived PAT with `read:packages`. Without it the job's `GITHUB_TOKEN` is used, which expires after the job, so Swarm may fail to re-pull the image later (a warning is emitted).

Trigger: `gh workflow run deploy.yml --ref main`.

Rollback is not supported by the workflow (it always deploys the current `main` commit). Roll back manually with `make deploy.prod IMAGE_TAG=<old>` (see Rollback below, including the DB restore note for schema migrations).

## Checklist

### 1. Vault repository

- [ ] Create the private GitHub repo `barlito/second-brain-vault` with a `main` branch (an initial commit, e.g. a README, is optional: the server handles an empty remote).

### 2. Deploy key

- [ ] Generate a dedicated key (no passphrase):
  ```bash
  ssh-keygen -t ed25519 -N "" -C "second-brain-mcp-vault" -f ./vault_deploy_key
  ```
- [ ] In the vault repo: Settings -> Deploy keys -> Add deploy key, paste `vault_deploy_key.pub`, tick **Allow write access**.
- [ ] On the Swarm manager, create the secret and destroy the local copies:
  ```bash
  docker secret create vault_deploy_key ./vault_deploy_key
  shred -u ./vault_deploy_key ./vault_deploy_key.pub
  ```
  The prod compose mounts it at `/run/secrets/vault_deploy_key` (uid/gid 10001, mode 0400) and git uses it via `GIT_SSH_COMMAND`. GitHub host keys are baked into the image and verified.

### 3. Publish the image to ghcr (manual, immutable tag)

- [ ] `docker login ghcr.io` with a GitHub personal access token (classic) that has `write:packages` on the machine that pushes. The machine running `make deploy.prod` needs a login with `read:packages` (the package is private): `--with-registry-auth` forwards its credentials to the Swarm nodes.
- [ ] Build, tag and push. Use a unique tag such as the short git SHA; never reuse one:
  ```bash
  TAG=$(git rev-parse --short HEAD)
  docker build -t ghcr.io/barlito/second-brain-mcp:$TAG .
  docker push ghcr.io/barlito/second-brain-mcp:$TAG
  ```
  (Equivalent: `docker build -t second-brain-mcp:ci .` then `docker tag second-brain-mcp:ci ghcr.io/barlito/second-brain-mcp:$TAG` before pushing.)

### 3b. Web admin secrets and Authelia (required: compose refuses to render without them)

The web admin UI (`https://second-brain-admin.barlito.fr`, port 3002) sits behind Traefik + Authelia. Two secrets are needed:

- `ADMIN_PROXY_SECRET` (at least 32 chars): Traefik's `second-brain-admin-proxy` headers middleware sets `X-SB-Admin-Proxy` to this value AFTER Authelia, overwriting any client value. The app only believes `Remote-User`/`Remote-Groups` when this header matches (constant-time compare) and the peer is in `TRUSTED_PROXY`. Without it the web listener does not start.
- `ADMIN_WEB_SECRET`: key for the CSRF tokens (so they survive restarts).

- [ ] Generate both and store them as GitHub secrets of the deploy workflow (`ADMIN_PROXY_SECRET`, `ADMIN_WEB_SECRET`):
  ```bash
  openssl rand -hex 32
  ```
  The deploy job must export both in the environment of `make deploy.prod`; the prod compose uses `${ADMIN_PROXY_SECRET:?...}` / `${ADMIN_WEB_SECRET:?...}`. For a manual deploy: `export ADMIN_PROXY_SECRET=... ADMIN_WEB_SECRET=...` first. (Local `make deploy` generates and reuses `data/admin-proxy-secret` and `data/admin-web-secret`, mode 0600, gitignored.)
- [ ] Authelia (in the traefik-base stack) must satisfy:
  - the `authelia-auth@file` forwardAuth middleware lists `Remote-User`, `Remote-Groups` (and `Remote-Name`) in `authResponseHeaders`;
  - an access control rule for host `second-brain-admin.barlito.fr` (and `second-brain-admin.local.barlito.fr` locally) restricted to `subject: ["group:admins"]` with the policy you want (e.g. `two_factor`); the app also checks the `admins` group itself (`ADMIN_GROUP`).
  - the session cookie is named `authelia_session` (default); set `AUTHELIA_SESSION_COOKIE` if yours differs. CSRF tokens are bound to it, so POSTs are refused without it and a new login invalidates old forms.

### 4. Deploy

- [ ] From the repo root, on the manager:
  ```bash
  IMAGE_TAG=<tag> make deploy.prod
  ```
  It renders `docker-compose-prod.yml` and runs `docker stack deploy --with-registry-auth` for the stack `second-brain-mcp`. `IMAGE_TAG` is mandatory.
- [ ] Remote deploy: point the Docker CLI at the manager over SSH, the same pattern traefik-base uses in its GitHub Actions (see its `docs/GITHUB_ACTIONS.md`: SSH agent, pinned host key in `known_hosts`, then `DOCKER_HOST=ssh://...`):
  ```bash
  # deploy@server.barlito.fr is a placeholder: use your own user and manager host
  DOCKER_HOST=ssh://deploy@server.barlito.fr IMAGE_TAG=<tag> make deploy.prod
  ```
  The `make token-*` and `make backup-db` targets use `docker exec`, so they work the same way over `DOCKER_HOST`.

### 5. Verify bootstrap

- [ ] `docker service ps second-brain-mcp_second-brain-mcp` shows `Running`.
- [ ] `make logs` shows:
  ```
  vault ok: repo=yes remote=yes branch=main head=<sha>
  second-brain-mcp listening on port 3000
  ```
  `remote=no` means `VAULT_REMOTE_URL` is not set. A `vault bootstrap failed` line means the clone failed (see troubleshooting).
- [ ] `curl https://second-brain.barlito.fr/health` returns `{"status":"ok"}`.

### 6. First token

- [ ] Create it and store the printed `sb_...` token in a password manager (it is shown once):
  ```bash
  make token-create name=claude-code 'scope=meta:smoke:notes:read,meta:smoke:notes:write'
  ```
  (This narrow scope covers the smoke-test note below; issue your real working tokens afterwards.)

### 7. Smoke test

- [ ] Add the MCP server in Claude Code (see the README), then `kb_write` a note, e.g. space `meta`, project `smoke`, section `notes`, note `hello`. It returns a commit SHA.
- [ ] Within a few seconds the commit `kb_write: meta/smoke/notes/hello via claude-code` appears on `barlito/second-brain-vault` on GitHub (the push is asynchronous, with retries).
- [ ] `kb_read` the same note and compare the content.
- [ ] `curl -H "Authorization: Bearer $TOKEN" https://second-brain.barlito.fr/health/details` shows `"status":"ok"`, `lastPushOk` not `false`, `conflicts` `0`.

### 8. First backup

- [ ] `make backup-db` (writes `/data/backups/acl-<timestamp>.db` in the `acl-data` volume).
- [ ] Copy it off-host (no automation yet). Run on the node where the task runs:
  ```bash
  CID=$(docker ps -q --filter label=com.docker.swarm.service.name=second-brain-mcp_second-brain-mcp | head -n1)
  docker cp "$CID":/data/backups/. ./second-brain-backups/
  ```
  The vault itself is already backed up by its GitHub remote (unpushed local commits aside).

## Rollback

Updates use `stop-first` with `failure_action: rollback` and a 30 s monitor window, so a task that fails to start is rolled back automatically. Manually:

```bash
docker service rollback second-brain-mcp_second-brain-mcp
# or redeploy a previous, still-published tag:
IMAGE_TAG=<previous-tag> make deploy.prod
```

**Schema migrations are one-way.** The app upgrades `acl.db` on boot (e.g. migration 6 adds `tokens.expires_at`) and an older image refuses a database whose schema is newer than it knows. Rolling back to an image older than the current DB schema therefore requires restoring the pre-deploy backup (stop the stack, replace `acl.db` in the `acl-data` volume with the copy taken before the upgrade). Tokens created or revoked after that backup are lost with it.

**Before every deploy (`make deploy` or `make deploy.prod`) run `make backup-db`.** Neither target takes a backup itself, so this step is manual and is what makes a rollback past a migration possible.

The SQLite database and the vault live on named volumes and survive redeploys. Restoring a database backup means stopping the stack and replacing `acl.db` in the `acl-data` volume (not scripted).

## Troubleshooting

| Symptom | Likely cause / action |
|---------|-----------------------|
| `401` `missing or malformed Authorization header` | The header must be `Authorization: Bearer <token>`. |
| `401` `invalid or revoked token` | Wrong, revoked or truncated token. `make token-list`; create a new one if needed. |
| `429 Too many failed authentications` | 10 failures from that IP within 60 s. Wait a minute (the limiter is in memory; a restart clears it). If the audit log always shows Traefik's address as client IP, `TRUSTED_PROXY` is not resolving. |
| Tool returns `Permission denied.` | The scope does not match exactly (space, project, section, and read vs write). `make token-list`. |
| Tool returns `Vault is busy, retry in a moment.` | Someone is using the vault repo directly (rebase in progress, or a git `index.lock` younger than 10 minutes). Finish or abort that operation, then retry. |
| Tool returns `Conflict: ... saved on branch conflict/<ts>` | The remote changed the same note. Re-read and retry the write. Inspect/merge the `conflict/<ts>` branch in the vault repo, then delete it. |
| `/health/details` is `degraded`, `lastPushOk: false` or `unpushed: true` | Push failing: check the logs for `git push` / `periodic sync` errors, that the deploy key has write access, and that GitHub is reachable. Local commits are kept and retried every sync interval. |
| `vault bootstrap failed` at startup, container restarting | Clone failed: secret `vault_deploy_key` missing or wrong, key not added to the repo, repo or `main` branch missing, or a different repo name than the one in `docker-compose-prod.yml`. |
| Permission errors on `/vault` or `/data` | The volumes must be writable by uid/gid 10001 (the image pre-creates them so for named volumes). If you switched to bind mounts, `chown 10001:10001` them. |
| Service does not start: pull denied / no such image | The tag was not pushed, or the deploying machine is not logged in to ghcr (`--with-registry-auth` forwards that login). `IMAGE_TAG` unset aborts before deploying. |
