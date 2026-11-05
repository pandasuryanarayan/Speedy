#!/usr/bin/env bash
# One-command self-hosting: secrets, build, run.
set -euo pipefail
cd "$(dirname "$0")"

say() { printf '\033[1;36m%s\033[0m\n' "$*"; }
die() { printf '\033[1;31m%s\033[0m\n' "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "Docker is required. Install it first: https://docs.docker.com/engine/install/"
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required (docker compose, not docker-compose)."

if [ ! -f .env ]; then
  say "Generating .env with fresh secrets…"
  node scripts/setup.js >/dev/null 2>&1 || {
    JWT=$(openssl rand -base64 48 | tr -d '\n')
    KEY=$(openssl rand -base64 32 | tr -d '\n')
    sed -e "s|^JWT_SECRET=.*|JWT_SECRET=$JWT|" -e "s|^MESSAGE_KEY=.*|MESSAGE_KEY=$KEY|" .env.example > .env
    chmod 600 .env
  }
else
  say "Using the existing .env"
fi

ORIGIN=$(grep -E '^PUBLIC_ORIGIN=' .env | cut -d= -f2-)
say "Building the image…"
docker compose build --quiet

say "Starting…"
docker compose up -d

say ""
say "Speedy is starting at ${ORIGIN:-http://localhost:3000}"
say "Health:  curl -s ${ORIGIN:-http://localhost:3000}/healthz"
say "Logs:    docker compose logs -f"
say "Backups: docker compose exec speedy node scripts/backup.js"
