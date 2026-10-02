// No network, timers, credentials, or model policy here. Seconds and UTC buckets.
// D1 primary + atomic batch is the production storage contract, never local JSON.
export const REPLY_QUEUE_LIMITS = Object.freeze({day:10, authorDay:2, spacing:900,
  dayMicroUsd:1000000, monthMicroUsd:5000000, reviewLease:120});
export const REPLY_QUEUE_TTL_SECONDS=86400;
const mutable = "('pending','blocked','approved')";
const id = value => typeof value==='string' && /^[1-9][0-9]{0,18}$/.test(value);
const ref = value => typeof value==='string' && value.length>0 && value.length<=2048;
const check = (ok, code) => { if(!ok) throw new Error(code); };
const iso = seconds => seconds===null ? null : new Date(seconds*1000).toISOString();
// Source timestamps are integer Unix seconds. Legacy in-process callers may
// omit them; authenticated ingestion must require the browser-observed timestamp.
export function queueDiscoveryTimes(record,now) {
  const source=record.source_created_at??now;
  check(Number.isSafeInteger(source)&&source>=0&&source<=now,'QUEUE_SOURCE_CREATED_AT_REQUIRED');
  return {source_created_at:source,expires_at:Math.min(now,source)+REPLY_QUEUE_TTL_SECONDS};
}
export const queueSourceCompatible=(item,source)=>source===undefined||item.source_created_at===source
  ||(item.source_created_at_known===0&&source<=item.source_created_at);
