# Deploying Speedy

Speedy is designed to be cloned and hosted by anyone — no managed service required. Pick the path
that matches your environment.

## 1. One command on a VPS (Docker)

```bash
git clone <your-fork-url> speedy && cd speedy
sudo ./install.sh
```

`install.sh` checks Docker, generates `.env` with a fresh `JWT_SECRET` and `MESSAGE_KEY`, builds the
image and starts the container. Visit the URL it prints.

## 2. Production with TLS (Caddy + Redis)

```bash
cp .env.example .env
# set PUBLIC_ORIGIN=https://chat.example.com and leave the secrets blank
node scripts/setup.js --force --origin https://chat.example.com
docker compose -f docker-compose.prod.yml up -d --build
```

Point an A record at the server first; Caddy obtains a Let's Encrypt certificate automatically.
Redis is included so several app instances can share socket rooms later.

## 3. Without Docker (Node 20+)

```bash
npm ci --omit=dev
node scripts/setup.js
NODE_ENV=production node server/src/index.js
```

Run it under systemd or pm2 so it restarts on failure, and put nginx/Caddy in front for TLS:

```ini
[Unit]
Description=Speedy
After=network.target

[Service]
WorkingDirectory=/opt/speedy
EnvironmentFile=/opt/speedy/.env
ExecStart=/usr/bin/node server/src/index.js
Restart=always
User=speedy
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/speedy/data

[Install]
WantedBy=multi-user.target
```

## Configuration

Everything is environment variables — see `.env.example`. The ones people actually change:

| Variable | Why |
| --- | --- |
| `PUBLIC_ORIGIN` | Origin checks and cookie security depend on it; must match the URL users type |
| `ALLOW_REGISTRATION` | Set `false` once your team has accounts |
| `ADMIN_USERNAMES` | Comma-separated usernames promoted to admin at boot (moderation console) |
| `MFA_POLICY` | `off`, `optional` or `required` |
| `REQUIRE_EMAIL_VERIFICATION` | Needs SMTP configured |
| `SMTP_*` | Password reset and email verification |
| `ALERT_WEBHOOK_URL` | Slack-compatible webhook for security events |
| `CLAMAV_HOST` | Enables malware scanning of uploads |
| `REDIS_URL` | Shares socket rooms across instances |
| `VAPID_*` | Enables browser push notifications (`npm run vapid`) |

## Backups

```bash
docker compose exec speedy node scripts/backup.js --out /app/data/backups --keep 14
```

Or from cron on a bare-metal install:

```cron
15 3 * * * cd /opt/speedy && DATA_DIR=/opt/speedy/data node scripts/backup.js --keep 14 >> /var/log/speedy-backup.log 2>&1
```

Restore (into a stopped instance):

```bash
docker compose stop speedy
docker compose run --rm speedy node scripts/restore.js --from /app/data/backups/<stamp> --force
docker compose start speedy
```

## Upgrades

```bash
git pull
docker compose up -d --build     # migrations run automatically on boot
```

Migrations are additive and versioned (`PRAGMA user_version`); a failed migration rolls back and the
process exits non-zero rather than serving a half-migrated schema.

## Health and monitoring

- `GET /healthz` → `{ status, version, uptime, env }`, `503` if the database is unreachable.
- Point your uptime monitor at `/healthz`.
- Ship the audit log (`SELECT * FROM audit_log`) to your SIEM, or set `ALERT_WEBHOOK_URL` and the
  important events (token replay, lockouts, malware, account deletion) arrive in Slack.

## Scaling notes

- Single instance: in-process presence and rate limits.
- Several instances: set `REDIS_URL` so Socket.IO shares rooms; move rate limiting to a shared store
  and presence to Redis as well (interfaces are isolated in `realtime/` and `lib/presence.js`).
- Storage: local disk. Swap `modules/attachments/service.js` for S3-compatible storage when you
  outgrow one node — the signed-URL scheme already matches that model.
