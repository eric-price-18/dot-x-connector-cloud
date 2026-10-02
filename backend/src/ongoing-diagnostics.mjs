import { bindOwner } from './reads.mjs';
import { enabled } from './security.mjs';
import { allowance, ongoing, ongoingReplyLimit, periods } from './ongoing.mjs';
import { originalPrice } from './pricing.mjs';

// Called only after owner-session authentication; no tokens, text, IDs or X calls.
export async function ownerDiagnostics(env,store,clock) {
  bindOwner(env,await store.account());
  const result={enabled:ongoing(env),polling_enabled:enabled(env.READ_POLLING_ENABLED),
    calendar:'UTC',reply_ceiling:ongoingReplyLimit(env),minimum_spacing_seconds:900,
    reply_preflight_micro_usd:220000,reply_plain_preflight_micro_usd:20000+originalPrice('A useful response.'),reconciled:false};
  if(!result.enabled)return result;
  try {
    const a=await allowance(store,env);
    const counts=await store.first(`SELECT COUNT(*) AS attempts,MAX(created_at) AS latest
      FROM ongoing_operations WHERE account_id=? AND kind='reply' AND day=?`,env.X_EXPECTED_USER_ID,periods(clock()).day);
    return {...result,reconciled:true,claimed_reply_attempts_today:counts.attempts,
      // These are reservation-based local estimates, not provider billing balances.
      day_remaining_micro_usd:Math.max(0,a.day_remaining),month_remaining_micro_usd:Math.max(0,a.month_remaining),
      provider_remaining_micro_usd:Math.max(0,a.provider_remaining),credit_remaining_micro_usd:Math.max(0,a.credit_remaining)};
  } catch {return {...result,blocked_reason:'reconciliation_or_storage_unavailable'};}
}
