# Security model

This document describes what Speedy protects against, how, and what it explicitly does not cover.
It is written to be read by whoever operates the deployment.

## Threat model

In scope:

| Attacker | Goal | Mitigation |
| --- | --- | --- |
| Anonymous internet user | Take over accounts, scrape data | Rate limits, lockout, generic errors, auth on every route |
| Registered user | Read someone else's chats, tamper with messages | Membership checks on every read, authorship checks on every mutation |
| Registered user | Upload a malicious file to attack other users | Magic-byte MIME sniffing, forced download for unknown types, `sandbox` CSP on file responses |
| Malicious website | CSRF a logged-in user | `SameSite=Strict` cookies, origin checks, double-submit token |
| Network attacker | Read or replay traffic | TLS (terminate at the proxy), HSTS, short-lived tokens, rotating refresh tokens |
| Someone with a copy of the database file | Read conversations | AES-256-GCM encryption of message bodies with a key held outside the DB |
| Stolen refresh token | Maintain access | Rotation with reuse detection revokes the token family |
| Spammer with a socket | Flood the server | Per-socket token bucket, payload caps, per-IP HTTP limits |

Out of scope (documented limitations): a compromised server host, a compromised browser, malicious
insiders with key access, end-to-end encryption guarantees, and denial of service at the network
layer (put a CDN/WAF in front).

## Controls

### Authentication

- Passwords: `crypto.scrypt` with N=32768, r=8, p=1, 64-byte output, 16-byte random salt.
  Encoded as `scrypt$N$r$p$salt$hash` so parameters can be raised later without breaking old hashes.
  Verification uses `timingSafeEqual`.
- Unknown usernames still run a dummy scrypt derivation, so response time does not reveal whether an
  account exists.
- Login errors are identical for unknown user and wrong password.
- After 5 failures the account is locked for 15 minutes; the counter is per account, not per IP, so
  rotating IPs does not help an attacker.
- Usernames are normalised to lowercase and checked against a reserved list (`admin`, `root`, ...).

### Sessions

- Access token: HS256 JWT (`jose`), 15 minutes, claims `sub` (user), `sid` (session), `role`.
  Held in a JavaScript variable only — never `localStorage`, never a cookie, so XSS cannot read it
  from storage and CSRF cannot ride it.
- Refresh token: 384-bit random value, stored **hashed** (SHA-256) in `sessions.token_hash`, sent in
  an `httpOnly`, `SameSite=Strict`, `Secure` (in production) cookie scoped to `/api/auth`.
- Every refresh rotates the token and links the new session to the old one (`replaced_by`). If a
  token that was already rotated is presented again, the entire `family_id` is revoked and an
  `auth.refresh_reuse` audit event is written.
- Every authenticated request re-checks that the session is not revoked (30-second in-process cache),
  so logout, "sign out everywhere" and reuse detection take effect immediately.
- **Idle timeout**: a session unused for `SESSION_IDLE_MINUTES` (30 by default) is revoked on the
  next request and cannot be refreshed.
- **Absolute lifetime**: a session family dies `SESSION_ABSOLUTE_DAYS` (30 by default) after its
  first login, no matter how often it is refreshed.
- Users can list and revoke individual sessions from the profile dialog.

### Authorization

| Action | Rule |
| --- | --- |
| Read chat / messages / search / attachments | Must be a row in `chat_members` |
| Send message | Member, and not blocked by the other party in a direct chat |
| Edit / delete message | Author only |
| Rename group, add/remove members | `owner` or `admin` |
| Change roles | `owner` only; the owner cannot be demoted or removed |
| Upload | Own attachment only; can only send attachments you uploaded |
| Download attachment | Owner, a member of a chat where it is used, or it is someone's avatar |
| Read or send in a locked chat | Member **and** a valid `X-Chat-Unlock` token (30 min, bound to user + chat, minted only after a password check) |

Attachment URLs handed to the browser carry `?t=<userId>.<expiry>.<hmac>`: an
HMAC-SHA256 signature over the attachment id, the viewer's id and an expiry,
keyed from `JWT_SECRET` and valid for 12 hours. `<img>` and download links cannot
send an `Authorization` header, so this is what makes them work; the signature
only identifies *who is asking*, and the normal membership check still decides
whether that user may read the file. Tampered, unsigned or expired links get a
401 (covered by tests).

All of these are exercised by `server/tests/api.test.js`.

### Input handling

- Every request body, query string and socket payload is parsed with a Zod schema
  (`server/src/lib/validate.js`). Failures return `422` with per-field messages.
- JSON bodies are capped at 128 KB, uploads at `MAX_UPLOAD_BYTES` (10 MB default), socket payloads at
  256 KB, messages at 4000 characters.
- All SQL uses bound parameters. There is no string interpolation of user input anywhere in
  `server/src`.
- Uploaded filenames are stripped of directory components, control characters and Windows-reserved
  characters, truncated to 120 characters, and never used as the on-disk name.

### Outbound requests (SSRF)

Nothing in Speedy fetches user-supplied URLs today — there are no link previews. `lib/safe-fetch.js`
exists so that the first person to add one cannot do it unsafely: http/https only, credentials in the
URL refused, private/loopback/link-local/CGNAT/multicast and cloud-metadata addresses (IPv4 and IPv6)
refused, every DNS answer re-checked so a name resolving to `10.x` is rejected, redirects re-validated
hop by hop, and hard caps on time and response size. Covered by tests including a DNS-rebinding case.

### Output handling

