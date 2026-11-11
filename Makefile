.DEFAULT_GOAL := help
.PHONY: help deploy deploy.prod prune-local-images undeploy restart logs token-create token-list token-revoke backup-db prune-audit

stack_name=second-brain-mcp
service=second-brain-mcp
svc_full=$(stack_name)_second-brain-mcp

# Runs the local container as the host user instead of the image's appuser,
# so it can read/write the bind-mounted vault (host-owned, different uid).
export HOST_UID := $(shell id -u)
export HOST_GID := $(shell id -g)

# pipefail so a failing `compose config` aborts the deploy pipeline.
SHELL := bash
.SHELLFLAGS := -o pipefail -ec

# Unique tag per build: `docker stack deploy` then rolls the service by itself
# (Swarm ignores same-tag rebuilds). Fixed once per make run.
ifndef LOCAL_TAG
LOCAL_TAG := local-$(shell git rev-parse --short HEAD 2>/dev/null || echo nogit)-$(shell date +%s)
endif
KEEP_LOCAL_IMAGES ?= 3

# $(1): extra compose args, $(2): extra stack deploy args.
# sed: drop top-level `name:` and unquote secret `mode:` (stack schema wants a
# number; Compose v5 renders it as a string and `docker stack config` rejects it).
define stack_deploy
docker compose $(1) config | sed '/^name:/d; s/mode: "\([0-9]*\)"/mode: \1/g' | docker stack deploy $(2) -c - $(stack_name)
endef

# $(1): command to run inside the running service container.
# The guard runs in the recipe shell (an `exit` inside $(...) would not stop it).
define exec_in_service
cid=$$(docker ps -q --filter label=com.docker.swarm.service.name=$(svc_full) | head -n1); \
[ -n "$$cid" ] || { echo "$(svc_full) is not running (make deploy first)" >&2; exit 1; }; \
docker exec "$$cid" $(1)
endef

help: ## Show this help
	@echo "second-brain-mcp — available commands:"
	@grep -E '^[a-zA-Z_.-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

deploy: export IMAGE_TAG := $(LOCAL_TAG)
deploy: ## Build the image and deploy the stack locally (Swarm)
	mkdir -p data
	docker compose build
	$(call stack_deploy,,)
	$(MAKE) prune-local-images

deploy.prod: ## Deploy to prod (make deploy.prod IMAGE_TAG=<tag>; image must be published)
	@test -n "$(IMAGE_TAG)" || { echo "IMAGE_TAG is required (make deploy.prod IMAGE_TAG=<tag>)" >&2; exit 1; }
	$(call stack_deploy,-f docker-compose-prod.yml,--with-registry-auth)

prune-local-images: ## Remove old second-brain-mcp:local-* images (keep the newest 3)
	@# `docker image ls` lists newest first; images still in use fail to delete and are skipped.
	docker image ls second-brain-mcp --format '{{.Tag}}' | { grep '^local-' || true; } | tail -n +$$(($(KEEP_LOCAL_IMAGES)+1)) \
	  | xargs -r -I{} docker rmi second-brain-mcp:{} || true

undeploy: ## Remove the stack
	docker stack rm $(stack_name)

restart: ## Restart (undeploy then deploy)
	$(MAKE) undeploy
	sleep 5
	$(MAKE) deploy

logs: ## Follow logs (make logs service=second-brain-mcp)
	docker service logs -f "$(stack_name)_$(service)"

token-create: ## Create a token (make token-create name=X preset=master|master-ro  OR  scope=space:project:section:perm,...)
	@$(call exec_in_service,node dist/cli/token.js create --name "$(name)" $(if $(preset),--preset "$(preset)",--scope "$(scope)"))

token-list: ## List tokens
	@$(call exec_in_service,node dist/cli/token.js list)

token-revoke: ## Revoke a token (make token-revoke id=X)
	@$(call exec_in_service,node dist/cli/token.js revoke --id "$(id)")

backup-db: ## Consistent SQLite backup to /data/backups/acl-<UTC timestamp>.db
	@$(call exec_in_service,node dist/cli/maintenance.js backup "/data/backups/acl-$$(date -u +%Y%m%dT%H%M%SZ).db")

prune-audit: ## Delete audit rows older than N days (make prune-audit days=90)
	@test -n "$(days)" || { echo "days is required (make prune-audit days=90)" >&2; exit 1; }
	@$(call exec_in_service,node dist/cli/maintenance.js prune-audit --days "$(days)")
