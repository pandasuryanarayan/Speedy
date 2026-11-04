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
- Uploaded files are written with mode `0600` and random names outside the static root.

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
`auth.session_revoked`, `user.blocked`, `chat.group_created`, `chat.members_added`,
`chat.member_removed` — with user id, IP, user agent, timestamp and small JSON metadata. Ship it to
your SIEM with `SELECT * FROM audit_log WHERE created_at > ?`.

## Responsible disclosure

Open a private security advisory on the repository rather than a public issue. Please include a
reproduction and the affected version.
