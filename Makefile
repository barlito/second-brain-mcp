.DEFAULT_GOAL := help
.PHONY: help deploy deploy.prod db.backup db.restore docker.service.update deploy.assert_image smoke.test deploy.pruneprune-local-images undeploy restart logs token-create token-list token-revoke backup-db prune-audit inbox-list inbox-show inbox-accept inbox-reject

stack_name=second-brain-mcp
service=second-brain-mcp
svc_full=$(stack_name)_second-brain-mcp
image_name=barlito/second-brain-mcp
prod_host=second-brain.barlito.fr
assert_timeout=180
assert_settle=10

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
	@# Admin web secrets: generated once (0600, data/ is gitignored), reused on every deploy.
	@umask 077; for f in admin-proxy-secret admin-web-secret; do [ -s data/$$f ] || openssl rand -hex 32 > data/$$f; chmod 600 data/$$f; done
	export ADMIN_PROXY_SECRET=$$(cat data/admin-proxy-secret) ADMIN_WEB_SECRET=$$(cat data/admin-web-secret); \
	  docker compose build && $(call stack_deploy,,)
	$(MAKE) prune-local-images

# Rolling stack deploy (never `stack rm`: a recreated service has nothing to roll back to).
# Needs TAG + ADMIN_PROXY_SECRET + ADMIN_WEB_SECRET in the env; the image must be published.
deploy.prod: ## Deploy the whole prod stack (TAG=<release tag>): backup, stack deploy, assert, smoke, prune
	@test -n "$(TAG)" || { echo "TAG is required (TAG=<tag> make deploy.prod)" >&2; exit 1; }
	$(MAKE) db.backup
	$(call stack_deploy,-f docker-compose-prod.yml,--with-registry-auth)
	$(MAKE) deploy.assert_image
	$(MAKE) smoke.test
	$(MAKE) deploy.prune

# Skipped silently when the service has no running task (first deploy).
db.backup: ## Backup the DB if the service is running (skipped on first deploy)
	@if docker ps -q --filter label=com.docker.swarm.service.name=$(svc_full) | grep -q .; then \
	  $(MAKE) --no-print-directory backup-db; \
	else \
	  echo "no running $(svc_full) task, backup skipped (first deploy?)"; \
	fi

# Replaces acl.db with /data/backups/<file>. The service must be scaled to 0 first; the current DB
# is kept as acl.db.pre-restore-<ts>. Runs a one-off container of the target image on the volume.
db.restore: ## Restore a DB backup (TAG=<image tag> file=acl-<ts>.db); service must be scaled to 0
	@test -n "$(TAG)" -a -n "$(file)" || { echo "usage: make db.restore TAG=<tag> file=acl-<ts>.db" >&2; exit 1; }
	@case "$(file)" in */*) echo "file must be a bare backup filename" >&2; exit 1;; esac
	@! docker ps -q --filter label=com.docker.swarm.service.name=$(svc_full) | grep -q . \
	  || { echo "$(svc_full) is still running: scale it to 0 first" >&2; exit 1; }
	docker run --rm --entrypoint sh -v $(stack_name)_acl-data:/data $(image_name):$(TAG) -ec \
	  'test -f "/data/backups/$(file)"; ts=$$(date -u +%Y%m%dT%H%M%SZ); \
	   [ ! -f /data/acl.db ] || cp /data/acl.db "/data/acl.db.pre-restore-$$ts"; \
	   rm -f /data/acl.db-wal /data/acl.db-shm; cp "/data/backups/$(file)" /data/acl.db; echo "restored $(file)"'

docker.service.update: ## docker service update with registry auth (args="--image <img> <service>")
	docker service update --with-registry-auth $(args)

# Swarm rollbacks exit 0: fail unless the service really runs $(image_name):$(TAG), healthy
deploy.assert_image: ## Wait until the service runs $(image_name):$(TAG) and is healthy
	@test -n "$(TAG)" || { echo "TAG is required" >&2; exit 1; }
	scripts/assert-deployed.sh $(svc_full) $(image_name):$(TAG) $(assert_timeout) $(assert_settle)

smoke.test: ## GET /health on the prod host (retries)
	@echo "Smoke test https://$(prod_host)/health"
	@curl -fsS --retry 6 --retry-delay 5 --retry-all-errors --max-time 10 https://$(prod_host)/health \
	  || { echo "Smoke test KO" >&2; exit 1; }
	@echo
	@echo "Smoke test OK"

# Removes the stack's stopped containers (old tasks); never touches running ones
deploy.prune: ## Remove the stack's stopped containers
	docker container prune -f --filter label=com.docker.stack.namespace=$(stack_name)

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

token-create: ## Create a token (name=X preset=master|master-ro OR scope=sp:proj:sect:read|write|propose,...; wildcards/presets need allow_wildcard=1; optional expires_in_days=N)
	@$(call exec_in_service,node dist/cli/token.js create --name "$(name)" $(if $(preset),--preset "$(preset)") $(if $(scope),--scope "$(scope)") $(if $(allow_wildcard),--allow-wildcard) $(if $(expires_in_days),--expires-in-days "$(expires_in_days)"))

token-list: ## List tokens
	@$(call exec_in_service,node dist/cli/token.js list)

token-revoke: ## Revoke a token (make token-revoke id=X)
	@$(call exec_in_service,node dist/cli/token.js revoke --id "$(id)")

backup-db: ## Consistent SQLite backup to /data/backups/acl-<UTC timestamp>.db
	@$(call exec_in_service,node dist/cli/maintenance.js backup "/data/backups/acl-$$(date -u +%Y%m%dT%H%M%SZ).db")

prune-audit: ## Delete audit rows older than N days (make prune-audit days=90)
	@test -n "$(days)" || { echo "days is required (make prune-audit days=90)" >&2; exit 1; }
	@$(call exec_in_service,node dist/cli/maintenance.js prune-audit --days "$(days)")

inbox-list: ## List pending doc proposals
	@$(call exec_in_service,node dist/cli/inbox.js list)

inbox-show: ## Show a proposal (make inbox-show id=<id>)
	@test -n "$(id)" || { echo "id is required (make inbox-show id=<id>)" >&2; exit 1; }
	@$(call exec_in_service,node dist/cli/inbox.js show "$(id)")

inbox-accept: ## Accept a proposal into its target (make inbox-accept id=<id> [overwrite=1])
	@test -n "$(id)" || { echo "id is required (make inbox-accept id=<id>)" >&2; exit 1; }
	@$(call exec_in_service,node dist/cli/inbox.js accept "$(id)" $(if $(overwrite),--overwrite))

inbox-reject: ## Reject a proposal (make inbox-reject id=<id>)
	@test -n "$(id)" || { echo "id is required (make inbox-reject id=<id>)" >&2; exit 1; }
	@$(call exec_in_service,node dist/cli/inbox.js reject "$(id)")
