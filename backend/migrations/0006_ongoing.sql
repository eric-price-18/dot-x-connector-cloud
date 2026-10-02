-- Additive only. No production rows or prior authorizations are changed.
CREATE TABLE ongoing_spend (
 id INTEGER PRIMARY KEY, account_id TEXT NOT NULL, day TEXT NOT NULL, month TEXT NOT NULL,
 amount INTEGER NOT NULL CHECK(amount>=0), unresolved_micro_usd INTEGER NOT NULL DEFAULT 0 CHECK(unresolved_micro_usd>=0 AND unresolved_micro_usd<=amount), kind TEXT NOT NULL CHECK(kind IN ('api','legacy')), created_at INTEGER NOT NULL
);
CREATE INDEX ongoing_spend_periods ON ongoing_spend(account_id,day,month);
CREATE TABLE ongoing_operations (
 intent TEXT PRIMARY KEY, account_id TEXT NOT NULL, day TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('original','reply')), created_at INTEGER NOT NULL
);
CREATE TABLE ongoing_credit_state (
 account_id TEXT PRIMARY KEY, prepaid_micro_usd INTEGER NOT NULL CHECK(prepaid_micro_usd>=0),
 legacy_total_micro_usd INTEGER NOT NULL CHECK(legacy_total_micro_usd>=0), evidence_id TEXT NOT NULL
);
CREATE TABLE ongoing_cycles (
 account_id TEXT NOT NULL, cycle_start INTEGER NOT NULL, cycle_end INTEGER NOT NULL,
 confirmed_used_micro_usd INTEGER NOT NULL CHECK(confirmed_used_micro_usd>=0),
 pending_legacy_micro_usd INTEGER NOT NULL CHECK(pending_legacy_micro_usd>=0), evidence_id TEXT NOT NULL,
 provider_cycle_month TEXT NOT NULL,
 PRIMARY KEY(account_id,cycle_start), UNIQUE(account_id,provider_cycle_month), CHECK(cycle_end>cycle_start)
);
CREATE TABLE ongoing_legacy_carry (
 account_id TEXT PRIMARY KEY, legacy_total_micro_usd INTEGER NOT NULL CHECK(legacy_total_micro_usd>=0),
 initial_micro_usd INTEGER NOT NULL CHECK(initial_micro_usd>=0),
 unresolved_service_writes INTEGER NOT NULL CHECK(unresolved_service_writes>=0),
 unresolved_sends INTEGER NOT NULL CHECK(unresolved_sends>=0),
 refresh_unresolved INTEGER NOT NULL CHECK(refresh_unresolved IN (0,1)),
 unresolved_floor_micro_usd INTEGER NOT NULL CHECK(unresolved_floor_micro_usd>=0 AND unresolved_floor_micro_usd<=legacy_total_micro_usd),
 activation_day TEXT NOT NULL, activation_month TEXT NOT NULL,
 dates_uncertain INTEGER NOT NULL CHECK(dates_uncertain=1), created_at INTEGER NOT NULL
);
CREATE TABLE ongoing_maintenance (
 operation TEXT PRIMARY KEY NOT NULL, evidence_id TEXT NOT NULL, completed_at INTEGER NOT NULL
);
