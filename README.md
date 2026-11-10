# second-brain-mcp

MCP server exposing a shared knowledge base (Obsidian-compatible git vault) that Claude can read and write across projects, with per-project/per-section access-controlled tokens.

Status: scaffolding phase. This PR sets up the Node.js/TypeScript project, Docker build, and a basic health check — no MCP tools, SQLite/ACL, or git-sync logic yet.

## Local dev quickstart

No `.env` file is needed for local dev: `docker-compose.override.yml` is auto-applied by Docker Compose and removes the Traefik/network dependency, publishing the port directly instead. (`.env.example` only documents the variables needed for the production compose file — see below.)

```bash
make up
curl http://localhost:3000/health
# => {"status":"ok"}
make down
```

The local override bind-mounts `../second-brain-vault-dev` into the container at `/vault`, so that directory must exist as a sibling of this repo on your machine.

Run `make help` to see all available commands.

## Production deployment

`docker-compose.yml` is the production file (Traefik labels, external network, GitHub Actions CI/CD, etc.) and is meant to run on the VPS, not locally. That full deployment pipeline is a later phase and is not implemented yet.
