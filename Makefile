.DEFAULT_GOAL := help
.PHONY: help deploy deploy.prod undeploy restart logs token-create token-list token-revoke backup-db prune-audit

stack_name=second-brain-mcp
service=second-brain-mcp
svc_full=$(stack_name)_second-brain-mcp

# Runs the local container as the host user instead of the image's appuser,
# so it can read/write the bind-mounted vault (host-owned, different uid).
export HOST_UID := $(shell id -u)
export HOST_GID := $(shell id -g)

# Running task container of the service (exact service label, not a name substring).
# Evaluated lazily; fails the recipe with a clear message if none is running.
container = $$(c=$$(docker ps -q --filter label=com.docker.swarm.service.name=$(svc_full) | head -n1); \
  [ -n "$$c" ] || { echo "no running container for service $(svc_full)" >&2; exit 1; }; echo $$c)

help: ## Show this help
	@echo "second-brain-mcp — available commands:"
	@grep -E '^[a-zA-Z_.-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

deploy: ## Build the image and deploy the stack locally (Swarm)
	mkdir -p data
	docker compose build
	docker compose config | sed '/^name:/d; s/published: "\([0-9]*\)"/published: \1/g; s/mode: "\([0-9]*\)"/mode: \1/g' | docker stack deploy -c - $(stack_name)
	@# Swarm doesn't roll a service when the tag is unchanged: force it onto the fresh image.
	docker service update --force --image second-brain-mcp:local $(svc_full)

deploy.prod: ## Deploy to prod (make deploy.prod IMAGE_TAG=<tag>; image must be published)
	@test -n "$(IMAGE_TAG)" || { echo "IMAGE_TAG is required (make deploy.prod IMAGE_TAG=<tag>)" >&2; exit 1; }
	IMAGE_TAG="$(IMAGE_TAG)" docker compose -f docker-compose-prod.yml config | sed '/^name:/d; s/published: "\([0-9]*\)"/published: \1/g; s/mode: "\([0-9]*\)"/mode: \1/g' | docker stack deploy --with-registry-auth -c - $(stack_name)

undeploy: ## Remove the stack
	docker stack rm $(stack_name)

restart: ## Restart (undeploy then deploy)
	$(MAKE) undeploy
	sleep 5
	$(MAKE) deploy

logs: ## Follow logs (make logs service=second-brain-mcp)
	docker service logs -f "$(stack_name)_$(service)"

token-create: ## Create a token (make token-create name=X scope=project:section:perm,...)
	docker exec $(container) node dist/cli/token.js create --name "$(name)" --scope "$(scope)"

token-list: ## List tokens
	docker exec $(container) node dist/cli/token.js list

token-revoke: ## Revoke a token (make token-revoke id=X)
	docker exec $(container) node dist/cli/token.js revoke --id "$(id)"

backup-db: ## Consistent SQLite backup to /data/backups/acl-<UTC timestamp>.db
	docker exec $(container) node dist/cli/maintenance.js backup "/data/backups/acl-$$(date -u +%Y%m%dT%H%M%SZ).db"

prune-audit: ## Delete audit rows older than N days (make prune-audit days=90)
	@test -n "$(days)" || { echo "days is required (make prune-audit days=90)" >&2; exit 1; }
	docker exec $(container) node dist/cli/maintenance.js prune-audit --days "$(days)"
