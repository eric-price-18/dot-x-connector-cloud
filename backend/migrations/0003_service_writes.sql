-- Durable service receipts. Existing sends tombstones remain authoritative for
-- cross-interface duplicate suppression and are never deleted by cleanup.
CREATE TABLE service_writes (
  idempotency_key TEXT PRIMARY KEY,
  service_subject TEXT NOT NULL,
  owner_issuer TEXT NOT NULL,
  owner_subject TEXT NOT NULL,
  account_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('x_create_original_post','x_repost','x_reply')),
  payload_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','succeeded','rejected','unknown')),
  code TEXT NOT NULL,
  post_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK((state='succeeded' AND post_id IS NOT NULL) OR (state!='succeeded' AND post_id IS NULL))
);
CREATE INDEX service_writes_account ON service_writes(account_id,created_at);
