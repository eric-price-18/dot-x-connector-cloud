import { assert, enabled } from './security.mjs';
import { periods } from './ongoing.mjs';
import { bindOwner } from './reads.mjs';
export function maintenanceGate(env) {
  assert(enabled(env.ONGOING_MAINTENANCE_ENABLED),'ONGOING_MAINTENANCE_DISABLED',403);
  for(const key of ['LIVE_X_ENABLED','READ_POLLING_ENABLED','POST_ENABLED','REPLY_ENABLED',
    'X_ONGOING_OPERATIONS_ENABLED','SERVICE_WRITE_ENABLED','X_ORIGINAL_POSTS_ENABLED','X_REPOSTS_ENABLED','X_OWN_THREAD_REPLIES_ENABLED'])
    assert(!enabled(env[key]),'MAINTENANCE_REQUIRES_ACTIVITY_SHUTDOWN',409);
}
export const RECONCILIATION_SCHEMA=[
  "-- Additive only. No production rows or prior authorizations are changed.\nCREATE TABLE ongoing_spend (\n id INTEGER PRIMARY KEY, account_id TEXT NOT NULL, day TEXT NOT NULL, month TEXT NOT NULL,\n amount INTEGER NOT NULL CHECK(amount>=0), unresolved_micro_usd INTEGER NOT NULL DEFAULT 0 CHECK(unresolved_micro_usd>=0 AND unresolved_micro_usd<=amount), kind TEXT NOT NULL CHECK(kind IN ('api','legacy')), created_at INTEGER NOT NULL\n)",
  "CREATE INDEX ongoing_spend_periods ON ongoing_spend(account_id,day,month)",
  "CREATE TABLE ongoing_operations (\n intent TEXT PRIMARY KEY, account_id TEXT NOT NULL, day TEXT NOT NULL,\n kind TEXT NOT NULL CHECK(kind IN ('original','reply')), created_at INTEGER NOT NULL\n)",
  "CREATE TABLE ongoing_credit_state (\n account_id TEXT PRIMARY KEY, prepaid_micro_usd INTEGER NOT NULL CHECK(prepaid_micro_usd>=0),\n legacy_total_micro_usd INTEGER NOT NULL CHECK(legacy_total_micro_usd>=0), evidence_id TEXT NOT NULL\n)",
  "CREATE TABLE ongoing_cycles (\n account_id TEXT NOT NULL, cycle_start INTEGER NOT NULL, cycle_end INTEGER NOT NULL,\n confirmed_used_micro_usd INTEGER NOT NULL CHECK(confirmed_used_micro_usd>=0),\n pending_legacy_micro_usd INTEGER NOT NULL CHECK(pending_legacy_micro_usd>=0), evidence_id TEXT NOT NULL,\n provider_cycle_month TEXT NOT NULL,\n PRIMARY KEY(account_id,cycle_start), UNIQUE(account_id,provider_cycle_month), CHECK(cycle_end>cycle_start)\n)",
  "CREATE TABLE ongoing_legacy_carry (\n account_id TEXT PRIMARY KEY, legacy_total_micro_usd INTEGER NOT NULL CHECK(legacy_total_micro_usd>=0),\n initial_micro_usd INTEGER NOT NULL CHECK(initial_micro_usd>=0),\n unresolved_service_writes INTEGER NOT NULL CHECK(unresolved_service_writes>=0),\n unresolved_sends INTEGER NOT NULL CHECK(unresolved_sends>=0),\n refresh_unresolved INTEGER NOT NULL CHECK(refresh_unresolved IN (0,1)),\n unresolved_floor_micro_usd INTEGER NOT NULL CHECK(unresolved_floor_micro_usd>=0 AND unresolved_floor_micro_usd<=legacy_total_micro_usd),\n activation_day TEXT NOT NULL, activation_month TEXT NOT NULL,\n dates_uncertain INTEGER NOT NULL CHECK(dates_uncertain=1), created_at INTEGER NOT NULL\n)",
  "CREATE TABLE ongoing_maintenance (\n operation TEXT PRIMARY KEY NOT NULL, evidence_id TEXT NOT NULL, completed_at INTEGER NOT NULL\n)"
];
function integer(v) {return Number.isSafeInteger(v)&&v>=0;}
export function reconciliationManifest(env,now) {
  assert(typeof env.ONGOING_RECONCILIATION_JSON==='string'&&env.ONGOING_RECONCILIATION_JSON.length<20000,'RECONCILIATION_MANIFEST_REQUIRED',503);
  const m=JSON.parse(env.ONGOING_RECONCILIATION_JSON);
  const keys=['account_id','observed_at','cycle_start','cycle_end','provider_cycle_month','confirmed_used_micro_usd','confirmed_prepaid_micro_usd','evidence_id','auto_recharge_off','exclusive_billing'];
  assert(m&&typeof m==='object'&&!Array.isArray(m)&&typeof m.account_id==='string'&&/^[1-9][0-9]{0,18}$/.test(m.account_id)&&Object.keys(m).length===keys.length&&keys.every(k=>Object.hasOwn(m,k))&&m.account_id===env.X_EXPECTED_USER_ID
    &&m.auto_recharge_off===true&&m.exclusive_billing===true&&/^[a-f0-9]{64}$/.test(m.evidence_id)
    &&['observed_at','cycle_start','cycle_end','confirmed_used_micro_usd','confirmed_prepaid_micro_usd'].every(k=>integer(m[k]))
    &&m.observed_at<=now&&m.observed_at>=now-3600&&m.cycle_start<=now&&m.cycle_end>now+90&&m.cycle_end-m.cycle_start<=35*86400
    &&m.confirmed_used_micro_usd<=5000000,'INVALID_RECONCILIATION',400);
  // This template supports evidence-confirmed calendar-month provider cycles only.
  // Bind each allowance to the confirmed month, not the narrower operating
  // window. The inner intersection is safe for offsets UTC-12 through UTC+14.
  assert(typeof m.provider_cycle_month==='string'&&/^\d{4}-(0[1-9]|1[0-2])$/.test(m.provider_cycle_month),'INVALID_PROVIDER_CYCLE',400);
  const [year,monthNumber]=m.provider_cycle_month.split('-').map(Number);
  const safeStart=Date.UTC(year,monthNumber-1,1,12)/1000;
  const safeEnd=Date.UTC(year,monthNumber,1)/1000-14*3600;
  assert(m.cycle_start>=safeStart&&m.cycle_end<=safeEnd,'UNSAFE_PROVIDER_WINDOW',400);
  return m;
}
export async function reconcileOngoing(store,env) {
  maintenanceGate(env);
  bindOwner(env,await store.account());
  // Require the shipped schema applied by the supported D1 migration command.
  for(const sql of RECONCILIATION_SCHEMA) {
    const match=/CREATE TABLE (\w+)/.exec(sql);if(!match)continue;
    const existing=await store.first("SELECT sql FROM sqlite_master WHERE type='table' AND name=?",match[1]);
    const normalize=value=>value.slice(value.indexOf('CREATE TABLE')).replace(/\s+/g,' ').trim();
    assert(existing&&normalize(existing.sql)===normalize(sql),'ONGOING_SCHEMA_MIGRATION_REQUIRED',409);
  }
  const now=store.clock(),m=reconciliationManifest(env,now);
  assert(!await store.first('SELECT provider_cycle_month FROM ongoing_cycles WHERE account_id=? AND provider_cycle_month=?',m.account_id,m.provider_cycle_month),'RECONCILIATION_ALREADY_COMPLETE',409);
  const old=await store.first('SELECT account_id FROM ongoing_credit_state WHERE account_id=?',m.account_id);
  const {day,month}=periods(now);
  const statements=[];
  if(!old) {
    // This is internal fixed-purpose migration, not a ledger read/export API.
    // Aggregate and unresolved-state evidence are captured INSIDE one D1 batch.
    // The entire old reservation total remains a liability, with no reductions.
    statements.push(store.statement(`INSERT INTO ongoing_legacy_carry
      SELECT ?,total,initial,service_unknown,send_unknown,refresh_unknown,
        MAX(service_unknown,send_unknown)*200000+refresh_unknown*20000,?,?,1,?
      FROM (SELECT
        COALESCE((SELECT SUM(used_micro_usd) FROM x_credit_budgets WHERE account_id=?),0) AS total,
        COALESCE((SELECT SUM(initial_micro_usd) FROM x_credit_budgets WHERE account_id=?),0) AS initial,
        (SELECT COUNT(*) FROM service_writes WHERE account_id=? AND state IN ('pending','unknown')) AS service_unknown,
        (SELECT COUNT(*) FROM sends WHERE status IN ('pending','uncertain')) AS send_unknown,
        CASE WHEN EXISTS(SELECT 1 FROM accounts WHERE x_user_id=? AND refresh_status<>'idle') THEN 1 ELSE 0 END AS refresh_unknown
      )`,m.account_id,day,month,now,m.account_id,m.account_id,m.account_id,m.account_id));
    statements.push(store.statement(`INSERT INTO ongoing_credit_state(account_id,prepaid_micro_usd,legacy_total_micro_usd,evidence_id)
      SELECT account_id,MAX(0,?-legacy_total_micro_usd),legacy_total_micro_usd,? FROM ongoing_legacy_carry WHERE account_id=?`,
      m.confirmed_prepaid_micro_usd,m.evidence_id,m.account_id));
    statements.push(store.statement(`INSERT INTO ongoing_spend(account_id,day,month,amount,kind,created_at)
      SELECT account_id,activation_day,activation_month,legacy_total_micro_usd,'legacy',created_at
      FROM ongoing_legacy_carry WHERE account_id=?`,m.account_id));
  }
  // A NULL guarded account fails NOT NULL and rolls back the entire transaction
  // on overlap, changed legacy ledger, missing carry, or insufficient credits.
  // Existing prepaid authorization is never increased or rewritten.
  statements.push(store.statement(`INSERT INTO ongoing_cycles(account_id,cycle_start,cycle_end,confirmed_used_micro_usd,pending_legacy_micro_usd,evidence_id,provider_cycle_month)
    SELECT CASE WHEN
      c.legacy_total_micro_usd=(SELECT COALESCE(SUM(used_micro_usd),0) FROM x_credit_budgets WHERE account_id=c.account_id)
      AND c.legacy_total_micro_usd=l.legacy_total_micro_usd AND l.dates_uncertain=1
      AND MAX(0,?-c.legacy_total_micro_usd)>=c.prepaid_micro_usd-COALESCE((SELECT SUM(amount) FROM ongoing_spend WHERE account_id=c.account_id AND kind='api'),0)
      AND NOT EXISTS(SELECT 1 FROM ongoing_cycles WHERE account_id=c.account_id AND cycle_start<? AND cycle_end>?)
      THEN c.account_id ELSE NULL END,?,?,?,c.legacy_total_micro_usd,?,?
    FROM ongoing_credit_state c JOIN ongoing_legacy_carry l ON l.account_id=c.account_id WHERE c.account_id=?`,
    m.confirmed_prepaid_micro_usd,m.cycle_end,m.cycle_start,m.cycle_start,m.cycle_end,m.confirmed_used_micro_usd,m.evidence_id,m.provider_cycle_month,m.account_id));
  // Marker creation must also fail if no cycle row was inserted; replay is a
  // uniqueness error. No caller may choose SQL, totals, old dates or a refund.
  statements.push(store.statement(`INSERT INTO ongoing_maintenance VALUES(
    CASE WHEN EXISTS(SELECT 1 FROM ongoing_cycles WHERE account_id=? AND cycle_start=? AND evidence_id=?)
      THEN ? ELSE NULL END,?,?)`,m.account_id,m.cycle_start,m.evidence_id,'reconcile:'+m.cycle_start,m.evidence_id,now));
  await store.db.batch(statements);
  return {reconciled:true};
}