export function queueDeadlineEligibility(item,due,now) {
  if(item.expires_at<=now)return {at:null,reason:'planned_reply_expired'};
  if(due.at!==null&&due.at>=item.expires_at)return {at:null,reason:'planned_reply_expires_before_eligible'};
  return due;
}
export const queueCandidateCursor=(row,generation)=>row?{generation,fair_at:row.fair_at,source_created_at:row.source_created_at,target_id:row.target_id}:null;
function window(now) {
  const d=new Date(now*1000);
  return {day:Math.floor(now/86400)*86400, dayEnd:(Math.floor(now/86400)+1)*86400,
    month:Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),1)/1000,
    monthEnd:Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,1)/1000};
}
export class ReplyQueue {
  constructor(store, account, {clock=()=>Math.floor(Date.now()/1000), uuid=()=>crypto.randomUUID(), costMicroUsd=200000}={}) {
    check(store?.db?.batch && store?.first && store?.statement,'QUEUE_D1_STORE_REQUIRED');
    check(id(account),'QUEUE_ACCOUNT_REQUIRED');
    check(Number.isSafeInteger(costMicroUsd)&&costMicroUsd>0&&costMicroUsd<=1000000,'QUEUE_COST_BOUND_REQUIRED');
    Object.assign(this,{store,account,clock,uuid,costMicroUsd});
  }
  async init() {
    // Schema is installed by versioned migrations, never ad-hoc admin calls.
    await this.store.run('INSERT INTO reply_queue_accounts(account_id) VALUES(?) ON CONFLICT DO NOTHING',this.account);
  }
  async discover(records) {
    check(Array.isArray(records)&&records.length<=100,'QUEUE_DISCOVERY_BOUND');
    for(const r of records) {
      check(id(r.target_id)&&id(r.author_id)&&id(r.root_id)&&ref(r.context_ref),'QUEUE_INVALID_DISCOVERY');
      const now=this.clock(),times=queueDiscoveryTimes(r,now);
      // Notification read/unread and new scan timestamps cannot reset an item.
      await this.store.run(`INSERT INTO reply_queue_items
        (account_id,target_id,author_id,root_id,state,intent_key,context_ref,due_at,created_at,updated_at,source_created_at,expires_at,source_created_at_known)
        VALUES(?,?,?,?,'pending',?,?,?,?,?,?,?,?) ON CONFLICT(account_id,target_id) DO NOTHING`,
      this.account,r.target_id,r.author_id,r.root_id,this.uuid(),r.context_ref,now,now,now,times.source_created_at,times.expires_at,r.source_created_at===undefined?0:1);
      let item=await this.get(r.target_id);
      check(item.author_id===r.author_id&&item.root_id===r.root_id,'QUEUE_TARGET_BINDING_CONFLICT');
      check(queueSourceCompatible(item,r.source_created_at),'QUEUE_SOURCE_BINDING_CONFLICT');
      if(r.source_created_at!==undefined&&item.source_created_at_known===0) {
        await this.legacySourceStatement(r).run();item=await this.get(r.target_id);
        check(queueSourceCompatible(item,r.source_created_at),'QUEUE_SOURCE_BINDING_CONFLICT');
      }
    }
    return this.status();
  }
  get(target) {return this.store.first('SELECT * FROM reply_queue_items WHERE account_id=? AND target_id=?',this.account,target);}
  legacySourceStatement(record) {
    const now=this.clock(),times=queueDiscoveryTimes(record,now);
    // A legacy fallback is not asserted source evidence. Adopt it once, only
    // while unsent, and never extend the first-seen deadline or revive a row.
    return this.store.statement(`UPDATE reply_queue_items SET source_created_at=?,source_created_at_known=1,
      expires_at=MIN(expires_at,?),reviewed_at=NULL,revision=revision+1,updated_at=?,
      state=CASE WHEN state='approved' THEN 'pending' ELSE state END
      WHERE account_id=? AND target_id=? AND author_id=? AND root_id=?
      AND source_created_at_known=0 AND source_created_at>=? AND state IN ${mutable}
      AND NOT EXISTS(SELECT 1 FROM reply_queue_intents WHERE intent_key=reply_queue_items.intent_key)`,
    times.source_created_at,times.expires_at,now,this.account,record.target_id,record.author_id,record.root_id,times.source_created_at);
  }
  async expire() {
    // Only pre-intent content is disposable. Every frozen intent/receipt survives.
    return this.store.run(`UPDATE reply_queue_items SET state='cancelled',reason='planned_reply_expired',
      draft=NULL,context_ref='',due_at=NULL,claim_token=NULL,reviewed_at=NULL,revision=revision+1,updated_at=?
      WHERE account_id=? AND state IN ${mutable} AND expires_at<=?
      AND NOT EXISTS(SELECT 1 FROM reply_queue_intents WHERE intent_key=reply_queue_items.intent_key)`,
    this.clock(),this.account,this.clock());
  }
  async candidatePage(after=null,limit=100,{due=true,generation=null,nullDueReasons=[]}={}) {
    check(Number.isSafeInteger(limit)&&limit>0&&limit<=100,'QUEUE_CANDIDATE_PAGE_BOUND');
    check(Array.isArray(nullDueReasons)&&nullDueReasons.length<=20&&nullDueReasons.every(reason=>typeof reason==='string'&&/^[a-z_]{1,64}$/.test(reason)),'QUEUE_HOLD_REASONS_INVALID');
    const held=nullDueReasons.length?` OR (state='blocked' AND due_at IS NULL AND reason IN (${nullDueReasons.map(()=>'?').join(',')}))`:'';
    const initial=generation??(await this.store.first('SELECT candidate_generation FROM reply_queue_accounts WHERE account_id=?',this.account))?.candidate_generation??0;
    const restart=()=>({rows:[],scan_complete:false,next_after:null,restart_required:true,generation:initial});
    if(after&&after.generation!==initial)return restart();
    // Least recently served root OR author first, newest source within each
    // fairness tier. A viral root cannot buy priority with many recent replies.
    const now=this.clock();
    const {results}=await this.store.statement(`WITH candidates AS (
      SELECT item.*, MAX(
        COALESCE((SELECT MAX(intent.dispatch_at) FROM reply_queue_intents intent
          JOIN reply_queue_items prior ON prior.account_id=intent.account_id AND prior.target_id=intent.target_id
          WHERE intent.account_id=item.account_id AND prior.root_id=item.root_id),0),
        COALESCE((SELECT MAX(intent.dispatch_at) FROM reply_queue_intents intent
          WHERE intent.account_id=item.account_id AND intent.author_id=item.author_id),0)) AS fair_at
      FROM reply_queue_items item WHERE account_id=? AND state IN ${mutable}
        AND expires_at>? AND (due_at IS NOT NULL${held}) ${due?'AND (due_at<=? OR due_at IS NULL)':''}
        AND NOT EXISTS(SELECT 1 FROM reply_queue_intents WHERE intent_key=item.intent_key))
      SELECT * FROM candidates WHERE fair_at>? OR (fair_at=? AND source_created_at<?)
        OR (fair_at=? AND source_created_at=? AND target_id>?)
      ORDER BY fair_at,source_created_at DESC,target_id LIMIT ?`,
    this.account,now,...nullDueReasons,...(due?[now]:[]),after?.fair_at??-1,after?.fair_at??-1,after?.source_created_at??0,
    after?.fair_at??-1,after?.source_created_at??0,after?.target_id??'',limit+1).all();
    const current=(await this.store.first('SELECT candidate_generation FROM reply_queue_accounts WHERE account_id=?',this.account))?.candidate_generation??0;
    if(current!==initial)return restart();
    return {rows:results.slice(0,limit),scan_complete:results.length<=limit,generation:initial,restart_required:false,
      next_after:results.length>limit?queueCandidateCursor(results[limit-1],initial):null};
  }
  async recover() {
    await this.expire();
    // Expired review leases are safely reclaimable; dispatch claims never are.
    await this.store.db.batch([
      this.store.statement(`UPDATE reply_queue_items SET state='unknown',reason='dispatch_receipt_required',updated_at=?
        WHERE account_id=? AND state='dispatching' AND updated_at<=?`,this.clock(),this.account,this.clock()-120),
      this.store.statement(`UPDATE reply_queue_intents SET state='unknown' WHERE account_id=? AND state='dispatching'
        AND intent_key IN (SELECT intent_key FROM reply_queue_items WHERE account_id=? AND state='unknown')`,this.account,this.account)
    ]);
  }
  async eligibility(item) {
    const now=this.clock(), w=window(now), L=REPLY_QUEUE_LIMITS;
    const gate=await this.store.first('SELECT * FROM reply_queue_accounts WHERE account_id=?',this.account);
    const uncertain=await this.store.first(`SELECT intent_key FROM reply_queue_intents WHERE account_id=?
      AND state IN ('dispatching','unknown') LIMIT 1`,this.account);
    if(uncertain)return {at:null,reason:'receipt_required'};
    const usage=await this.store.first(`SELECT
      COALESCE(SUM(CASE WHEN dispatch_at>=? THEN 1 ELSE 0 END),0) AS day_count,
      COALESCE(SUM(CASE WHEN dispatch_at>=? AND author_id=? THEN 1 ELSE 0 END),0) AS author_count,
      COALESCE(SUM(CASE WHEN dispatch_at>=? THEN cost_micro_usd ELSE 0 END),0) AS day_cost,
      COALESCE(SUM(CASE WHEN dispatch_at>=? THEN cost_micro_usd ELSE 0 END),0) AS month_cost
      FROM reply_queue_intents WHERE account_id=?`,w.day,w.day,item.author_id,w.day,w.month,this.account);
    let at=Math.max(now,item.due_at??now,gate?.next_send_at??0),reason='ready';
    if(usage.day_count>=L.day || usage.author_count>=L.authorDay || usage.day_cost+this.costMicroUsd>L.dayMicroUsd) {
      at=Math.max(at,w.dayEnd);reason=usage.author_count>=L.authorDay?'author_daily_cap':'daily_cap';
    }
    if(usage.month_cost+this.costMicroUsd>L.monthMicroUsd) {at=Math.max(at,w.monthEnd);reason='monthly_budget';}
    return queueDeadlineEligibility(item,{at,reason},this.clock());
  }
  async status() {
    await this.recover();
    const {results:items}=await this.store.statement(`SELECT * FROM reply_queue_items WHERE account_id=? ORDER BY created_at,target_id`,this.account).all();
    let next=null;
    const eligibility=new Map();
    const gate=await this.store.first('SELECT * FROM reply_queue_accounts WHERE account_id=?',this.account);
    for(const item of items) {
      if(!['pending','blocked','approved'].includes(item.state)||item.due_at===null)continue;
      const due=queueDeadlineEligibility(item,await this.eligibility(item),this.clock());
      eligibility.set(item.target_id,due);
      if(due.at!==null) {
        const at=Math.max(due.at,gate?.claim_until??0);
        if(at>=item.expires_at)continue;
        next=next===null?at:Math.min(next,at);
      }
    }
    return {version:1,account_id:this.account,next_wake_at:iso(next),
      wake_key:`reply-queue:${this.account}`,items:items.map(({target_id,state,intent_key,reason,due_at,revision,expires_at,source_created_at})=>
        ({target_id,state,intent_key,intent_ref:`reply-queue-intent:${intent_key}`,receipt_ref:`service-write:${intent_key}`,reason,
          due_at:iso(due_at),expires_at:iso(expires_at),source_created_at:iso(source_created_at),eligible_at:iso(eligibility.get(target_id)?.at??null),eligibility_reason:eligibility.get(target_id)?.reason??null,revision}))};
  }
  async claim() {
    await this.init();await this.recover();
    const now=this.clock(),token=this.uuid();
    const gate=await this.store.first(`UPDATE reply_queue_accounts SET claim_token=?,claim_until=?
      WHERE account_id=? AND claim_until<=? AND next_send_at<=?
      AND NOT EXISTS(SELECT 1 FROM reply_queue_intents WHERE account_id=? AND state IN ('dispatching','unknown')) RETURNING *`,
    token,now+REPLY_QUEUE_LIMITS.reviewLease,this.account,now,now,this.account);
    if(!gate)return null;
    let after=null;
    do {
      const page=await this.candidatePage(after,100,{generation:gate.candidate_generation});
      for(const item of page.rows) {
        const due=queueDeadlineEligibility(item,await this.eligibility(item),this.clock()),checkedAt=this.clock();
        if(due.at===null||due.at>checkedAt)continue;
        const row=await this.store.first(`UPDATE reply_queue_items SET claim_token=?,updated_at=?,draft=NULL,reviewed_at=NULL,revision=revision+1,
          state=CASE WHEN state='approved' THEN 'pending' ELSE state END
          WHERE account_id=? AND target_id=? AND state IN ${mutable} AND expires_at>?
          AND NOT EXISTS(SELECT 1 FROM reply_queue_intents WHERE intent_key=reply_queue_items.intent_key)
          AND EXISTS(SELECT 1 FROM reply_queue_accounts WHERE account_id=? AND claim_token=? AND claim_until>? AND candidate_generation=?) RETURNING *`,
        token,checkedAt,this.account,item.target_id,checkedAt,this.account,token,checkedAt,page.generation);
        if(row)return {...row,claim_token:token};
      }
      after=page.next_after;
    } while(after);
    await this.release(token);return null;
  }
  release(token) {return this.store.run(`UPDATE reply_queue_accounts SET claim_token=NULL,claim_until=0
    WHERE account_id=? AND claim_token=?`,this.account,token);}
  async decide(claim, decision) {
    check(['approve','cancel','defer'].includes(decision?.action),'QUEUE_DECISION_REQUIRED');
    check(claim.expected_revision===undefined||(Number.isSafeInteger(claim.expected_revision)&&claim.expected_revision>=0),'QUEUE_REVISION_REQUIRED');
    await this.expire();
    const now=this.clock();
    if(decision.action==='approve') {
      check(typeof decision.text==='string'&&decision.text.trim().length>0&&decision.text.length<=20000,'QUEUE_DRAFT_REQUIRED');
      check(ref(decision.context_ref)&&Number.isSafeInteger(decision.rechecked_at)&&decision.rechecked_at<=now&&decision.rechecked_at>now-60
        &&decision.conversation_checked===true&&decision.value_checked===true&&decision.stop_checked===true,
      'QUEUE_FRESH_MODEL_RECHECK_REQUIRED');
    }
    if(decision.action==='defer')check(decision.retry_at===null || (Number.isSafeInteger(decision.retry_at)&&decision.retry_at>now),'QUEUE_FUTURE_RETRY_REQUIRED');
    check(ref(decision.reason??'model_approved'),'QUEUE_REASON_REQUIRED');
    const row=await this.store.first(`UPDATE reply_queue_items SET state=?,draft=?,context_ref=?,reason=?,due_at=?,reviewed_at=?,
      revision=revision+1,updated_at=? WHERE account_id=? AND target_id=? AND intent_key=? AND claim_token=? AND state IN ${mutable} AND expires_at>?
      AND (? IS NULL OR revision=?)
      AND NOT EXISTS(SELECT 1 FROM reply_queue_intents WHERE intent_key=reply_queue_items.intent_key)
      AND EXISTS(SELECT 1 FROM reply_queue_accounts WHERE account_id=? AND claim_token=? AND claim_until>?) RETURNING *`,
    decision.action==='approve'?'approved':decision.action==='cancel'?'cancelled':'blocked',
    decision.action==='approve'?decision.text:null,decision.context_ref??claim.context_ref,decision.reason??'model_approved',
    decision.action==='defer'?decision.retry_at:decision.action==='cancel'?null:now,decision.action==='approve'?decision.rechecked_at:null,now,
    this.account,claim.target_id,claim.intent_key,claim.claim_token,now,claim.expected_revision??null,claim.expected_revision??null,this.account,claim.claim_token,now);
    check(row,'QUEUE_CLAIM_LOST');
    if(decision.action!=='approve')await this.release(claim.claim_token);
    return row;
  }
  costFor() {return this.costMicroUsd;}
  async commit(claim) {
    // Recheck time/budgets under the same account lease immediately before freezing.
    check(claim.expected_revision===undefined||(Number.isSafeInteger(claim.expected_revision)&&claim.expected_revision>=0),'QUEUE_REVISION_REQUIRED');
    await this.expire();
    const row=await this.get(claim.target_id);
    let now=this.clock();
    check(row?.expires_at>now,'QUEUE_PLANNED_REPLY_EXPIRED');
    check(row?.state==='approved'&&row.intent_key===claim.intent_key&&row.claim_token===claim.claim_token&&row.reviewed_at>now-60&&row.reviewed_at<=now,'QUEUE_APPROVAL_EXPIRED');
    check(claim.expected_revision===undefined||row.revision===claim.expected_revision,'QUEUE_REVISION_CONFLICT');
    const due=queueDeadlineEligibility(row,await this.eligibility(row),this.clock());
    now=this.clock();
    if(row.expires_at<=now){await this.expire();throw new Error('QUEUE_PLANNED_REPLY_EXPIRED');}
    check(row.reviewed_at>now-60&&row.reviewed_at<=now,'QUEUE_APPROVAL_EXPIRED');
    check(due.at!==null&&due.at<=now,'QUEUE_NOT_DUE');
    const out=await this.store.db.batch([
      this.store.statement(`INSERT INTO reply_queue_intents
        (intent_key,account_id,target_id,author_id,draft,context_ref,dispatch_at,cost_micro_usd,state,review_revision,review_claim_token,reviewed_at,expires_at)
        SELECT intent_key,account_id,target_id,author_id,draft,context_ref,?,?,'dispatching',revision,claim_token,reviewed_at,expires_at FROM reply_queue_items
        WHERE account_id=? AND target_id=? AND intent_key=? AND state='approved' AND claim_token=? AND revision=? AND expires_at>?
        AND reviewed_at>? AND reviewed_at<=?
        AND EXISTS(SELECT 1 FROM reply_queue_accounts WHERE account_id=? AND claim_token=? AND claim_until>?)
        ON CONFLICT DO NOTHING RETURNING intent_key`,now,this.costFor(row),this.account,row.target_id,claim.intent_key,claim.claim_token,row.revision,now,now-60,now,this.account,claim.claim_token,now),
      this.store.statement(`UPDATE reply_queue_items SET state='dispatching',updated_at=? WHERE account_id=? AND target_id=? AND intent_key=?
        AND state='approved' AND claim_token=? AND revision=? AND EXISTS(SELECT 1 FROM reply_queue_intents WHERE intent_key=reply_queue_items.intent_key) RETURNING intent_key`,
      now,this.account,row.target_id,claim.intent_key,claim.claim_token,row.revision)
    ]);
    // D1 changes metadata includes generation-trigger writes. RETURNING proves
    // the exact guarded top-level row was frozen and acknowledged.
    check(out.length===2&&out.every(r=>r.success!==false&&r.results?.length===1&&r.results[0].intent_key===row.intent_key),'QUEUE_COMMIT_UNCERTAIN_DO_NOT_PUBLISH');
    return {idempotency_key:row.intent_key,in_reply_to_post_id:row.target_id,text:row.draft,context_ref:row.context_ref};
  }
  async settle(key, receipt) {
    // Only a trusted authenticated publisher/status adapter may supply receipts.
    check(receipt?.idempotency_key===key&&ref(receipt.receipt_ref),'QUEUE_RECEIPT_BINDING_REQUIRED');
    check(['sent','unknown','rejected'].includes(receipt.state),'QUEUE_RECEIPT_INVALID');
    if(receipt.state==='sent')check(id(receipt.post_id),'QUEUE_POST_ID_REQUIRED');
    if(receipt.state==='rejected')check(typeof receipt.dispatched==='boolean','QUEUE_DISPATCH_PROOF_REQUIRED');
    const now=this.clock(), state=receipt.state==='rejected'?'cancelled':receipt.state;
    const expired=receipt.state==='rejected'&&receipt.code==='planned_reply_expired';
    const itemState=receipt.state==='rejected'&&receipt.dispatched===false&&!expired?'blocked':state;
    const out=await this.store.db.batch([
      // Gate update precedes receipt transition in the same transaction. Replayed
      // receipts cannot release another sender's lease or extend spacing forever.
      this.store.statement(`UPDATE reply_queue_accounts SET next_send_at=MAX(next_send_at,?),claim_token=NULL,claim_until=0
        WHERE account_id=? AND ?!='unknown' AND EXISTS(SELECT 1 FROM reply_queue_intents
          WHERE intent_key=? AND account_id=? AND state IN ('dispatching','unknown'))`,
      state==='sent'?now+REPLY_QUEUE_LIMITS.spacing:now,this.account,state,key,this.account),
      this.store.statement(`UPDATE reply_queue_intents SET state=?,receipt_ref=?,receipt_json=?,confirmed_at=?
        WHERE intent_key=? AND account_id=? AND state IN ('dispatching','unknown')`,state,receipt.receipt_ref,JSON.stringify(receipt),
      state==='sent'?now:null,key,this.account),
      this.store.statement(`UPDATE reply_queue_items SET state=?,reason=?,due_at=NULL,updated_at=?
        WHERE account_id=? AND intent_key=? AND state IN ('dispatching','unknown')
        AND EXISTS(SELECT 1 FROM reply_queue_intents WHERE intent_key=? AND state=?)`,
      itemState,expired?'planned_reply_expired':receipt.state==='rejected'?(receipt.dispatched?'terminal_intent_rejected':'specific_owner_request_required'):state==='unknown'?'receipt_required':'confirmed_sent',now,this.account,key,key,state)
    ]);
    check(out.every(r=>r.success!==false),'QUEUE_RECEIPT_COMMIT_UNCERTAIN');
    return this.status();
  }
  async resume(target) {
    await this.expire();
    // Authenticated owner/client explicitly resumes a pre-intent indefinite pause.
    const row=await this.store.first(`UPDATE reply_queue_items SET state='pending',due_at=?,reason='resumed',
      updated_at=?,revision=revision+1 WHERE account_id=? AND target_id=? AND state='blocked' AND expires_at>?
      AND NOT EXISTS(SELECT 1 FROM reply_queue_intents WHERE intent_key=reply_queue_items.intent_key)
      AND NOT EXISTS(SELECT 1 FROM reply_queue_accounts WHERE account_id=? AND claim_until>?) RETURNING *`,
    this.clock(),this.clock(),this.account,target,this.clock(),this.account,this.clock());
    check(row,'QUEUE_RESUME_DENIED');return row;
  }
  async newOwnerIntent(target, ownerRequestRef) {
    // Explicit workflow only; proof comes from a persisted trusted receipt.
    check(ref(ownerRequestRef),'QUEUE_SPECIFIC_OWNER_REQUEST_REQUIRED');
    await this.expire();
    const item=await this.get(target);
    const prior=await this.store.first('SELECT * FROM reply_queue_intents WHERE account_id=? AND intent_key=?',this.account,item?.intent_key??'');
    const proof=prior?.receipt_json?JSON.parse(prior.receipt_json):null;
    check(prior?.state==='cancelled'&&proof?.state==='rejected'&&proof.dispatched===false,'QUEUE_PROVEN_NO_DISPATCH_REQUIRED');
    check(item.expires_at>this.clock(),'QUEUE_PLANNED_REPLY_EXPIRED');
    check(!await this.store.first('SELECT intent_key FROM reply_queue_intents WHERE account_id=? AND owner_request_ref=?',this.account,ownerRequestRef),'QUEUE_OWNER_REQUEST_ALREADY_USED');
    // Batch CAS: bind the new explicit request to the old immutable receipt.
    const next=this.uuid(),now=this.clock();
    const result=await this.store.db.batch([
      this.store.statement(`UPDATE reply_queue_intents SET owner_request_ref=? WHERE intent_key=? AND owner_request_ref IS NULL
        AND EXISTS(SELECT 1 FROM reply_queue_items WHERE account_id=? AND target_id=? AND intent_key=? AND state='blocked' AND expires_at>?) RETURNING intent_key`,
      ownerRequestRef,prior.intent_key,this.account,target,prior.intent_key,now),
      this.store.statement(`UPDATE reply_queue_items SET intent_key=?,state='pending',draft=NULL,reason='specific_owner_request',due_at=?,
        claim_token=NULL,revision=revision+1,updated_at=? WHERE account_id=? AND target_id=? AND intent_key=? AND state='blocked' AND expires_at>?
        AND EXISTS(SELECT 1 FROM reply_queue_intents WHERE intent_key=? AND owner_request_ref=?) RETURNING intent_key`,
      next,now,now,this.account,target,prior.intent_key,now,prior.intent_key,ownerRequestRef)
    ]);
    check(result.length===2&&result.every((r,i)=>r.success!==false&&r.results?.length===1&&r.results[0].intent_key===(i===0?prior.intent_key:next)),'QUEUE_OWNER_REQUEST_CONFLICT');
    return this.get(target);
  }
  async runOne({revalidate,preflight,publish}) {
    const claim=await this.claim();
    if(!claim)return this.status();
    try {
      const decision=await revalidate(claim); // model refreshes conversation, STOP, value
      const approved=await this.decide(claim,decision);
      if(decision.action!=='approve')return this.status();
      // No publish intent or HTTP mutation is allowed inside preflight.
      const ready=await preflight(approved);
      if(ready?.ready!==true) {
        check(ready?.dispatched===false,'QUEUE_PREFLIGHT_NO_DISPATCH_REQUIRED');
        await this.decide(claim,{action:'defer',reason:ready.reason,retry_at:ready.retry_at});
        return this.status();
      }
      const args=await this.commit(claim); // ACK required before the sole publish call
      let receipt;
      try {receipt=await publish(args);} catch {receipt={idempotency_key:args.idempotency_key,state:'unknown',receipt_ref:`service-write:${args.idempotency_key}`};}
      return await this.settle(args.idempotency_key,receipt);
    } finally {await this.release(claim.claim_token);}
  }
}
