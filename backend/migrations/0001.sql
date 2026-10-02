PRAGMA foreign_keys = ON;

CREATE TABLE accounts (
  id TEXT PRIMARY KEY CHECK (id = 'primary'),
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  x_user_id TEXT NOT NULL,
  encrypted_tokens TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  refresh_status TEXT NOT NULL DEFAULT 'idle'
    CHECK (refresh_status IN ('idle', 'inflight', 'reconnect')),
  refresh_attempt TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE oauth_states (
  state_hash TEXT PRIMARY KEY,
  cookie_hash TEXT NOT NULL,
  encrypted_payload TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX oauth_states_expiry ON oauth_states(expires_at);

CREATE TABLE snapshots (
  kind TEXT PRIMARY KEY CHECK (kind IN ('mentions', 'posts')),
  encrypted_payload TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);

CREATE TABLE budgets (
  bucket TEXT PRIMARY KEY,
  used INTEGER NOT NULL CHECK (used >= 0),
  expires_at INTEGER NOT NULL
);
CREATE INDEX budgets_expiry ON budgets(expires_at);

CREATE TABLE cooldowns (
  name TEXT PRIMARY KEY,
  until_at INTEGER NOT NULL
);

-- Persistent tombstones: never automatically retry an uncertain outbound send.
-- Content hashes also block the same payload under another idempotency key.
CREATE TABLE sends (
  idempotency_hash TEXT PRIMARY KEY,
  payload_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'uncertain')),
  result_id TEXT,
  created_at INTEGER NOT NULL
);
