/**
 * Schema is versioned with PRAGMA user_version. Each entry in MIGRATIONS is
 * applied once, in order, inside a transaction.
 */
export const MIGRATIONS = [
  // 1 - initial schema
  `
  CREATE TABLE users (
    id                  TEXT PRIMARY KEY,
    username            TEXT NOT NULL,
    username_lower      TEXT NOT NULL UNIQUE,
    display_name        TEXT NOT NULL,
    about               TEXT,
    avatar_attachment_id TEXT,
    password_hash       TEXT NOT NULL,
    role                TEXT NOT NULL DEFAULT 'user',
    is_disabled         INTEGER NOT NULL DEFAULT 0,
    failed_attempts     INTEGER NOT NULL DEFAULT 0,
    locked_until        INTEGER,
    last_seen_at        INTEGER,
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL
  );

  CREATE TABLE sessions (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    family_id    TEXT NOT NULL,
    token_hash   TEXT NOT NULL UNIQUE,
    user_agent   TEXT,
    ip           TEXT,
    created_at   INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL,
    revoked_at   INTEGER,
    replaced_by  TEXT
  );
  CREATE INDEX idx_sessions_user ON sessions(user_id);
  CREATE INDEX idx_sessions_family ON sessions(family_id);

  CREATE TABLE chats (
    id                  TEXT PRIMARY KEY,
    type                TEXT NOT NULL CHECK (type IN ('direct', 'group')),
    title               TEXT,
    avatar_attachment_id TEXT,
    direct_key          TEXT UNIQUE,
    created_by          TEXT REFERENCES users(id) ON DELETE SET NULL,
    seq                 INTEGER NOT NULL DEFAULT 0,
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL
  );

  CREATE TABLE chat_members (
    chat_id       TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
    joined_at     INTEGER NOT NULL,
    last_read_seq INTEGER NOT NULL DEFAULT 0,
    last_read_at  INTEGER,
    muted         INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (chat_id, user_id)
  );
  CREATE INDEX idx_chat_members_user ON chat_members(user_id);

  CREATE TABLE messages (
    id            TEXT PRIMARY KEY,
    chat_id       TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    seq           INTEGER NOT NULL,
    sender_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
    type          TEXT NOT NULL DEFAULT 'text',
    body          TEXT,
    attachment_id TEXT REFERENCES attachments(id) ON DELETE SET NULL,
    reply_to_id   TEXT,
    created_at    INTEGER NOT NULL,
    edited_at     INTEGER,
    deleted_at    INTEGER,
    UNIQUE (chat_id, seq)
  );
  CREATE INDEX idx_messages_chat_seq ON messages(chat_id, seq DESC);
  CREATE INDEX idx_messages_sender ON messages(sender_id);

  CREATE TABLE attachments (
    id            TEXT PRIMARY KEY,
    owner_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
    storage_key   TEXT NOT NULL UNIQUE,
    original_name TEXT NOT NULL,
    mime          TEXT NOT NULL,
    size          INTEGER NOT NULL,
    sha256        TEXT NOT NULL,
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE message_receipts (
    message_id   TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    delivered_at INTEGER,
    read_at      INTEGER,
    PRIMARY KEY (message_id, user_id)
  );

  CREATE TABLE reactions (
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji      TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (message_id, user_id, emoji)
  );

  CREATE TABLE blocks (
    blocker_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (blocker_id, blocked_id)
  );

  CREATE TABLE audit_log (
    id         TEXT PRIMARY KEY,
    user_id    TEXT,
    action     TEXT NOT NULL,
    ip         TEXT,
    user_agent TEXT,
    meta       TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_audit_created ON audit_log(created_at DESC);
  `,
  // 2 - per-member chat pinning and locking
  `
  ALTER TABLE chat_members ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE chat_members ADD COLUMN locked INTEGER NOT NULL DEFAULT 0;
  `,
  // 3 - session idle/absolute lifetime, encrypted attachments
  `
  ALTER TABLE sessions ADD COLUMN family_started_at INTEGER;
  UPDATE sessions SET family_started_at = created_at WHERE family_started_at IS NULL;
  ALTER TABLE attachments ADD COLUMN encrypted INTEGER NOT NULL DEFAULT 0;
  `,
];
