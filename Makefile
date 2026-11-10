.DEFAULT_GOAL := help
.PHONY: help up down restart pull status logs

# docker-compose.yml rend MCP_DOMAIN / TRAEFIK_CERT_RESOLVER / TRAEFIK_NETWORK_NAME
# obligatoires (${VAR:?...}) pour échouer bruyamment en cas d'oubli en PRODUCTION.
# Mais Docker Compose interpole les variables de chaque fichier AVANT de fusionner
# avec l'override — donc même si docker-compose.override.yml neutralise ensuite les
# labels/network concernés (!reset []) pour le dev local, l'interpolation du fichier
# de base échouerait quand même sans valeur. Ces valeurs fictives ne servent qu'à
# satisfaire cette interpolation ; elles ne sont jamais réellement utilisées en local.
LOCAL_DEV_ENV := MCP_DOMAIN=localhost TRAEFIK_CERT_RESOLVER=local-dev-unused TRAEFIK_NETWORK_NAME=local-dev-unused

help: ## Affiche cette aide
	@echo "second-brain-mcp — commandes disponibles :"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'

up: ## Démarre le serveur en local (docker compose, override auto-appliqué)
	$(LOCAL_DEV_ENV) docker compose up -d --build

down: ## Arrête le serveur
	$(LOCAL_DEV_ENV) docker compose down

restart: ## Redémarre le serveur
	$(LOCAL_DEV_ENV) docker compose restart

pull: ## Reconstruit l'image (pas de registry distant pour l'instant)
	$(LOCAL_DEV_ENV) docker compose build --no-cache

status: ## État du conteneur
	$(LOCAL_DEV_ENV) docker compose ps

logs: ## Suit les logs du serveur (Ctrl+C pour sortir)
	$(LOCAL_DEV_ENV) docker compose logs -f
