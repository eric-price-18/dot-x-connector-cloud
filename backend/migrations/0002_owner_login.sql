-- Single-owner browser workflow: bounded to one pending login and one session.
CREATE TABLE owner_login_state (
  id TEXT PRIMARY KEY CHECK (id = 'primary'),
  state_hash TEXT NOT NULL,
  cookie_hash TEXT NOT NULL,
  encrypted_payload TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0 CHECK (consumed IN (0,1))
);
CREATE TABLE owner_sessions (
  id TEXT PRIMARY KEY CHECK (id = 'primary'),
  session_hash TEXT NOT NULL,
  encrypted_payload TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
