# API reference

Base URL: `https://<your-host>/api`. All responses are JSON.

Success: `{ "data": ... }`
Error: `{ "error": { "code": "validation_failed", "message": "…", "details": [...] } }`

Authentication is a bearer token: `Authorization: Bearer <accessToken>`.
Access tokens last 15 minutes; refresh with the `speedy_rt` cookie.

## Auth

### POST /auth/register
```json
{ "username": "alice", "displayName": "Alice Sharma", "password": "at-least-10-chars" }
```
`201` → `{ accessToken, refreshToken, expiresIn, user, sessionId }` and sets `speedy_rt` +
`speedy_csrf` cookies. `409` if the username is taken, `422` on validation failure.

### POST /auth/login
```json
{ "username": "alice", "password": "…" }
```
`200` with the same payload. `401` for both unknown user and wrong password, `423` when locked.

### POST /auth/refresh
No body. Requires the `speedy_rt` cookie and `X-CSRF-Token` matching the `speedy_csrf` cookie.
Rotates the refresh token. `401` if expired, revoked, or reused (which revokes the family).

### POST /auth/logout · POST /auth/logout-all
`204`. Revokes the current session / every session for the user.

### GET /auth/me
`{ user }`

### GET /auth/sessions
`{ sessions: [{ id, current, userAgent, ip, createdAt, lastUsedAt, expiresAt }] }`

### DELETE /auth/sessions/:id
`204`. Revokes one of your sessions.

## Users

### GET /users/search?q=&limit=
`{ users: [{ id, username, displayName, about, avatarUrl, online, lastSeenAt }] }`
Empty `q` returns everyone (used to populate pickers).

### GET /users/:id
`{ user }`

### PATCH /users/me
```json
{ "displayName": "Alice", "about": "Design at Northwind" }
```

### PUT /users/me/avatar
```json
{ "attachmentId": "uuid" }
```

### POST /users/:id/block · DELETE /users/:id/block · GET /users/blocked

## Chats

| Method | Path | Body | Notes |
| --- | --- | --- | --- |
| GET | `/chats` | | Sidebar payload: title, avatar, unread, last message, members |
| POST | `/chats/direct` | `{ userId }` | Idempotent; returns the existing chat |
| POST | `/chats/group` | `{ title, memberIds[] }` | You become `owner` |
| GET | `/chats/:id` | | Detail with members and roles |
| PATCH | `/chats/:id` | `{ title }` | Admin/owner, groups only |
| POST | `/chats/:id/members` | `{ memberIds[] }` | Admin/owner |
| DELETE | `/chats/:id/members/:userId` | | Admin/owner, cannot remove the owner |
| PATCH | `/chats/:id/members/:userId` | `{ role: "admin"\|"member" }` | Owner only |
| POST | `/chats/:id/leave` | | Transfers ownership if the owner leaves |
| PATCH | `/chats/:id/mute` | `{ muted }` | Per-user |
| PATCH | `/chats/:id/pin` | `{ pinned }` | Per-user; pinned chats sort first |
| POST | `/chats/:id/lock` | `{ locked, password? }` | Locking is instant; removing the lock requires the password |
| POST | `/chats/:id/unlock` | `{ password }` | Returns `{ unlockToken }`, valid 30 minutes |

A locked chat answers **423 `chat_locked`** to `GET /chats/:id/messages`,
`GET /chats/:id/search` and `POST /chats/:id/messages` until the caller sends
`X-Chat-Unlock: <unlockToken>`. Locking is per member, so it never affects
anyone else in the conversation.

## Messages

### GET /chats/:id/messages?before=<seq>&limit=40
`{ messages: [...], hasMore, nextCursor }` — oldest first within the page; `before` is the `seq` to
page from (exclusive).

### POST /chats/:id/messages
```json
{ "type": "text|image|file", "body": "…", "attachmentId": "uuid", "replyToId": "uuid", "clientId": "…" }
```
`201` → `{ message }`.

### GET /chats/:id/search?q=
`{ messages: [...] }` — up to 50 matches within the 400 most recent messages.

### POST /chats/:id/read
```json
{ "seq": 42 }
```
Marks everything up to `seq` as read for you and updates the sender's receipts.

### PATCH /messages/:id · DELETE /messages/:id · POST /messages/:id/reactions
Edit your own text, delete your own message for everyone, toggle `{ emoji }`.

### Message object
```json
{
  "id": "uuid", "chatId": "uuid", "seq": 42, "type": "text", "body": "hello",
  "createdAt": 1793792134720, "editedAt": null, "deletedAt": null,
  "sender": { "id": "uuid", "displayName": "Alice", "username": "alice", "avatarUrl": "/api/attachments/…" },
  "attachment": { "id": "uuid", "name": "photo.png", "mime": "image/png", "size": 1234, "url": "/api/attachments/…", "isImage": true },
  "replyTo": { "id": "uuid", "senderName": "Bob", "preview": "…", "type": "text" },
  "reactions": [{ "emoji": "🔥", "count": 2, "mine": true }],
  "receipts": { "delivered": 1, "read": 1, "total": 1, "status": "read" }
}
```

## Attachments

### POST /attachments
`multipart/form-data`, field `file`. `201` → `{ attachment }`.
MIME is detected from magic bytes; unknown types are stored as `application/octet-stream` and always
downloaded rather than rendered.

### GET /attachments/:id
Streams the file to the owner, chat members, or anyone for avatars.

Accepts **either** an `Authorization: Bearer` header **or** the signed query
string that attachment DTOs carry (`?t=<userId>.<expiry>.<hmac>`, valid 12 h,
bound to that user). The signed form exists because `<img src>` and download
links cannot send headers; it grants nothing beyond what that user could already
read — the membership check still runs.

## WebSocket

Connect to `/socket.io` with `auth: { token: <accessToken> }`.

**Client → server** (all ack'd with `{ ok: true, ... }` or `{ ok: false, error: { code, message } }`):

| Event | Payload |
| --- | --- |
| `message:send` | same as `POST /chats/:id/messages` |
| `message:read` | `{ chatId, seq }` |
| `typing` | `{ chatId, isTyping }` |
| `chat:join` | `{ chatId }` |

**Server → client**

| Event | Payload |
| --- | --- |
| `ready` | `{ userId, chats[] }` |
| `message:new` / `message:updated` | `{ message }` |
| `message:deleted` | `{ chatId, messageId, deletedAt }` |
| `receipt:update` | `{ chatId, seq, readAt? , userIds[] }` |
| `typing` | `{ chatId, userId, isTyping }` |
| `presence` | `{ userId, online, lastSeenAt }` |
| `chat:new` / `chat:updated` | `{ chatId }` |
