.DEFAULT_GOAL := help

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

setup: ## Generate .env with fresh secrets
	node scripts/setup.js

install: ## Install dependencies
	npm install

dev: ## Run with reload
	npm run dev

up: ## Start with Docker Compose
	docker compose up -d --build

down: ## Stop the stack
	docker compose down

logs: ## Tail application logs
	docker compose logs -f --tail=100

seed: ## Create demo users and conversations
	npm run seed

test: ## Run the test suite
	npm test

backup: ## Snapshot database and uploads
	npm run backup

restore: ## Restore from a backup directory (make restore FROM=path)
	npm run restore -- --from $(FROM)

vapid: ## Generate Web Push keys
	npm run vapid

.PHONY: help setup install dev up down logs seed test backup restore vapid
