# Architecture

```
Browser (vanilla ES modules)
  ├── api.js      fetch + bearer token + single-flight refresh + CSRF header
  ├── socket.js   socket.io client, ack-promisified
  ├── store.js    tiny observable state (one source of truth)
  └── ui/*        sidebar, chat pane, info panel, modals (DOM built with h())
        │
        │  HTTPS /api  +  WSS /socket.io
        ▼
Express app ── middleware: requestId → helmet/CSP → pino → json/cookies
        │                     → sameOrigin → rate limit → route
        │
        ├── modules/<domain>/{routes,service}.js   validation → service → SQL
        │
        ├── realtime/io.js   socket auth, rooms, presence, per-socket limits
        │        ▲
        │        │ bus.emit(EVENTS.*)
        ├── realtime/bus.js  internal EventEmitter
        │
        └── db/  @libsql/client (SQLite, WAL) + versioned migrations
```

## Why services never import socket.io

Business logic publishes domain events on an in-process `EventEmitter` (`realtime/bus.js`). The
realtime layer subscribes and fans them out to Socket.IO rooms. That keeps HTTP and WebSocket paths
identical — the same `messages.sendMessage()` serves `POST /api/chats/:id/messages` and the
`message:send` socket event — and makes it trivial to add another transport (webhooks, push, a
queue) later.

## Request lifecycle

1. `requestContext` assigns `req.id` and echoes it as `X-Request-Id`.
2. Helmet sets the CSP and hardening headers; `sameOriginOnly` rejects cross-site writes.
3. Rate limiters (`/api`, auth, writes, uploads) reject floods.
4. The route validates input with Zod, then calls a service.
5. The service checks membership/authorship, runs parameterized SQL inside a transaction when it
   spans rows (message + sequence counter + receipts), and emits domain events.
6. Errors are `AppError` instances; the error middleware maps them to a stable JSON shape and logs
   5xx with the request id.

## Data model

```
users ──┬── sessions (refresh token hashes, families)
        ├── chat_members ── chats ── messages ──┬── message_receipts
        ├── blocks                              ├── reactions
        └── attachments ◀───────────────────────┘
```

- `chats.seq` is a per-chat counter incremented in the same transaction as the insert, giving every
  message a stable, gap-free `seq`. Pagination, read receipts and unread counts all key off `seq`,
  which is immune to clock skew.
- `chat_members.last_read_seq` drives unread badges; `message_receipts` drives ticks.
- Direct chats store a `direct_key` (`"<idA>:<idB>"` sorted) with a unique index, so two people can
  never end up with duplicate conversations.
- Message bodies are encrypted before insert, so every read path decrypts in `messages/service.js`
  and every write path encrypts there too — no other module touches ciphertext.

## Frontend rendering

No virtual DOM: `state` changes call `emit()`, which schedules one `requestAnimationFrame` render.
The sidebar and chat pane rebuild their subtrees from state and preserve scroll position (the
messages list keeps the user's position unless they were already at the bottom). Message lists are
small (40 per page), so rebuilding is cheaper and far simpler than diffing.

`dom.js#h()` is the only DOM constructor: it sets `textContent` for strings and only uses
`innerHTML` for the built-in icon constants — that is what makes the strict CSP workable without a
sanitiser.
