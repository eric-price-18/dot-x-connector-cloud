-- No cleanup deletes these one-time authorizations, opt-outs or interaction claims.
CREATE TABLE x_credit_budgets (
  budget_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  cap_micro_usd INTEGER NOT NULL CHECK(cap_micro_usd BETWEEN 1 AND 5000000),
  initial_micro_usd INTEGER NOT NULL CHECK(initial_micro_usd >= 0),
  used_micro_usd INTEGER NOT NULL CHECK(used_micro_usd >= 0),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  CHECK(used_micro_usd <= cap_micro_usd)
);
CREATE TABLE reply_interactions (
  account_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  author_id TEXT,
  root_id TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(account_id,target_id)
);
CREATE TABLE reply_opt_outs (
  account_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  source_post_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(account_id,author_id)
);
CREATE TABLE reply_opt_out_scans (
  account_id TEXT PRIMARY KEY,
  since_id TEXT,
  next_token TEXT,
  highwater TEXT,
  generation INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0,
  completed_at INTEGER NOT NULL
);
