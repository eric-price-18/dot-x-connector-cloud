-- One immutable operator-approved mention exception for this deployment.
-- Never delete/reset this slot on expiry, config changes, cleanup or rollback.
CREATE TABLE canary_mention (
  id TEXT PRIMARY KEY CHECK(id='one-time-original'),
  owner_issuer TEXT NOT NULL,
  owner_subject TEXT NOT NULL,
  account_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  text_sha256 TEXT NOT NULL,
  handle TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
