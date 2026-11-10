.DEFAULT_GOAL := help
.PHONY: help deploy deploy.prod undeploy restart logs token-create token-list token-revoke

stack_name=second-brain-mcp

help: ## Show this help
	@echo "second-brain-mcp — available commands:"
	@grep -E '^[a-zA-Z_.-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

deploy: ## Build the image and deploy the stack locally (Swarm)
	docker compose build
	docker compose config | sed '/^name:/d; s/published: "\([0-9]*\)"/published: \1/g' | docker stack deploy -c - $(stack_name)

deploy.prod: ## Deploy to prod (needs a published image — not yet the case)
	docker compose -f docker-compose-prod.yml config | sed '/^name:/d; s/published: "\([0-9]*\)"/published: \1/g' | docker stack deploy -c - $(stack_name)

undeploy: ## Remove the stack
	docker stack rm $(stack_name)

restart: ## Restart (undeploy then deploy)
	$(MAKE) undeploy
	sleep 5
	$(MAKE) deploy

logs: ## Follow logs (make logs service=second-brain-mcp)
	docker service logs -f $(stack_name)_$(service)

token-create: ## Create a token (make token-create name=X scope=project:section:perm,...)
	docker exec $$(docker ps -q -f name=second-brain-mcp_second-brain-mcp | head -1) node dist/cli/token.js create --name $(name) --scope $(scope)

token-list: ## List tokens
	docker exec $$(docker ps -q -f name=second-brain-mcp_second-brain-mcp | head -1) node dist/cli/token.js list

token-revoke: ## Revoke a token (make token-revoke id=X)
	docker exec $$(docker ps -q -f name=second-brain-mcp_second-brain-mcp | head -1) node dist/cli/token.js revoke --id $(id)
