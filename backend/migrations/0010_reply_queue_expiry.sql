-- Additive deadline columns. Retain all queue IDs, intents and receipts on rollback.
-- Existing source age is unknown, so bound legacy plans by original first-seen.
ALTER TABLE reply_queue_items ADD COLUMN source_created_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reply_queue_items ADD COLUMN source_created_at_known INTEGER NOT NULL DEFAULT 0 CHECK(source_created_at_known IN (0,1));
ALTER TABLE reply_queue_items ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0;
UPDATE reply_queue_items SET source_created_at=created_at,expires_at=created_at+86400;
CREATE INDEX reply_queue_expiry ON reply_queue_items(account_id,state,expires_at);
CREATE INDEX reply_queue_root_history ON reply_queue_items(account_id,root_id,target_id);
CREATE INDEX reply_queue_author_history ON reply_queue_intents(account_id,author_id,dispatch_at);
-- A durable proof that the queue deadline prevented the transport call.
ALTER TABLE reply_queue_publisher_attempts ADD COLUMN expired_before_transport INTEGER NOT NULL DEFAULT 0 CHECK(expired_before_transport IN (0,1));
-- Generation fences detect newer candidates or changed fairness mid-scan.
ALTER TABLE reply_queue_accounts ADD COLUMN candidate_generation INTEGER NOT NULL DEFAULT 0;
CREATE TRIGGER reply_queue_candidate_insert AFTER INSERT ON reply_queue_items BEGIN
  UPDATE reply_queue_accounts SET candidate_generation=candidate_generation+1 WHERE account_id=NEW.account_id;
END;
CREATE TRIGGER reply_queue_candidate_update AFTER UPDATE OF state,due_at,source_created_at,expires_at ON reply_queue_items
WHEN OLD.state IS NOT NEW.state OR OLD.due_at IS NOT NEW.due_at
  OR OLD.source_created_at IS NOT NEW.source_created_at OR OLD.expires_at IS NOT NEW.expires_at BEGIN
  UPDATE reply_queue_accounts SET candidate_generation=candidate_generation+1 WHERE account_id=NEW.account_id;
END;
CREATE TRIGGER reply_queue_fairness_insert AFTER INSERT ON reply_queue_intents BEGIN
  UPDATE reply_queue_accounts SET candidate_generation=candidate_generation+1 WHERE account_id=NEW.account_id;
END;
