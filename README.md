# second-brain-mcp

An MCP server that exposes a git-backed, Obsidian-compatible knowledge-base vault to Claude and other agents. Access is gated by Bearer tokens with hierarchical space/project/section `read`, `write` and `propose` scopes (stored in SQLite), and every call is audit-logged.

- Transport: stateless Streamable HTTP at `POST /mcp` (TypeScript, Express 5, MCP SDK).
- Nine tools: `kb_read`, `kb_write`, `kb_append`, `kb_archive`, `kb_list`, `kb_search`, `kb_history`, `kb_init_project`, `kb_propose`.
- Admin: a [web admin UI](#web-admin-ui) behind Traefik + Authelia (tokens, proposals inbox, vault browser, audit log) and `make` targets for tokens and the inbox.
- Deployed with Docker Swarm (`docker stack deploy`, driven by the Makefile) behind the [traefik-base](https://github.com/barlito/traefik-base) stack (network `traefik_traefik_proxy`).
- Releases and prod deploys/rollbacks run through GitHub Actions (see [docs/DEPLOY.md](docs/DEPLOY.md)).
- Local: `https://second-brain.local.barlito.fr` (admin: `https://second-brain-admin.local.barlito.fr`). Prod: `https://second-brain.barlito.fr` (admin: `https://second-brain-admin.barlito.fr`; not deployed yet, see [docs/DEPLOY.md](docs/DEPLOY.md)).

## Architecture

Request path:

```
Traefik -> bearer auth (+ per-IP failure limiter) -> /mcp -> ACL check -> vault path safety -> git sync -> audit
```

1. Traefik terminates TLS (plain HTTP is redirected to HTTPS). Security headers apply in both local and prod; only the rate limit (20 avg / 40 burst per IP) is prod-only.
2. Bearer auth looks the token up by SHA-256 hash (only hashes are stored). After 10 failed attempts from one IP within 60 s, that IP gets `429` until the window ends (expired tokens get `401` but are not counted). The client IP comes from `X-Forwarded-For`, trusted only from the Traefik tasks (`TRUSTED_PROXY`).
3. `/mcp` builds a fresh MCP server per request (stateless).
4. The tool checks the token's scopes (space, project and section match exactly or via trailing `*` wildcards; `read`, `write` and `propose` are separate permissions). This runs before any filesystem access.
5. The path is resolved from validated slugs, re-checked against the vault root, and symlinks are refused.
6. Writes go through a single bounded queue: pull (rebase), atomic write, local commit; a background pusher then pushes (one push at a time, coalescing writes).
7. One audit row is written per tool call (`ok`, `denied` or `error`), including calls whose arguments fail schema validation, plus rows for HTTP-level errors, (coalesced) auth failures, admin actions and asynchronous sync conflicts.

## Vault layout and naming

```
<vault>/
  _inbox/             pending kb_propose proposals (<id>.md), see Proposals inbox
  <space>/            e.g. perso, pro, idees, meta
    <project>/
      <section>/
        <note>.md
```

`space`, `project`, `section` and `note` must each match `^[a-z0-9][a-z0-9-]{0,63}$` (lowercase letters, digits and hyphens; max 64 chars; no leading hyphen; no dots, slashes or spaces). The `.md` extension is added by the server. Anything else is rejected. `_inbox` fails the slug rule, so it can never be addressed as a space and is skipped by `kb_list`/`kb_search`.

Spaces are top-level areas (e.g. `perso`, `pro`, `idees`). A `meta` space is a suggested home for short notes on how the user works (preferences, conventions); the server does not treat it specially, the agent instructions just suggest reading it if the token allows.

### Reserved sections

Every project uses the same section names:

| Section | Purpose |
|---------|---------|
| `overview` | Entry note `index`: what the project is plus a map of its docs. Hard cap of 3 KB (3072 bytes, UTF-8) on `overview/index`, enforced for `kb_write`, `kb_append`, `kb_init_project`, `kb_propose`, inbox accept and web edit/create. |
| `decisions` | Why X was chosen: short ADR-style notes. |
| `conventions` | How things are done in this project. |
| `notes` | Everything else. |
| `journal` | Monthly notes named `YYYY-MM`, short entries, written with `kb_append`. |
| `archive` | Where `kb_archive` moves notes. Only `kb_archive` writes there: `kb_write`, `kb_append` and `kb_propose` on it fail with ``Section `archive` is managed by kb_archive and cannot be written directly.`` |

Only `archive` is enforced beyond the `overview/index` size cap; the other names are conventions (the server accepts any valid section slug).

### Server instructions

On connection the server sends MCP `instructions` describing this layout, the reserved sections, the session-start routine and the working rules (short notes, find notes with `kb_search`, `kb_history` for a note's git history, update the Docs map, archive instead of delete, `kb_propose` when unsure whether something deserves a note, re-read before overwriting). MCP clients that surface server instructions therefore get the conventions automatically; nothing needs to be configured per client.

## Tools

All note-addressed tools take `space`, `project`, `section`, `note` (strings, max 64 chars each, slug rules above). Each call needs the permission listed on the matching scope (see [Token management](#token-management)); `read`, `write` and `propose` are separate.

### `kb_read`

- Args: `space`, `project`, `section`, `note`; optional `tail` (integer 1-500).
- Permission: `read` on the section.
- Returns the note as text. With `tail`, only the last N lines (a trailing newline is not counted as a line). Use it for recent journal history.
- Errors: `Note not found.`; `Note is too large to read (<n> bytes, max 2097152).` (only for files that did not come through `kb_write`, e.g. pushed by a human).

### `kb_write`

- Args: the four names plus `content` (string, max 512 x 1024 = 524288 characters, not bytes; more is rejected with ``Invalid argument `content`: too large (max 512 KB).`` (every argument that fails validation gets an ``Invalid argument `<name>`: ...`` message and an audit row)). Written verbatim.
- Permission: `write` on the section.
- Creates or overwrites the note and returns the git commit SHA. Rewriting identical content makes no commit and returns `No changes (content identical).` Commit message: `kb_write: <space>/<project>/<section>/<note> via <token name>`.
- Errors: ``Section `archive` is managed by kb_archive and cannot be written directly.``; for `overview/index` over 3 KB: `overview/index is too large (<n> bytes, max 3072). The entry note must stay small: move detail into other sections (decisions, conventions, notes) and link to those notes from the Docs map.`
- Writes are direct and overwrite without merging: re-read before overwriting a note you did not just read.

### `kb_append`

- Args: the four names plus `entry` (string, 1-1000 characters).
- Permission: `write` on the section.
- Appends one line to the note (created if missing) and returns the commit SHA. The server formats the line, the client cannot: `- <YYYY-MM-DD HH:MM UTC> [<token name>] <entry>`. Line breaks and other control characters in `entry` are collapsed to single spaces, so an entry is always one line. The timestamp is taken inside the vault lock, so file order equals time order.
- Convention: section `journal`, note = current month `YYYY-MM` (e.g. `2026-11`), entries of 1-3 sentences (what was done and why); details belong in `notes`/`decisions`.
- Limits: the resulting note may not exceed 512 KB (524288 characters) and the `overview/index` 3 KB cap also applies.
- Errors: `Entry is empty.` (only whitespace/control characters); `Note is too large to append to (max 512 KB). Start a new note; for journals use one note per month (journal/YYYY-MM).`; the `archive` and entry-note-size errors above.

### `kb_archive`

- Args: `space`, `project`, `section`, `note` (the note to archive).
- Permission: `read` and `write` on the source section AND `write` on `<space>:<project>:archive` (read on the source is required so that archiving cannot be used to read a note through `archive`). A token scoped to a single section therefore cannot archive; a project-wide scope such as `space:project:*` can. If the archive write is missing the client gets `Permission denied.`. Reading an archived note afterwards needs `read` on `archive`.
- Moves `<space>/<project>/<section>/<note>` to `<space>/<project>/archive/<section>-<note>` (a `-2`, `-3`, ... suffix is appended if the name is taken, up to 50 tries; long names are truncated to stay a valid slug) and returns the new location, e.g. `pro/myproj/archive/notes-old-idea`. The move is a git commit, so history is kept.
- There is no delete tool: archive instead.
- Errors: `Note is already archived.` (section is `archive`); `The project entry note (overview/index) cannot be archived.`; `Note not found.`; `Note has uncommitted changes in the vault; commit or discard them first.`; `Too many archived notes with this name.`

### `kb_list`

- Args (all optional): `space`, `project`, `section`, `include_archived` (boolean, default false). A level requires the one above it, otherwise `Invalid arguments: project requires space, section requires project.`
- Permission: `read`; the deepest level you pass must be readable (else `Permission denied.`), and results are filtered to what the token can read.
- One level at a time: no args lists spaces; `space` lists projects; `space`+`project` lists sections; adding `section` lists notes as `name<TAB><n> bytes<TAB><ISO mtime>`. The `archive` section is hidden unless `include_archived` is true or `section` is explicitly `archive`. Empty results print `(empty)`. Dotfiles, symlinks and non-slug names are skipped.
- Cap: 500 entries, then `(truncated: showing the first 500 entries)`.

### `kb_search`

- Args: `query` (string, max 200 characters as sent, at least 2 after trimming; shorter gives `Query must be at least 2 characters.`), optional `space`, `project`, `section` (same hierarchy rule as `kb_list`), `include_archived` (default false).
- Permission: `read`. Only sections the token can read are opened: the ACL is applied before any directory or file is read.
- Case-insensitive plain substring match (not regex, no ranking) per line. Output lines are `<space>/<project>/<section>/<note>: <snippet>`; up to 50 notes and 3 lines per note, each snippet at most 200 characters around the match. No hits prints `No matches.`
- Limits: files over 1 MB are skipped; stops after 3 s, 20 MB read or 5000 notes scanned. When it stops early the output ends with `(truncated: <reason>; results may be incomplete, narrow the search)`, where reason is `time limit reached`, `read limit reached`, `too many notes` or `more notes match` (more than 50 notes hit). Unreadable and oversized entries are counted in `(skipped <n> unreadable or oversized entries)`. Narrow with `space`/`project`/`section` when truncated.

### `kb_history`

- Args: `space`, `project`, `section`, `note`; optional `limit` (integer 1-100, default 20).
- Permission: `read` on the section.
- Git history of the note, newest first, following renames (e.g. an archive move). First line `path: <space>/<project>/<section>/<note>.md`, with ` (no longer at this path)` appended if the note is gone (e.g. archived); then one line per commit: `<short sha> <ISO date> <subject>`.
- `(no commits yet)` when there is no history. History stops at the first older path the token cannot read and then ends with `(earlier history not accessible with this token)`.
- Errors: `Note not found.` (no file and no history).

### `kb_init_project`

- Args: `space`, `project`, `summary` (string, trimmed, 1-500 characters).
- Permission: `write` on `<space>:<project>:overview`.
- Creates `<space>/<project>/overview/index` from a template (title, summary, a `Docs map` listing the other reserved sections) and returns the commit SHA.
- Refuses if the entry note already exists: `Entry note already exists — edit it with kb_write.`

### `kb_propose`

- Args: the four names (the target note), `content` (string, max 524288 characters, as `kb_write`) and `reason` (string, trimmed, 1-500 characters; schema messages `reason must not be empty` / `reason too long (max 500 characters)`).
- Permission: `propose` OR `write` on the target section.
- Does not touch the target. Writes `_inbox/<id>.md` (YAML frontmatter `target`, `proposed_by` (token name), `reason`, `created`, then the content) as a commit `kb_propose: <space>/<project>/<section>/<note> via <token name>` and returns the id, `YYYYMMDDTHHMMSSZ-<6 hex>`. A human then accepts or rejects it (see [Proposals inbox](#proposals-inbox)).
- Quotas: at most 20 pending proposals per token name and 200 in total (`INBOX_MAX_PER_TOKEN`, `INBOX_MAX_TOTAL`).
- Errors: the `archive` and entry-note-size errors above; `Proposal too large (max 576 KiB as UTF-8 including metadata).`; `Too many pending proposals. Ask the user to review the inbox.` (quota).

### Typical agent session

```
kb_read   pro/myproj/overview/index                       # what is this project, docs map
kb_list   pro/myproj/journal                              # find the latest month note
kb_read   pro/myproj/journal/2026-11  tail=30             # recent history
...work, using kb_search / kb_read as needed...
kb_append pro/myproj/journal/2026-11  entry="Switched the queue to X because Y."
kb_write  pro/myproj/decisions/queue-choice  content=...  # durable "why" as its own note
```

(Written as `space/project/section/note` for brevity; the tools take them as separate arguments.)

### Client-facing errors

Returned with `isError: true`:

| Message | Cause |
|---------|-------|
| `Permission denied.` | Token has no scope covering that space/project/section/permission. Deliberately does not reveal whether the project exists. |
| `Note not found.` | `kb_read`, `kb_archive` or `kb_history` on a missing note. |
| `Invalid space/project/section/note name.` | A name does not match the slug rules. |
| `Path not allowed.` | Path-safety check failed (escape from the vault root, symlink, not a regular file). |
| `Vault is busy, retry in a moment.` | A human (or other git process) is using the vault repo: a rebase in progress or a recent `index.lock`. Retry. |
| `Conflict: this note was changed remotely. Your version was saved on branch <conflict/...>. Re-read the note and retry.` | See [Git sync](#git-sync). |
| `Conflict: ... Your version was saved on branch (none). ...` | Uncommitted human changes in the vault conflicted with the remote and were put in `git stash`. See [Git sync](#git-sync). |
| `Proposal too large (max 576 KiB as UTF-8 including metadata).` | `kb_propose`: the proposal file (frontmatter + content) would exceed 576 KiB. |
| `Too many pending proposals. Ask the user to review the inbox.` | `kb_propose`: per-token or total inbox quota reached. |
| `Internal error.` | Anything else. Details are in the server log and the audit row only. |

Tool-specific messages are listed under each tool. HTTP-level: `401` (missing/invalid/revoked/expired token), `429` (too many failed auths), `503` (shutting down), `405` for `GET /mcp` and `DELETE /mcp`, `413` (request body over 1 MB) and `400` (malformed JSON, or a JSON-RPC batch of more than 10 messages). The `405`, `413`, `400`, `429` and `/mcp` `503` responses are JSON-RPC errors; `401` is `{"error": "<reason>"}` (an expired token gets `{"error":"token expired"}` and does not count toward the `429` limiter).

## Token management

Tokens are managed with `make` targets that run a CLI inside the running service container (so the stack must be deployed), or from the [web admin UI](#web-admin-ui).

```bash
make token-create name=claude-code scope=pro:myproj:notes:read,pro:myproj:notes:write
make token-create name=me preset=master allow_wildcard=1        # read+write on *:*:*
make token-create name=viewer preset=master-ro allow_wildcard=1 # read on *:*:*
make token-create name=ci scope=pro:myproj:notes:read expires_in_days=30
make token-list
make token-revoke id=<token id>
```

- Scope format (4 parts): `space:project:section:permission`, comma-separated. `permission` is `read`, `write` or `propose`. `space`, `project` and `section` follow the slug rules.
- Wildcards: `*` is allowed only as trailing levels: `*:*:*`, `<space>:*:*`, `<space>:<project>:*`, or fully explicit. Patterns like `*:proj:sec` or `space:*:sec` are rejected. A token may hold scopes in several spaces.
- `read`, `write` and `propose` are separate: `write` does not imply `read`. Grant both if you want both. `propose` only allows `kb_propose` (which `write` also allows); a propose-only token cannot change notes.
- Presets: `preset=master` (read+write on `*:*:*`) and `preset=master-ro` (read on `*:*:*`). Use either `preset=` or `scope=`, not both (the CLI rejects the combination).
- Wildcard scopes and presets are refused unless `allow_wildcard=1` (CLI: `--allow-wildcard`). Before creating the token the CLI prints to stderr what it can read/write (including content created later). Prefer explicit scopes unless you need a master token.
- Scopes already covered by a wildcard scope of the same permission (e.g. `pro:x:y:read` next to `*:*:*:read`) are dropped at creation; the CLI says which on stderr.
- Wildcards are also enforced at match time: a stored scope with a non-`*` level after a `*` (e.g. inserted by hand) matches nothing and logs a warning.
- Expiry (optional): `expires_in_days=N` (CLI: `--expires-in-days N`), integer 1-3650. Without it the token never expires. An expired token gets `401` `{"error":"token expired"}`, which does not count toward the auth-failure `429` limiter.
- Upgrade note: scopes created before spaces existed are migrated to the sentinel space `!legacy`. `!` is not valid in a slug, so no token scope, tool argument or vault path can ever equal it: those tokens grant nothing until re-issued with 4-part scopes. (An earlier build used `legacy`, a valid slug; migration 4 renames such rows to `!legacy`.)
- The plaintext token (`sb_...`) is printed once at creation and cannot be recovered. Only its hash is stored. If lost, revoke and create a new one.
- `token-list` shows id, name, created/revoked/last-used timestamps, `expires_at` (`-` if none, suffixed ` (EXPIRED)` once past) and scopes (4-part format).

## Proposals inbox

`kb_propose` writes pending proposals to `_inbox/<id>.md` in the vault. Review them with `make` targets (a CLI inside the service container that talks to the server's local admin listener on `127.0.0.1:ADMIN_PORT`, so accept/reject share the server's write lock) or in the [web admin UI](#web-admin-ui):

```bash
make inbox-list                          # id, target, proposer, size, reason
make inbox-show id=<id>
make inbox-accept id=<id> [overwrite=1]  # write the content to the target note, remove the proposal
make inbox-reject id=<id>                # remove the proposal
```

- Accept applies the `kb_write` rules (valid target slugs, `archive` refused, 512 KB content, `overview/index` 3 KB cap) and refuses an existing target unless `overwrite=1` (`target note already exists (use overwrite)`). Accept and reject are single commits: `inbox accept: <target> (proposed by <token name>)`, `inbox reject: <target> (proposed by <token name>)`.
- Audit actions `inbox_accept`/`inbox_reject`, actor `admin-cli` (CLI) or `admin:<user>` (web).

## Web admin UI

`https://second-brain-admin.local.barlito.fr` (local), `https://second-brain-admin.barlito.fr` (prod). Served by the same process on `ADMIN_WEB_PORT` (3002), behind Traefik and Authelia.

- Dashboard: DB/vault/sync status, unpushed commits, last push, conflict branches, active tokens, pending proposals, audit rows in the last 24 h.
- Tokens: list (expiry, active/expired/revoked); create with a preset or scopes (one per line), the wildcard confirmation and an optional expiry; the plaintext is shown once on a one-time page; revoke. Audit actions `admin_token_create`/`admin_token_revoke`, actor `admin:<user>`.
- Inbox: list, view a proposal rendered or raw, accept (optionally overwriting) or reject.
- Vault browser: browse spaces/projects/sections/notes, view, edit (optimistic concurrency: the form carries a hash of the version it loaded; if the note changed meanwhile the save is refused with a conflict instead of overwriting), create, archive, history, and view a note at a past commit. Archived notes are read-only. Writes go through the same write lock as the tools; commits `web: edit|create|archive <space>/<project>/<section>/<note> by <user>`; audit actions `web_note_create`/`web_note_edit`/`web_note_archive`, actor `web:<user>`.
- Audit viewer: read-only, newest first, 50 rows per page, exact-match filters on token name and action.

Trust model:

- The direct peer must be in `TRUSTED_PROXY` and send `X-SB-Admin-Proxy` equal to `ADMIN_PROXY_SECRET` (Traefik sets it after Authelia, overwriting any client value). Only then are `Remote-User`/`Remote-Groups` believed; otherwise `401`.
- The user must be in `ADMIN_GROUP` (default `admins`, from `Remote-Groups`), else `403`.
- Every POST needs a same-host `Origin`/`Referer`, a CSRF token bound to the user and the Authelia session cookie (`AUTHELIA_SESSION_COOKIE`, keyed by `ADMIN_WEB_SECRET`) and a one-time form nonce (a replay gets `409`).
- Strict CSP (`default-src 'self'`, no inline scripts/styles, `frame-ancestors 'none'`), `X-Frame-Options: DENY`, `Cache-Control: no-store`.
- The listener does not start (logged; the MCP server keeps running) without `TRUSTED_PROXY` or with an `ADMIN_PROXY_SECRET` shorter than 32 characters.

Prerequisites: the traefik-base `authelia-auth@file` forwardAuth middleware (passing `Remote-User`/`Remote-Groups`), and `openssl` on the machine running `make deploy` (it generates the secrets). Prod setup: [docs/DEPLOY.md](docs/DEPLOY.md).

## Upgrading from the 3-level layout

Before spaces, notes lived at `<project>/<section>/<note>.md`; they are now `<space>/<project>/<section>/<note>.md`, so old notes are unreachable until moved. In the vault repo, for each project:

```bash
mkdir -p <space> && git mv <project> <space>/<project>
git commit -m "Move <project> under space <space>" && git push
```

Then re-issue tokens with 4-part scopes (old tokens were migrated to the unmatchable space `!legacy` and grant nothing) and revoke the old ones.

## Configuring a Claude Code client

Add an HTTP MCP server with the token in an `Authorization` header:

```bash
claude mcp add --transport http second-brain https://second-brain.barlito.fr/mcp \
  --header "Authorization: Bearer sb_xxxxxxxx"
```

This is the recommended way: the default local scope keeps the token out of the repo. Alternatively, a `.mcp.json` entry (Claude Code expands environment variables there, so export `SECOND_BRAIN_TOKEN` first):

```json
{
  "mcpServers": {
    "second-brain": {
      "type": "http",
      "url": "https://second-brain.barlito.fr/mcp",
      "headers": { "Authorization": "Bearer ${SECOND_BRAIN_TOKEN}" }
    }
  }
}
```

Use `https://second-brain.local.barlito.fr/mcp` for the local stack. Never commit real tokens. This is the generic format; check the current Claude Code MCP docs if the CLI flags change.

## Local development

Prerequisites:

- Docker with Swarm initialised (`docker swarm init`).
- The [traefik-base](https://github.com/barlito/traefik-base) stack deployed (provides network `traefik_traefik_proxy`, TLS, the `security-headers`/`redirect-to-https` middlewares and `authelia-auth` for the web admin).
- `openssl` (`make deploy` uses it to generate the admin secrets).
- DNS resolving `*.local.barlito.fr` to your machine.
- `../second-brain-vault-dev` (sibling of this repo): an existing git repo or an empty directory (the server runs `git init` on it). A non-empty directory that is not a git repo is refused. It is bind-mounted as `/vault` and needs no remote.

Commands:

```bash
make deploy      # generate admin secrets once (data/admin-*-secret), build image (unique local-<sha>-<ts> tag), deploy, prune old local images
make logs        # follow service logs
make undeploy    # remove the stack
make restart     # undeploy, then deploy
make help        # list all targets
```

Locally the container runs as your uid/gid (so it can write to the bind-mounted vault) and SQLite lives in `./data` (git-ignored).

Tests need Node 24. If the host has no Node, run them in a container (CI runs `npm ci`, `npm test`, `npm run build` on Node 24 with a git identity configured):

```bash
docker run --rm -v "$PWD":/app -w /app node:24-alpine sh -c \
  'apk add --no-cache git >/dev/null \
   && git config --global user.name ci && git config --global user.email ci@noreply.local \
   && npm ci && npm test && npm run build'
```

Running it leaves root-owned `node_modules/` and `dist/` in the checkout; remove them with a throwaway container: `docker run --rm -v "$PWD":/w alpine rm -rf /w/node_modules /w/dist`. In a git worktree, also mount the main repo (the worktree's `.git` file points into it) so git works inside the container.

CI also runs `docker build .` and validates both compose files with `docker compose config -q`.

## Health endpoints

| Endpoint | Auth | Response |
|----------|------|----------|
| `GET /health` | none | `{"status":"ok"}` (200) or `{"status":"error"}` (503). Checks only the DB and that the vault is a git repo. Sync trouble never fails it, so network blips do not restart-loop the container. Used by the Docker `HEALTHCHECK`. |
| `GET /health/details` | any valid token | `status` (`ok`/`degraded`/`error`), `db`, `vault`, and `sync` (`hasRemote`, `branch`, `unpushed`, `lastPushOk`, `conflicts`, `conflictBranches`). `degraded` means the last push failed or local `conflict/*` branches exist (delete them in the vault working copy once resolved to clear it). |

```bash
curl -H "Authorization: Bearer $TOKEN" https://second-brain.local.barlito.fr/health/details
```

## Maintenance

```bash
make backup-db                 # consistent SQLite backup to /data/backups/acl-<UTC timestamp>.db (inside the container)
make prune-audit days=90       # delete audit rows older than 90 days (0-36500)
```

Backups live on the `/data` volume (`./data/backups` locally, the `acl-data` volume in prod). Copy them off-host yourself; there is no automation yet (see [docs/DEPLOY.md](docs/DEPLOY.md)).

Release, deploy, rollback and DB restore operator targets (`deploy.prod`, `db.backup`, `db.restore`, ...) are described in [docs/DEPLOY.md](docs/DEPLOY.md).

## Git sync

- Every write (`kb_write`, `kb_append`, `kb_archive`, `kb_init_project`, `kb_propose`, inbox accept/reject, web edit/create/archive) goes through the same locked path: it pulls (rebase) first, writes atomically and commits locally, and returns; a single background pusher then pushes (with retries), so a slow or dead remote never holds up later writes. If the remote is unreachable, writes still commit locally; after a network error the pre-write pull is skipped for 60 s and the push is retried later. At most `VAULT_WRITE_QUEUE_MAX` writes (default 50) may wait for the lock; beyond that a write fails at once with `Vault is busy, retry in a moment.`
- A periodic sync (every `VAULT_SYNC_INTERVAL_MS`, default 60 s; `0` disables it) pulls remote changes and pushes leftover local commits.
- With no `VAULT_REMOTE_URL` the vault is a local-only repo (the local-dev case).
- Conflict (before the write): if the remote changed the same note(s) as unsynced local work and this is detected during the pull that precedes a write, the full local state is saved on a backup branch `conflict/<timestamp>` (pushed best-effort), the working branch is reset to the remote, and each unsynced local commit is re-applied in order: only the commits that actually conflict stay parked on the backup branch (if none do, the branch is deleted). The triggering write fails with a `Conflict: ...` message naming the conflicting note(s) (paths the token cannot read are only counted) and saying it was not applied. Re-read the note and retry. Every such conflict gets a `sync_conflict` audit row listing the parked commits.
- Conflict (uncommitted human changes): if uncommitted changes in the vault conflict with remote changes, they are kept in `git stash` and the client message says so. Recover with `git stash list` (and `git stash show`/`apply`) in the vault.
- Known limitation, asynchronous conflicts: a conflict detected later, during a push-retry pull or a periodic sync, can park a write that was already acknowledged (its SHA was returned) on a `conflict/<timestamp>` branch (non-conflicting commits are re-applied as above). The client is not told. Notice it via `/health/details` (`sync.conflicts`, `sync.conflictBranches`), the web admin dashboard, a `sync_conflict` audit row (token `git-sync`), `SYNC CONFLICT` in the server logs, or a `conflict/*` branch on the remote.
- A human's in-progress git operation is not touched: a rebase the server did not start, or an `index.lock` younger than 10 minutes, makes writes fail with `Vault is busy`. The server aborts only rebases it started (it leaves a marker), removes an `index.lock` left by its own interrupted operation at startup (marker), and treats any `index.lock` older than 10 minutes as stale and removes it regardless of owner.
- On shutdown, in-flight requests and queued writes are drained (up to 25 s), including a final push attempt; pushes still pending when the budget runs out are aborted and retried by the next sync.

## Environment variables

Compose sets these; no `.env` file is needed, except that both compose files require `ADMIN_PROXY_SECRET` and `ADMIN_WEB_SECRET` in the environment (local `make deploy` generates and reuses them in `data/`; prod deploys read them from GitHub secrets, see [docs/DEPLOY.md](docs/DEPLOY.md)). [.env.example](.env.example) documents the variables for running outside Docker.

| Variable | Purpose | Default | Local compose | Prod compose |
|----------|---------|---------|---------------|--------------|
| `VAULT_PATH` | Vault git repo directory. Required (server exits without it). | none | `/vault` | `/vault` |
| `DB_PATH` | SQLite ACL/audit database file. Required: the server and CLIs refuse to start without it. | none | `/data/acl.db` | `/data/acl.db` |
| `PORT` | HTTP listen port. | `3000` | `3000` | `3000` |
| `VAULT_REMOTE_URL` | Git remote to clone/push. Empty means local-only vault. | empty | unset | `git@github.com:barlito/second-brain-vault.git` |
| `VAULT_BRANCH` | Branch to track. | `main` | `main` | `main` |
| `VAULT_SYNC_INTERVAL_MS` | Periodic sync interval; `0` disables. | `60000` | `60000` | `60000` |
| `TRUSTED_PROXY` | Comma-separated hostnames, IPs or CIDRs allowed to set `X-Forwarded-For` (hostnames re-resolved every 60 s); empty trusts nobody (client IP = socket address). Also required for the web admin. | empty | `tasks.traefik_traefik` | `tasks.traefik_traefik` |
| `ADMIN_PORT` | Local admin listener (inbox CLI), bound to `127.0.0.1`. | `3001` | unset | unset |
| `ADMIN_WEB_PORT` | Web admin UI listener. | `3002` | `3002` | `3002` |
| `ADMIN_GROUP` | Authelia group (`Remote-Groups`) allowed into the web admin. | `admins` | `admins` | `admins` |
| `ADMIN_PROXY_SECRET` | Value Traefik injects as `X-SB-Admin-Proxy`; at least 32 characters, otherwise the web admin is disabled. | none | generated by `make deploy` | required (GitHub secret) |
| `ADMIN_WEB_SECRET` | CSRF key for the web admin; if unset, random per boot (open forms break on restart). | random | generated by `make deploy` | required (GitHub secret) |
| `AUTHELIA_SESSION_COOKIE` | Authelia session cookie name the CSRF token is bound to. | `authelia_session` | `authelia_session_local` | unset |
| `INBOX_MAX_PER_TOKEN`, `INBOX_MAX_TOTAL` | `kb_propose` quotas: pending proposals per token name / in total. | `20` / `200` | unset | unset |
| `GIT_SSH_COMMAND` | SSH command for git; points at the deploy key secret. | unset | unset | `ssh -i /run/secrets/vault_deploy_key -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10` |
| `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL` | Git identity (git refuses to commit without one). | none | `second-brain-mcp` / `second-brain-mcp@noreply.local` | same |
| `NODE_ENV` | Node mode. | `production` (set in the Dockerfile) | `development` | `production` |
| `VAULT_WRITE_QUEUE_MAX` | Max client writes waiting for the vault lock before new ones get `Vault is busy`. | `50` | unset | unset |
| `SB_PUSH_DEADLINE_MS` | Overall push deadline including retries (test override). | `150000` | unset | unset |
| `HOST_UID`, `HOST_GID` | Compose-time only (local): container user, set by `make deploy` to your uid/gid. | n/a | auto | unused |
| `TAG` / `IMAGE_TAG` | Compose-time only: image tag. Prod compose uses `TAG` (`make deploy.prod TAG=<tag>`, required); local `make deploy` sets `IMAGE_TAG` to a unique local one. | n/a | auto | required |

## Security notes

Hardened:

- Tokens are random (256-bit), stored only as SHA-256 hashes, shown once, individually revocable.
- Optional token expiry.
- Per-IP auth-failure limiter; audit of every tool call, admin action and auth failure; Traefik rate limit in prod, security headers in both.
- Web admin only behind Traefik + Authelia (trusted peer + proxy secret + group), with CSRF, one-time nonces and a strict CSP.
- Strict slug validation, path re-check against the vault root, symlinks refused; body and note size limits.
- Clients only see generic errors; real reasons go to the audit log and server log with credentials redacted.
- Container runs as non-root (uid 10001) under `tini`; base image pinned by digest; GitHub SSH host keys are vendored and fingerprint-verified at build time, and prod uses `StrictHostKeyChecking=yes`; the vault deploy key is a Docker secret.
- Plain HTTP never serves `/mcp` (redirected to HTTPS).

Deliberate limits:

- Wildcards are trailing-only (`*:*:*`, `space:*:*`, `space:project:*`) and `write` does not imply `read`; `propose` grants only `kb_propose`.
- Names are strict slugs (no uppercase, dots, spaces or nested folders).
- Single replica: one git working tree and one SQLite file, so tasks must never overlap (`stop-first` updates).
- The auth-failure limiter state is in memory (reset on restart).