- The frontend never assigns user content to `innerHTML`. `dom.js` `h()` sets `textContent`; only
  hard-coded icon SVG strings use `innerHTML`.
- CSP: `default-src 'self'`, `script-src 'self'`, `style-src 'self'` (no inline styles),
  `img-src 'self' data: blob:`, `connect-src 'self' ws: wss:`, `object-src 'none'`,
  `frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'self'`.
- Attachment responses carry `Content-Type` from magic-byte sniffing, `X-Content-Type-Options:
  nosniff`, `Content-Disposition` (inline only for JPEG/PNG/GIF/WebP), and
  `Content-Security-Policy: default-src 'none'; sandbox`.
- `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy:
  same-origin`, `Cross-Origin-Opener-Policy: same-origin`, HSTS in production.

### CSRF

1. The refresh cookie is `SameSite=Strict` and scoped to `/api/auth`.
2. `sameOriginOnly` rejects any request whose `Origin` header differs from `PUBLIC_ORIGIN`, and any
   state-changing request whose `Sec-Fetch-Site` is `cross-site`.
3. `/api/auth/refresh` additionally requires `X-CSRF-Token` to match the readable `speedy_csrf`
   cookie (double submit).
4. API responses are `Cache-Control: no-store`.

### Data at rest

- Message bodies (including edits) are AES-256-GCM encrypted with a 256-bit key from
  `MESSAGE_KEY`. Format: `v1.<iv>.<tag>.<ciphertext>` (base64url). A wrong key or tampered
  ciphertext fails the authentication tag instead of returning garbage.
- Refresh tokens are hashed. Password hashes are salted. Audit entries never contain message bodies
  or secrets.
- **Attachments are encrypted at rest** with the same AES-256-GCM key, in an `SPV1` container
  (`magic | iv | tag | ciphertext`). Only ciphertext reaches the disk, with mode `0600`, under a
  random UUID name outside the static root. A stolen disk or backup yields no readable files.
- Every uploaded image is **decoded and re-encoded** before storage. That removes EXIF (GPS, device
  serial, timestamps), normalises orientation, caps dimensions at 2560 px and destroys polyglot
  payloads — a valid PNG with appended PHP code does not survive the round trip. Files that claim to
  be images but cannot be decoded are rejected with `400`.

### Realtime

- Socket handshake requires a valid access token **and** a live session; the same revocation rules
  apply as HTTP.
- Each socket is joined only to rooms for chats the user belongs to, re-checked when joining a new
  chat.
- A token bucket limits each socket to 30 events per 10 seconds; message payloads are schema
  validated and size capped.
- Typing events are dropped unless the socket is in that chat's room.

### Operations

- Structured logging (Pino) with redaction of `authorization`, `cookie`, `token`, `password`.
- `X-Request-Id` on every response, and the same id in error logs.
- `/healthz` returns 503 if the database is unreachable.
- Graceful shutdown on `SIGTERM`/`SIGINT`; uncaught exceptions are logged then exit non-zero so the
  supervisor restarts a clean process.
- Container runs as `node`, drops all capabilities, `no-new-privileges`, read-only root filesystem.
- Production refuses to start without `JWT_SECRET` (≥ 32 chars) and a valid `MESSAGE_KEY`.

## Rate limits

| Scope | Limit |
| --- | --- |
| All `/api` per IP | 300 requests / minute |
| Login + register per IP | 20 attempts / 15 minutes (successful ones not counted) |
| Writes per IP | 90 / minute |
| Uploads per IP | 60 / hour |
| Messages per socket | 30 / 10 seconds |

Tune these in `server/src/middleware/security.js` and `server/src/realtime/io.js`. If you run behind
a proxy, set `TRUST_PROXY` correctly or every client will share the proxy's IP and the limits will be
global.

## Audit log

`audit_log` records: `auth.register`, `auth.login`, `auth.login_failed`, `auth.login_blocked`,
`auth.login_disabled`, `auth.refresh_reuse`, `auth.logout`, `auth.logout_all`,
`auth.session_revoked`, `auth.session_idle_timeout`, `auth.session_absolute_timeout`,
`user.blocked`, `chat.group_created`, `chat.members_added`, `chat.member_removed`, `chat.locked`,
`chat.unlocked`, `chat.unlocked_permanently`, `account.deleted` — with user id, IP, user agent,
timestamp and small JSON metadata. Ship it to
your SIEM with `SELECT * FROM audit_log WHERE created_at > ?`.

## Backups and restore

`npm run backup` takes a `VACUUM INTO` snapshot (consistent, non-blocking), copies the encrypted
uploads directory, and writes a manifest containing the database SHA-256 and byte size. Retention
prunes to the newest `--keep` copies. `npm run restore -- --from <dir>` verifies the manifest against
the file before copying, clears stale `-wal`/`-shm` sidecars, and refuses to overwrite a live database
without `--force`.

Backups are only as good as their restore. Restore one into a scratch directory on a schedule.

## Data export and erasure

- `GET /api/users/me/export` returns a JSON download with the profile, every conversation the user can
  see, the decrypted message bodies and attachment metadata.
- `DELETE /api/users/me` (password-confirmed) removes the profile, sessions, memberships, reactions,
  receipts and uploaded files, then deletes any conversation left with no members. Messages already
  delivered stay in other people's conversations with `sender_id` detached, so their history is not
  silently rewritten.

## Responsible disclosure

Open a private security advisory on the repository rather than a public issue. Please include a
reproduction and the affected version.
