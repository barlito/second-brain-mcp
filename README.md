# second-brain-mcp

MCP server exposing a shared knowledge base (Obsidian-compatible git vault) that Claude can read and write across projects, with per-project/per-section access-controlled tokens.

Status: scaffolding phase. This PR sets up the Node.js/TypeScript project, Docker build, and a basic health check — no MCP tools, SQLite/ACL, or git-sync logic yet.

## Local dev quickstart

Local dev runs in Docker Swarm, exactly like production — this matches how every other app in this setup is run (see `traefik-base`, `affine`, etc.): a single node Swarm cluster, apps deployed via `docker stack deploy`, routed through a shared Traefik stack. No `.env` file is needed: the local domain (`second-brain.local.barlito.fr`) and Traefik options are hardcoded in `docker-compose.yaml`, and `*.local.barlito.fr` already resolves to `127.0.0.1` on this network.

Requires Docker Swarm to be initialized (`docker swarm init`) and the shared `traefik_traefik_proxy` overlay network to exist (provided by the `traefik-base` stack, deployed separately).

```bash
make deploy
curl -sk https://second-brain.local.barlito.fr/health
# => {"status":"ok"}
make logs service=second-brain-mcp
make undeploy
```

`docker stack deploy` doesn't build images, so `make deploy` runs `docker compose build` first to produce the `second-brain-mcp:local` image tag that `docker-compose.yaml` references — no registry needed for a single-node Swarm.

`docker-compose.yaml` bind-mounts `../second-brain-vault-dev` into the container at `/vault`, so that directory must exist as a sibling of this repo on your machine. The SQLite ACL database lives in a named volume (`acl-data`).

Run `make help` to see all available commands.

## Production deployment

`docker-compose-prod.yml` mirrors the local file's structure but targets the real domain (`second-brain.barlito.fr`), adds the Let's Encrypt cert resolver and HTTP→HTTPS redirect middleware, and references a published image (`ghcr.io/barlito/second-brain-mcp:latest`) instead of a local `build:`. **It is a structural placeholder, not deployable yet** — no CI/CD pipeline currently publishes that image to a registry. Once that pipeline exists, production deployment follows the same pattern as local: `make deploy.prod`.
