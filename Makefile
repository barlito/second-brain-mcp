.DEFAULT_GOAL := help
.PHONY: help up down restart pull status logs

help: ## Affiche cette aide
	@echo "second-brain-mcp — commandes disponibles :"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'

up: ## Démarre le serveur en local (docker compose, override auto-appliqué)
	docker compose up -d --build

down: ## Arrête le serveur
	docker compose down

restart: ## Redémarre le serveur
	docker compose restart

pull: ## Reconstruit l'image (pas de registry distant pour l'instant)
	docker compose build --no-cache

status: ## État du conteneur
	docker compose ps

logs: ## Suit les logs du serveur (Ctrl+C pour sortir)
	docker compose logs -f
