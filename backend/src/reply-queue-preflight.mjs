import { allowance, ongoing, ongoingReplyLimit, periods, dayStart, monthEnd } from './ongoing.mjs';
import { originalPrice } from './pricing.mjs';
import { ownerContext } from './reads.mjs';
import { enabled, positiveLimit, open } from './security.mjs';
// Local reads only. This does not authorize HTTP or reserve a terminal key.
// Final atomic reservations and grant checks remain in ServiceWrites.
export async function replyQueuePreflight(publisher, item) {
  const {env,store,clock}=publisher,now=clock();
  const deny=(reason,retry_at=null)=>({ready:false,dispatched:false,reason,retry_at});
  try {
    const binding=publisher.binding();
    if(!ongoing(env)||!['LIVE_X_ENABLED','REPLY_ENABLED','X_OWN_THREAD_REPLIES_ENABLED',
      'SERVICE_WRITE_ENABLED','X_WRITE_STATUS_ENABLED'].every(k=>enabled(env[k])))return deny('reply_queue_authorization_paused');
    const account=await store.account();
    if(!account||account.issuer!==binding.issuer||account.subject!==binding.subject||account.x_user_id!==binding.account
      ||account.refresh_status!=='idle')return deny('reply_queue_grant_required');
    const tokens=await open(env.TOKEN_ENCRYPTION_KEY,account.encrypted_tokens,ownerContext(env));
    if(!Array.isArray(tokens.scopes)||!tokens.scopes.includes('tweet.write'))return deny('x_write_scope_required');
    const day=periods(now).day,start=dayStart(now),nextDay=dayStart(start+36*3600),hour=Math.floor(now/3600);
    if(periods(now+90).day!==day)return deny('ongoing_calendar_boundary_pause',nextDay);
    // One primary-database snapshot for independent advisory reads. Atomic
    // reservations and the final grant/STOP checks still run in the publisher.
    const state=await store.first(`WITH input(account,target,author,intent,day,start,next_day,hour_bucket) AS (VALUES(?,?,?,?,?,?,?,?))
      SELECT EXISTS(SELECT 1 FROM service_writes WHERE idempotency_key=input.intent) AS prior,
      EXISTS(SELECT 1 FROM reply_interactions WHERE account_id=input.account AND target_id=input.target) AS claimed,
      EXISTS(SELECT 1 FROM reply_opt_outs WHERE account_id=input.account
        AND (author_id=input.author OR source_post_id=input.target)) AS stopped,
      (SELECT COUNT(*) FROM reply_interactions WHERE account_id=input.account AND author_id=input.author
        AND created_at>=input.start AND created_at<input.next_day) AS author_count,
      (SELECT COUNT(*) FROM ongoing_operations WHERE account_id=input.account AND day=input.day AND kind='reply')+
      (SELECT COUNT(*) FROM service_writes WHERE account_id=input.account AND operation='x_reply'
        AND state IN ('pending','succeeded','unknown') AND created_at>=input.start
        AND NOT EXISTS(SELECT 1 FROM ongoing_operations WHERE intent=service_writes.idempotency_key)) AS reply_count,
      (SELECT MAX(t) FROM (
        SELECT created_at+900 t FROM ongoing_operations WHERE account_id=input.account AND kind='reply'
        UNION ALL SELECT (CASE WHEN state='succeeded' THEN updated_at ELSE created_at END)+900 t
          FROM service_writes WHERE account_id=input.account AND operation='x_reply'
          AND state IN ('pending','succeeded','unknown'))) AS next_reply_at,
      (SELECT until_at FROM cooldowns WHERE name='x') AS cooldown_until,
      COALESCE((SELECT used FROM budgets WHERE bucket='requests:day:'||input.day),0) AS requests_day,
      COALESCE((SELECT used FROM budgets WHERE bucket=input.hour_bucket),0) AS requests_hour,
      COALESCE((SELECT used FROM budgets WHERE bucket='writes:day:'||input.day),0) AS writes_day
      FROM input`,binding.account,item.target_id,item.author_id,item.intent_key,day,start,nextDay,`requests:hour:${hour}`);
    if(state.prior)return deny('existing_terminal_intent_requires_receipt');
    if(state.claimed)return deny('reply_interaction_already_claimed');
    if(state.stopped||item.author_id===binding.account)return deny(state.stopped?'reply_author_opted_out':'self_reply_not_supported');
    if(state.author_count>=2)return deny('reply_author_daily_limit',nextDay);
    let limit;try{limit=ongoingReplyLimit(env);}catch{return deny('invalid_reply_limit');}
    if(limit===0)return deny('replies_paused');
    if(state.reply_count>=limit)return deny('reply_daily_limit',nextDay);
    // Existing direct-publisher successes count from confirmation, not just reservation.
    if(state.next_reply_at>now)return deny('reply_spacing',state.next_reply_at);
    if(state.cooldown_until>now)return deny('x_rate_limit_cooldown',state.cooldown_until);
    // tokens() may refresh and verify identity. Reserve request room for all three
    // stages, while the existing publisher always reserves the .02 dollar envelope.
    const requests=account.expires_at<=now+60?3:1;
    for(const [bucket,amount,maximum,reset] of [
      ['requests_day',requests,positiveLimit(env,'MAX_X_REQUESTS_DAY',16,100),nextDay],
      ['requests_hour',requests,positiveLimit(env,'MAX_X_REQUESTS_HOUR',8,20),(hour+1)*3600],
      ['writes_day',1,positiveLimit(env,'MAX_WRITES_DAY',2,11),nextDay]
    ]) {
      if(maximum===0)return deny('local_quota_paused');
      if(state[bucket]+amount>maximum)return deny(bucket+'_exhausted',reset);
    }
    const a=await allowance(store,env),cost=20000+(item.draft?originalPrice(item.draft):15000);
    if(a.cycle_end<=now+90)return deny('ongoing_provider_boundary_pause');
    if(a.provider_remaining<cost||a.credit_remaining<cost)return deny('provider_or_prepaid_reconciliation_required');
    if(a.month_remaining<cost)return deny('monthly_spend_cap',monthEnd(now));
    if(a.day_remaining<cost)return deny('daily_spend_cap',nextDay);
    return {ready:true,cost_micro_usd:cost};
  } catch(error) {return deny(error.code?.toLowerCase()??'reply_queue_preflight_unavailable');}
}
