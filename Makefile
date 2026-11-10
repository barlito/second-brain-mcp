.DEFAULT_GOAL := help
.PHONY: help deploy deploy.prod undeploy restart logs

stack_name=second-brain-mcp

help: ## Affiche cette aide
	@echo "second-brain-mcp — commandes disponibles :"
	@grep -E '^[a-zA-Z_.-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

deploy: ## Build l'image et déploie la stack en local (Swarm)
	docker compose build
	docker compose config | sed '/^name:/d; s/published: "\([0-9]*\)"/published: \1/g' | docker stack deploy -c - $(stack_name)

deploy.prod: ## Déploie en prod (nécessite une image publiée — pas encore le cas)
	docker compose -f docker-compose-prod.yml config | sed '/^name:/d; s/published: "\([0-9]*\)"/published: \1/g' | docker stack deploy -c - $(stack_name)

undeploy: ## Retire la stack
	docker stack rm $(stack_name)

restart: ## Redémarre (undeploy puis deploy)
	$(MAKE) undeploy
	sleep 5
	$(MAKE) deploy

logs: ## Suit les logs (make logs service=second-brain-mcp)
	docker service logs -f $(stack_name)_$(service)
