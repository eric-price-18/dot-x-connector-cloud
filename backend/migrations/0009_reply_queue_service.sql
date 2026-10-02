-- Additive fixed schema. Preserve binding and replay tombstones on rollback.
-- Never adopt an existing unbound nonempty queue automatically.
CREATE TABLE reply_queue_service_bindings (
 account_id TEXT PRIMARY KEY,
 service_subject TEXT NOT NULL,
 owner_issuer TEXT NOT NULL,
 owner_subject TEXT NOT NULL,
 created_at INTEGER NOT NULL
);
CREATE TABLE reply_queue_service_requests (
 request_id TEXT PRIMARY KEY,
 account_id TEXT NOT NULL,
 service_subject TEXT NOT NULL,
 owner_issuer TEXT NOT NULL,
 owner_subject TEXT NOT NULL,
 operation TEXT NOT NULL,
 body_sha256 TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('started','completed')),
 response_json TEXT,
 created_at INTEGER NOT NULL,
 completed_at INTEGER
);
