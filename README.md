# second-brain-mcp

An MCP server that exposes a git-backed, Obsidian-compatible knowledge-base vault to Claude and other agents. Access is gated by Bearer tokens with exact per-project/section read and write scopes (stored in SQLite), and every call is audit-logged.

- Transport: stateless Streamable HTTP at `POST /mcp` (TypeScript, Express 5, MCP SDK).
- Two tools: `kb_read` and `kb_write`.
- Deployed with Docker Swarm (`docker stack deploy`, driven by the Makefile) behind the [traefik-base](https://github.com/barlito/traefik-base) stack (network `traefik_traefik_proxy`).
- Local: `https://second-brain.local.barlito.fr`. Prod: `https://second-brain.barlito.fr` (not deployed yet, see [docs/DEPLOY.md](docs/DEPLOY.md)).

## Architecture

Request path:

```
Traefik -> bearer auth (+ per-IP failure limiter) -> /mcp -> ACL check -> vault path safety -> git sync -> audit
```

1. Traefik terminates TLS (plain HTTP is redirected to HTTPS). In prod it also applies a rate limit and security headers.
2. Bearer auth looks the token up by SHA-256 hash (only hashes are stored). After 10 failed attempts from one IP within 60 s, that IP gets `429` until the window ends. The client IP comes from `X-Forwarded-For`, trusted only from the Traefik tasks (`TRUSTED_PROXY`).
3. `/mcp` builds a fresh MCP server per request (stateless).
4. The tool checks the token's scopes (exact match on project, section and permission).
5. The path is resolved from validated slugs, re-checked against the vault root, and symlinks are refused.
6. Writes go through a single queue: pull (rebase), atomic write, local commit, then asynchronous push.
7. One audit row is written per tool call (`ok`, `denied` or `error`), plus rows for HTTP-level errors and (coalesced) auth failures.

## Vault layout and naming

```
<vault>/
  <project>/
    <section>/
      <note>.md
```

`project`, `section` and `note` must each match `^[a-z0-9][a-z0-9-]{0,63}$` (lowercase letters, digits and hyphens; max 64 chars; no leading hyphen; no dots, slashes or spaces). The `.md` extension is added by the server. Anything else is rejected.

## Tools

Both tools take `project`, `section`, `note` (strings, max 64 chars each).

| Tool | Extra argument | Result |
|------|----------------|--------|
| `kb_read` | none | The note content as text. |
| `kb_write` | `content` (string, max 512 KB), written verbatim | The git commit SHA. Creates or overwrites the note. |

Errors returned to the client (`isError: true`):

| Message | Cause |
|---------|-------|
| `Permission denied.` | Token has no exact scope for that project/section/permission. Deliberately does not reveal whether the project exists. |
| `Note not found.` | `kb_read` on a missing note. |
| `Invalid project/section/note name.` | A name does not match the slug rules. |
| `Path not allowed.` | Path-safety check failed (escape from the vault root, symlink, not a regular file). |
| `Vault is busy, retry in a moment.` | A human (or other git process) is using the vault repo: a rebase in progress or a recent `index.lock`. Retry. |
| `Conflict: this note was changed remotely. Your version was saved on branch <conflict/...>. Re-read the note and retry.` | See [Git sync](#git-sync). |
| `Internal error.` | Anything else. Details are in the server log and the audit row only. |

HTTP-level: `401` (missing/invalid/revoked token), `429` (too many failed auths), `503` (shutting down), `405` for `GET /mcp`. Request bodies are limited to 1 MB.

## Token management

Tokens are managed with `make` targets that run a CLI inside the running service container (so the stack must be deployed).

```bash
make token-create name=claude-code scope=myproj:notes:read,myproj:notes:write
make token-list
make token-revoke id=<token id>
```

- Scope format: `project:section:permission`, comma-separated. `permission` is `read` or `write`. `project` and `section` follow the slug rules.
- Scopes are exact: `write` does not imply `read`, and there are no wildcards. Grant both if you want both.
- The plaintext token (`sb_...`) is printed once at creation and cannot be recovered. Only its hash is stored. If lost, revoke and create a new one.
- `token-list` shows id, name, created/revoked/last-used timestamps and scopes.

## Configuring a Claude Code client

Add an HTTP MCP server with the token in an `Authorization` header:

```bash
claude mcp add --transport http second-brain https://second-brain.barlito.fr/mcp \
  --header "Authorization: Bearer sb_xxxxxxxx"
```

or the equivalent entry in `.mcp.json`:

```json
{
  "mcpServers": {
    "second-brain": {
      "type": "http",
      "url": "https://second-brain.barlito.fr/mcp",
      "headers": { "Authorization": "Bearer sb_xxxxxxxx" }
    }
  }
}
```

Use `https://second-brain.local.barlito.fr/mcp` for the local stack. Keep tokens out of committed files. This is the generic format; check the current Claude Code MCP docs if the CLI flags change.

## Local development

Prerequisites:

- Docker with Swarm initialised (`docker swarm init`).
- The [traefik-base](https://github.com/barlito/traefik-base) stack deployed (provides network `traefik_traefik_proxy`, TLS and the `security-headers`/`redirect-to-https` middlewares).
- DNS resolving `*.local.barlito.fr` to your machine.
- A git repo at `../second-brain-vault-dev` (sibling of this repo). It is bind-mounted as `/vault`. It needs no remote: locally the vault is a plain git repo.

Commands:

```bash
make deploy      # build image (unique local-<sha>-<ts> tag), deploy the stack, prune old local images
make logs        # follow service logs
make undeploy    # remove the stack
make restart     # undeploy, then deploy
make help        # list all targets
```

Locally the container runs as your uid/gid (so it can write to the bind-mounted vault) and SQLite lives in `./data` (git-ignored).

Tests need Node 24. If the host has no Node, run them in a container (CI runs `npm ci`, `npm test`, `npm run build` on Node 24 with a git identity configured):

```bash
docker run --rm -v "$PWD":/app -w /app node:24-alpine sh -c \
  'apk add --no-cache git python3 make g++ >/dev/null \
   && git config --global user.name ci && git config --global user.email ci@noreply.local \
   && npm ci && npm test && npm run build'
```

CI also runs `docker build .` and validates both compose files with `docker compose config -q`.

## Health endpoints

| Endpoint | Auth | Response |
|----------|------|----------|
| `GET /health` | none | `{"status":"ok"}` (200) or `{"status":"error"}` (503). Checks only the DB and that the vault is a git repo. Sync trouble never fails it, so network blips do not restart-loop the container. Used by the Docker `HEALTHCHECK`. |
| `GET /health/details` | any valid token | `status` (`ok`/`degraded`/`error`), `db`, `vault`, and `sync` (`hasRemote`, `branch`, `unpushed`, `lastPushOk`, `conflicts`). `degraded` means the last push failed or a conflict branch was created. |

```bash
curl -H "Authorization: Bearer $TOKEN" https://second-brain.local.barlito.fr/health/details
```

## Maintenance

```bash
make backup-db                 # consistent SQLite backup to /data/backups/acl-<UTC timestamp>.db (inside the container)
make prune-audit days=90       # delete audit rows older than 90 days
```

Backups live on the `/data` volume (`./data/backups` locally, the `acl-data` volume in prod). Copy them off-host yourself; there is no automation yet (see [docs/DEPLOY.md](docs/DEPLOY.md)).

## Git sync

- A `kb_write` pulls (rebase) first, writes the note atomically and commits locally, then pushes asynchronously with retries. If the remote is unreachable, the write still commits locally and the push is retried later.
- A periodic sync (every `VAULT_SYNC_INTERVAL_MS`, default 60 s; `0` disables it) pulls remote changes and pushes leftover local commits.
- With no `VAULT_REMOTE_URL` the vault is a local-only repo (the local-dev case).
- Conflict: if the remote changed the same note(s) as unsynced local work, the local commits are saved on a backup branch `conflict/<timestamp>` (pushed best-effort), the working branch is reset to the remote, and the write fails with the `Conflict: ...` message above. Re-read the note and retry. Conflicts show up in `/health/details` and in the logs (`SYNC CONFLICT`).
- A human's in-progress git operation is never touched: if a rebase is in progress that the server did not start, or an `index.lock` is younger than 10 minutes, writes fail with `Vault is busy`. The server only cleans up leftovers of its own interrupted operations.
- On shutdown, in-flight requests and queued writes are drained (up to 25 s) and pending pushes are aborted; the next sync retries them.

## Environment variables

Compose sets these; no `.env` file is needed. [.env.example](.env.example) documents them for running outside Docker.

| Variable | Purpose | Default | Local compose | Prod compose |
|----------|---------|---------|---------------|--------------|
| `VAULT_PATH` | Vault git repo directory. Required (server exits without it). | none | `/vault` | `/vault` |
| `DB_PATH` | SQLite ACL/audit database file. Set it explicitly. | none | `/data/acl.db` | `/data/acl.db` |
| `PORT` | HTTP listen port. | `3000` | `3000` | `3000` |
| `VAULT_REMOTE_URL` | Git remote to clone/push. Empty means local-only vault. | empty | unset | `git@github.com:barlito/second-brain-vault.git` |
| `VAULT_BRANCH` | Branch to track. | `main` | `main` | `main` |
| `VAULT_SYNC_INTERVAL_MS` | Periodic sync interval; `0` disables. | `60000` | `60000` | `60000` |
| `TRUSTED_PROXY` | Hostname/IP(s) allowed to set `X-Forwarded-For`; empty trusts nobody (client IP = socket address). | empty | `tasks.traefik_traefik` | `tasks.traefik_traefik` |
| `GIT_SSH_COMMAND` | SSH command for git; points at the deploy key secret. | unset | unset | `ssh -i /run/secrets/vault_deploy_key -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10` |
| `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL` | Git identity (git refuses to commit without one). | none | `second-brain-mcp` / `second-brain-mcp@noreply.local` | same |
| `NODE_ENV` | Node mode. | unset | `development` | `production` |
| `SB_PUSH_DEADLINE_MS` | Overall push deadline including retries (test override). | `150000` | unset | unset |
| `IMAGE_TAG` | Compose-time only: image tag. Required in prod (`make deploy.prod IMAGE_TAG=<tag>`); `make deploy` sets a unique local one. | n/a | auto | required |

## Security notes

Hardened:

- Tokens are random (256-bit), stored only as SHA-256 hashes, shown once, individually revocable.
- Per-IP auth-failure limiter; audit of every tool call and of auth failures; Traefik rate limit and security headers in prod.
- Strict slug validation, path re-check against the vault root, symlinks refused; body and note size limits.
- Clients only see generic errors; real reasons go to the audit log and server log with credentials redacted.
- Container runs as non-root (uid 10001) under `tini`; base image pinned by digest; GitHub SSH host keys are vendored and fingerprint-verified at build time, and prod uses `StrictHostKeyChecking=yes`; the vault deploy key is a Docker secret.
- Plain HTTP never serves `/mcp` (redirected to HTTPS).

Deliberate limits:

- Scopes are exact-match only: no wildcards, and `write` does not imply `read`.
- Names are strict slugs (no uppercase, dots, spaces or nested folders).
- Single replica: one git working tree and one SQLite file, so tasks must never overlap (`stop-first` updates).
- The auth-failure limiter state is in memory (reset on restart).
