// Compiled fixed migration statements. Offline tests pin every statement, file hash,
// and schema-prefix fingerprint to the reviewed migration files.
export const QUEUE_MIGRATIONS=[
  {
    "number": "0008",
    "name": "0008_reply_queue.sql",
    "sha256": "550a18eb27e69a6db38776e7f585ef25a7c7057aca2da6895cce7cf7efae5cb6",
    "statements": [
      "CREATE TABLE reply_queue_accounts (\n  account_id TEXT PRIMARY KEY,\n  claim_token TEXT,\n  claim_until INTEGER NOT NULL DEFAULT 0,\n  next_send_at INTEGER NOT NULL DEFAULT 0\n);",
      "CREATE TABLE reply_queue_items (\n  account_id TEXT NOT NULL,\n  target_id TEXT NOT NULL,\n  author_id TEXT NOT NULL,\n  root_id TEXT NOT NULL,\n  state TEXT NOT NULL CHECK(state IN ('pending','blocked','approved','dispatching','sent','unknown','cancelled')),\n  intent_key TEXT NOT NULL UNIQUE,\n  draft TEXT,\n  context_ref TEXT NOT NULL,\n  reason TEXT,\n  due_at INTEGER,\n  claim_token TEXT,\n  created_at INTEGER NOT NULL,\n  updated_at INTEGER NOT NULL,\n  revision INTEGER NOT NULL DEFAULT 0,\n  reviewed_at INTEGER,\n  PRIMARY KEY(account_id,target_id)\n);",
      "CREATE INDEX reply_queue_due ON reply_queue_items(account_id,state,due_at,created_at);",
      "CREATE TABLE reply_queue_intents (\n  intent_key TEXT PRIMARY KEY,\n  account_id TEXT NOT NULL,\n  target_id TEXT NOT NULL,\n  author_id TEXT NOT NULL,\n  draft TEXT NOT NULL,\n  context_ref TEXT NOT NULL,\n  dispatch_at INTEGER NOT NULL,\n  cost_micro_usd INTEGER NOT NULL CHECK(cost_micro_usd>0),\n  state TEXT NOT NULL CHECK(state IN ('dispatching','sent','unknown','cancelled')),\n  receipt_ref TEXT,\n  receipt_json TEXT,\n  confirmed_at INTEGER,\n  owner_request_ref TEXT\n);",
      "CREATE INDEX reply_queue_intent_account ON reply_queue_intents(account_id,dispatch_at);",
      "CREATE UNIQUE INDEX reply_queue_owner_request ON reply_queue_intents(account_id,owner_request_ref)\n  WHERE owner_request_ref IS NOT NULL;",
      "CREATE TABLE reply_queue_publisher_attempts (\n intent_key TEXT PRIMARY KEY,\n account_id TEXT NOT NULL,\n phase TEXT NOT NULL CHECK(phase IN ('prepared','may_dispatch')),\n service_intent_owned INTEGER NOT NULL DEFAULT 0 CHECK(service_intent_owned IN (0,1)),\n receipt_json TEXT,\n created_at INTEGER NOT NULL\n);"
    ]
  },
  {
    "number": "0009",
    "name": "0009_reply_queue_service.sql",
    "sha256": "07f4aa862ac5a53422392c53543ff534e778f44c82fb75ca8ecfd130e95ad37d",
    "statements": [
      "CREATE TABLE reply_queue_service_bindings (\n account_id TEXT PRIMARY KEY,\n service_subject TEXT NOT NULL,\n owner_issuer TEXT NOT NULL,\n owner_subject TEXT NOT NULL,\n created_at INTEGER NOT NULL\n);",
      "CREATE TABLE reply_queue_service_requests (\n request_id TEXT PRIMARY KEY,\n account_id TEXT NOT NULL,\n service_subject TEXT NOT NULL,\n owner_issuer TEXT NOT NULL,\n owner_subject TEXT NOT NULL,\n operation TEXT NOT NULL,\n body_sha256 TEXT NOT NULL,\n state TEXT NOT NULL CHECK(state IN ('started','completed')),\n response_json TEXT,\n created_at INTEGER NOT NULL,\n completed_at INTEGER\n);"
    ]
  },
  {
    "number": "0010",
    "name": "0010_reply_queue_expiry.sql",
    "sha256": "69af05b8dfc974ec315e69e0a6332ee4b89d1d0497ca1fdc0e42d692907b6cf7",
    "statements": [
      "ALTER TABLE reply_queue_items ADD COLUMN source_created_at INTEGER NOT NULL DEFAULT 0;",
      "ALTER TABLE reply_queue_items ADD COLUMN source_created_at_known INTEGER NOT NULL DEFAULT 0 CHECK(source_created_at_known IN (0,1));",
      "ALTER TABLE reply_queue_items ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0;",
      "UPDATE reply_queue_items SET source_created_at=created_at,expires_at=created_at+86400;",
      "CREATE INDEX reply_queue_expiry ON reply_queue_items(account_id,state,expires_at);",
      "CREATE INDEX reply_queue_root_history ON reply_queue_items(account_id,root_id,target_id);",
      "CREATE INDEX reply_queue_author_history ON reply_queue_intents(account_id,author_id,dispatch_at);",
      "ALTER TABLE reply_queue_publisher_attempts ADD COLUMN expired_before_transport INTEGER NOT NULL DEFAULT 0 CHECK(expired_before_transport IN (0,1));",
      "ALTER TABLE reply_queue_accounts ADD COLUMN candidate_generation INTEGER NOT NULL DEFAULT 0;",
      "CREATE TRIGGER reply_queue_candidate_insert AFTER INSERT ON reply_queue_items BEGIN\n  UPDATE reply_queue_accounts SET candidate_generation=candidate_generation+1 WHERE account_id=NEW.account_id;\nEND;",
      "CREATE TRIGGER reply_queue_candidate_update AFTER UPDATE OF state,due_at,source_created_at,expires_at ON reply_queue_items\nWHEN OLD.state IS NOT NEW.state OR OLD.due_at IS NOT NEW.due_at\n  OR OLD.source_created_at IS NOT NEW.source_created_at OR OLD.expires_at IS NOT NEW.expires_at BEGIN\n  UPDATE reply_queue_accounts SET candidate_generation=candidate_generation+1 WHERE account_id=NEW.account_id;\nEND;",
      "CREATE TRIGGER reply_queue_fairness_insert AFTER INSERT ON reply_queue_intents BEGIN\n  UPDATE reply_queue_accounts SET candidate_generation=candidate_generation+1 WHERE account_id=NEW.account_id;\nEND;"
    ]
  },
  {
    "number": "0011",
    "name": "0011_reply_queue_review.sql",
    "sha256": "dfccf13b2faee9f1c08ddb4661e0be6825a0901b69b9fcba7bbe70084511105b",
    "statements": [
      "ALTER TABLE reply_queue_intents ADD COLUMN review_revision INTEGER;",
      "ALTER TABLE reply_queue_intents ADD COLUMN review_claim_token TEXT;",
      "ALTER TABLE reply_queue_intents ADD COLUMN reviewed_at INTEGER;",
      "ALTER TABLE reply_queue_intents ADD COLUMN expires_at INTEGER;",
      "ALTER TABLE reply_queue_publisher_attempts ADD COLUMN no_dispatch_code TEXT\n  CHECK(no_dispatch_code IS NULL OR no_dispatch_code IN\n    ('planned_reply_expired','queue_review_expired','queue_claim_lost','queue_approval_binding_mismatch','queue_dispatch_guard_failed'));"
    ]
  }
];
export const QUEUE_SCHEMA_HASHES=[
  "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
  "63b22c903f5ce49ec9d81b654add3d0e754b72a42d76a67f089a047e66374ad9",
  "516862d66aade0fad4d3631c1ed774f968c91ff5a2e3ecd3bf04b065b16d6ca6",
  "0829e4f7e68882683afd0330158b9d34b269adb76476f7ad4fca0e7cd81ebbf6",
  "b9f6faa413a3839e79217d8911e55afe1969b926092a26699656fe41a9943783"
];
