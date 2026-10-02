-- Additive only. Retain every row on rollback: these are dispatch tombstones.
CREATE TABLE reply_queue_accounts (
  account_id TEXT PRIMARY KEY,
  claim_token TEXT,
  claim_until INTEGER NOT NULL DEFAULT 0,
  next_send_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE reply_queue_items (
  account_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  root_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','blocked','approved','dispatching','sent','unknown','cancelled')),
  intent_key TEXT NOT NULL UNIQUE,
  draft TEXT,
  context_ref TEXT NOT NULL,
  reason TEXT,
  due_at INTEGER,
  claim_token TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  reviewed_at INTEGER,
  PRIMARY KEY(account_id,target_id)
);
CREATE INDEX reply_queue_due ON reply_queue_items(account_id,state,due_at,created_at);
CREATE TABLE reply_queue_intents (
  intent_key TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  draft TEXT NOT NULL,
  context_ref TEXT NOT NULL,
  dispatch_at INTEGER NOT NULL,
  cost_micro_usd INTEGER NOT NULL CHECK(cost_micro_usd>0),
  state TEXT NOT NULL CHECK(state IN ('dispatching','sent','unknown','cancelled')),
  receipt_ref TEXT,
  receipt_json TEXT,
  confirmed_at INTEGER,
  owner_request_ref TEXT
);
CREATE INDEX reply_queue_intent_account ON reply_queue_intents(account_id,dispatch_at);
CREATE UNIQUE INDEX reply_queue_owner_request ON reply_queue_intents(account_id,owner_request_ref)
  WHERE owner_request_ref IS NOT NULL;
-- Persist the boundary before the normal publish POST. Missing/ambiguous proof
-- is unknown, never evidence that a consumed terminal key can be reused.
CREATE TABLE reply_queue_publisher_attempts (
 intent_key TEXT PRIMARY KEY,
 account_id TEXT NOT NULL,
 phase TEXT NOT NULL CHECK(phase IN ('prepared','may_dispatch')),
 service_intent_owned INTEGER NOT NULL DEFAULT 0 CHECK(service_intent_owned IN (0,1)),
 receipt_json TEXT,
 created_at INTEGER NOT NULL
);
