# First production deploy runbook

Target: a Docker Swarm manager running the [traefik-base](https://github.com/barlito/traefik-base) stack (network `traefik_traefik_proxy`), serving `https://second-brain.barlito.fr`.

Releases are cut with GitHub Releases and deployed with GitHub Actions (same flow as the other barlito projects). Known gap: no off-host backup automation.

## Release, deploy, rollback (GitHub Actions)

1. **Release**: create a GitHub Release `vX.Y.Z`. `release.yaml` runs the tests, then builds and pushes `<DOCKER_HUB_USERNAME>/second-brain-mcp:vX.Y.Z` and `:latest` to Docker Hub (buildcache on ghcr). Tags are immutable: never reuse one.
2. **Deploy**: run the Deploy workflow on that tag (the job refuses a non-tag ref):
   ```bash
   gh workflow run deploy.yaml --ref vX.Y.Z                    # image-only update
   gh workflow run deploy.yaml --ref vX.Y.Z -f re-deploy=true  # full stack deploy
   ```
   - Image-only: `make db.backup` (skipped when no task runs), `docker service update --with-registry-auth --image ...`, `make deploy.assert_image` (waits up to 180 s for the new image to run healthy; fails on rollback or crash loop and prints `docker service ps --no-trunc` + the last 50 log lines), `make smoke.test` (`/health`), `make deploy.prune`.
   - `re-deploy=true` applies the whole `docker-compose-prod.yml` (`make deploy.prod`: backup, rolling `docker stack deploy --with-registry-auth`, assert, smoke, prune). **The first deploy needs it**, and so does any compose change. It creates the Swarm secret `vault_deploy_key` from `VAULT_DEPLOY_KEY` if missing.
3. **Rollback**: run the Rollback workflow: `gh workflow run rollback.yaml --ref main -f tag=vX.Y.Z [-f restore-db=acl-<ts>.db]`. It backs up the current DB, optionally restores a backup, switches the image, asserts and smoke-tests (see Rollback below).

Required repo config:

- Secrets: `SSH_PRIVATE_KEY`, `DOCKER_HUB_USERNAME`, `DOCKER_HUB_READ_WRITE_DELETE_ACCESS_TOKEN`, `ADMIN_PROXY_SECRET`, `ADMIN_WEB_SECRET`, `VAULT_DEPLOY_KEY` (private half of the vault deploy key).
- Variables: `SERVER_HOST`, `SERVER_PORT`, `SERVER_USERNAME`, and optionally `SERVER_HOST_KEY` (full `known_hosts` line to pin the host; without it the jobs fall back to `ssh-keyscan` and warn).

The manual checklist below does the same by hand.

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

### 3. Publish the image (Docker Hub, immutable tag)

- [ ] Create a GitHub Release `vX.Y.Z`: `release.yaml` pushes `barlito/second-brain-mcp:vX.Y.Z`. Manual equivalent: `docker build -t barlito/second-brain-mcp:vX.Y.Z . && docker push barlito/second-brain-mcp:vX.Y.Z` (never reuse a tag). The deploying machine needs `docker login` to Docker Hub (`--with-registry-auth` forwards it to the nodes).

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
  TAG=<tag> make deploy.prod
  ```
  It renders `docker-compose-prod.yml` and runs `docker stack deploy --with-registry-auth` for the stack `second-brain-mcp`. `TAG` is mandatory. It also runs the DB backup, waits for the new task to be healthy, smoke-tests and prunes.
- [ ] Remote deploy: point the Docker CLI at the manager over SSH, the same pattern traefik-base uses in its GitHub Actions (see its `docs/GITHUB_ACTIONS.md`: SSH agent, pinned host key in `known_hosts`, then `DOCKER_HOST=ssh://...`):
  ```bash
  # deploy@server.barlito.fr is a placeholder: use your own user and manager host
  DOCKER_HOST=ssh://deploy@server.barlito.fr TAG=<tag> make deploy.prod
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

Updates use `stop-first` with `failure_action: rollback` and a 30 s monitor window, so a task that fails to start is rolled back automatically (Swarm then exits 0, which is why `deploy.assert_image` exists: it fails the workflow unless the service really runs the new image, healthy).

Run the **Rollback** workflow (`gh workflow run rollback.yaml --ref main -f tag=<old> [-f restore-db=acl-<ts>.db]`) or by hand:

```bash
make db.backup
make docker.service.update args="--replicas 1 --image barlito/second-brain-mcp:<old> second-brain-mcp_second-brain-mcp"
TAG=<old> make deploy.assert_image && make smoke.test
```

**Schema migrations are one-way.** The app upgrades `acl.db` on boot (e.g. migration 6 adds `tokens.expires_at`) and refuses to start on a database whose `user_version` is newer than the build knows (`DB schema version N is newer than this build supports`). Rolling back across a migration therefore crash-loops and `deploy.assert_image` fails loudly; the DB is not touched. To roll back across a migration, restore a backup taken before the upgrade: pass `restore-db=<file>` to the workflow, or by hand:

```bash
docker service scale second-brain-mcp_second-brain-mcp=0
make db.restore TAG=<old> file=acl-<ts>.db     # keeps the current DB as acl.db.pre-restore-<ts>
make docker.service.update args="--replicas 1 --image barlito/second-brain-mcp:<old> second-brain-mcp_second-brain-mcp"
TAG=<old> make deploy.assert_image && make smoke.test
```

Tokens created or revoked after the restored backup are lost. `deploy.prod` and the Deploy/Rollback workflows take a backup (`make db.backup`) before changing anything, so a pre-upgrade copy always exists under `/data/backups` (list it with `docker exec <cid> ls /data/backups`). Local `make deploy` does not back up.

The SQLite database and the vault live on named volumes and survive redeploys.

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
| Service does not start: pull denied / no such image | The tag was not pushed, or the deploying machine is not logged in to Docker Hub (`--with-registry-auth` forwards that login). `TAG` unset aborts before deploying. |
