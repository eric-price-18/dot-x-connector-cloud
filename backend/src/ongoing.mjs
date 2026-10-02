import { assert, enabled } from './security.mjs';
export const ongoing = env => enabled(env.X_ONGOING_OPERATIONS_ENABLED);

export function periods(now) {
  const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:'UTC',year:'numeric',month:'2-digit',day:'2-digit'});
  const p=Object.fromEntries(formatter.formatToParts(new Date(now*1000)).map(v=>[v.type,v.value]));
  return {day:`${p.year}-${p.month}-${p.day}`,month:`${p.year}-${p.month}`};
}
export function dayStart(now) {
  const day=periods(now).day;
  let lo=now-27*3600,hi=now;
  while(hi-lo>1) {const mid=Math.floor((lo+hi)/2);if(periods(mid).day===day)hi=mid;else lo=mid;}
  return hi;
}
// Prior reservations remain liabilities, never a renewed credit grant. Reconciliation is
// owner-provided, evidence-bound and immutable; absent/changed evidence blocks.
export async function allowance(store,env) {
  const now=store.clock(),{day,month}=periods(now),account=env.X_EXPECTED_USER_ID;
  const row=await store.first(`SELECT r.*,c.prepaid_micro_usd,c.legacy_total_micro_usd,
    COALESCE((SELECT SUM(used_micro_usd) FROM x_credit_budgets WHERE account_id=?),0) AS legacy_now,
    COALESCE((SELECT SUM(amount) FROM ongoing_spend WHERE account_id=? AND day=?),0) AS day_used,
    COALESCE((SELECT SUM(amount) FROM ongoing_spend WHERE account_id=? AND month=?),0) AS month_used,
    COALESCE((SELECT SUM(amount) FROM ongoing_spend WHERE account_id=? AND kind='api'),0) AS credit_used,
    COALESCE((SELECT SUM(amount) FROM ongoing_spend WHERE account_id=? AND kind='api' AND created_at>=r.cycle_start AND created_at<r.cycle_end),0)+COALESCE((SELECT SUM(unresolved_micro_usd) FROM ongoing_spend WHERE account_id=r.account_id AND kind='api' AND created_at<r.cycle_start),0) AS cycle_reserved
    FROM ongoing_cycles r JOIN ongoing_credit_state c ON c.account_id=r.account_id
    JOIN ongoing_legacy_carry l ON l.account_id=c.account_id AND l.legacy_total_micro_usd=c.legacy_total_micro_usd AND l.dates_uncertain=1
    WHERE r.account_id=? AND r.cycle_start<=? AND r.cycle_end>?`,account,account,day,account,month,account,account,account,now,now);
  assert(row&&row.legacy_now===row.legacy_total_micro_usd,'ONGOING_RECONCILIATION_REQUIRED',503);
  return {...row,day_remaining:1000000-row.day_used,month_remaining:5000000-row.month_used,
    provider_remaining:5000000-row.confirmed_used_micro_usd-row.pending_legacy_micro_usd-row.cycle_reserved,
    credit_remaining:row.prepaid_micro_usd-row.credit_used};
}
export async function reserveOngoing(store,env,amount,headroom=0) {
  assert(Number.isSafeInteger(amount)&&amount>0&&Number.isSafeInteger(headroom)&&headroom>=0,'INVALID_RESERVATION');
  const now=store.clock(),{day,month}=periods(now),account=env.X_EXPECTED_USER_ID;
  assert(periods(now+90).day===day,'ONGOING_CALENDAR_BOUNDARY_PAUSE',429);
  const row=await store.first(`INSERT INTO ongoing_spend(account_id,day,month,amount,unresolved_micro_usd,kind,created_at)
    SELECT ?,?,?,?,?, 'api',? FROM ongoing_cycles r JOIN ongoing_credit_state c ON c.account_id=r.account_id
    JOIN ongoing_legacy_carry l ON l.account_id=c.account_id AND l.legacy_total_micro_usd=c.legacy_total_micro_usd AND l.dates_uncertain=1
    WHERE r.account_id=? AND r.cycle_start<=? AND r.cycle_end>?
    AND c.legacy_total_micro_usd=COALESCE((SELECT SUM(used_micro_usd) FROM x_credit_budgets WHERE account_id=?),0)
    AND ?+COALESCE((SELECT SUM(amount) FROM ongoing_spend WHERE account_id=? AND day=?),0)<=1000000
    AND ?+COALESCE((SELECT SUM(amount) FROM ongoing_spend WHERE account_id=? AND month=?),0)<=5000000
    AND ?+COALESCE((SELECT SUM(amount) FROM ongoing_spend WHERE account_id=? AND kind='api'),0)<=c.prepaid_micro_usd
    AND ?+r.confirmed_used_micro_usd+r.pending_legacy_micro_usd+COALESCE((SELECT SUM(amount) FROM ongoing_spend
      WHERE account_id=? AND kind='api' AND created_at>=r.cycle_start AND created_at<r.cycle_end),0)
      +COALESCE((SELECT SUM(unresolved_micro_usd) FROM ongoing_spend WHERE account_id=r.account_id AND kind='api' AND created_at<r.cycle_start),0)<=5000000
    RETURNING id,(SELECT cycle_end FROM ongoing_cycles WHERE account_id=ongoing_spend.account_id AND cycle_start<=ongoing_spend.created_at AND cycle_end>ongoing_spend.created_at) AS cycle_end`,account,day,month,amount,amount,now,account,now,now+90,account,
    amount+headroom,account,day,amount+headroom,account,month,amount+headroom,account,amount+headroom,account);
  assert(row,'ONGOING_SPEND_CAP_OR_RECONCILIATION',429);store.ongoingCycleEnd=row.cycle_end;return row.id;
}
export async function claimOperation(store,env,kind,key) {
  assert(['reply','original'].includes(kind),'INVALID_OPERATION');
  const raw=env.MAX_REPLIES_DAY??'1',configured=Number(raw);
  assert(typeof raw==='string'&&/^\d+$/.test(raw)&&Number.isSafeInteger(configured)&&configured>=0&&configured<=100,'INVALID_REPLY_LIMIT',503);
  const replyLimit=Math.min(configured,5);
  const {day}=periods(store.clock()),account=env.X_EXPECTED_USER_ID,now=store.clock();
  const row=await store.first(`INSERT INTO ongoing_operations(account_id,day,kind,intent,created_at)
    SELECT ?,?,?,?,? WHERE
    ((SELECT COUNT(*) FROM ongoing_operations WHERE account_id=? AND day=? AND kind=?) +
     (SELECT COUNT(*) FROM service_writes WHERE account_id=? AND operation=? AND idempotency_key<>?
       AND state IN ('pending','succeeded','unknown') AND created_at>=?
       AND NOT EXISTS(SELECT 1 FROM ongoing_operations WHERE intent=service_writes.idempotency_key)))<?
    AND (?='original' OR (NOT EXISTS(SELECT 1 FROM ongoing_operations WHERE account_id=? AND kind='reply' AND created_at>?)
    AND NOT EXISTS(SELECT 1 FROM service_writes WHERE account_id=? AND idempotency_key<>? AND operation='x_reply'
      AND state IN ('pending','succeeded','unknown') AND created_at>?)))
    RETURNING intent`,account,day,kind,key,now,account,day,kind,account,kind==='reply'?'x_reply':'x_create_original_post',key,dayStart(now),
    kind==='reply'?replyLimit:1,kind,account,now-900,account,key,now-900);
  assert(row,'ONGOING_OPERATION_LIMIT_OR_COOLDOWN',429);
}
