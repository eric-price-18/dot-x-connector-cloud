-- Immutable snapshot of the approved claim, carried through publisher awaits.
-- Legacy frozen intents keep NULL fields and remain available for reconciliation.
ALTER TABLE reply_queue_intents ADD COLUMN review_revision INTEGER;
ALTER TABLE reply_queue_intents ADD COLUMN review_claim_token TEXT;
ALTER TABLE reply_queue_intents ADD COLUMN reviewed_at INTEGER;
ALTER TABLE reply_queue_intents ADD COLUMN expires_at INTEGER;
-- Local, durable proof that a final queue guard prevented the provider POST.
ALTER TABLE reply_queue_publisher_attempts ADD COLUMN no_dispatch_code TEXT
  CHECK(no_dispatch_code IS NULL OR no_dispatch_code IN
    ('planned_reply_expired','queue_review_expired','queue_claim_lost','queue_approval_binding_mismatch','queue_dispatch_guard_failed'));
