import { assert, SafeError } from './security.mjs';
import { SERVICE } from './service.mjs';
import { PublisherReplyQueue } from './reply-queue-publisher.mjs';
import { REPLY_QUEUE_LIMITS, queueDiscoveryTimes, queueDeadlineEligibility, queueSourceCompatible } from './reply-queue.mjs';
import { replyQueueWakeHandoff } from './reply-queue-wake.mjs';
import { replyQueueProcessorHandoff } from './reply-queue-processor.mjs';
import { validateWriteArguments } from './write-validation.mjs';
import { QUEUE_PAGE_SIZE, QUEUE_SCAN_SIZE, QUEUE_RESULT_MAX_BYTES, QUEUE_OPERATIONAL_HOLDS, queueMutates } from './reply-queue-policy.mjs';

const iso=seconds=>seconds===null||seconds===undefined?null:new Date(seconds*1000).toISOString();
const cursor=row=>row?{created_at:row.created_at,target_id:row.target_id}:null;
const cursorArgs=after=>[after?.created_at??-1,after?.created_at??-1,after?.target_id??''];
const short=value=>value===null||value===undefined?null:[...String(value)].slice(0,64).join('');
const itemView=row=>({target_id:row.target_id,author_id:row.author_id,root_id:row.root_id,state:row.state,
  intent_key:row.intent_key,intent_ref:`reply-queue-intent:${row.intent_key}`,receipt_ref:`service-write:${row.intent_key}`,
  reason:short(row.reason),due_at:iso(row.due_at),source_created_at:row.source_created_at,expires_at:iso(row.expires_at),revision:row.revision});
const noTransport=()=>{throw new SafeError('QUEUE_NETWORK_FORBIDDEN',503);};

const coreErrors=new Set(['QUEUE_CLAIM_LOST','QUEUE_APPROVAL_EXPIRED','QUEUE_REVISION_CONFLICT','QUEUE_PLANNED_REPLY_EXPIRED',
  'QUEUE_FRESH_MODEL_RECHECK_REQUIRED','QUEUE_NOT_DUE','QUEUE_COMMIT_UNCERTAIN_DO_NOT_PUBLISH']);
async function coreCall(action) {
  try{return await action();}catch(error){
    if(!(error instanceof SafeError)&&coreErrors.has(error?.message))throw new SafeError(error.message,409);
    throw error;
  }
}

// Seven operations remain transportless, including explicit approve/cancel.
// Only the separately constructed QueuePublishService can enter the publisher.
// There is no RPC for supplied receipts, resume, or intent key replacement.
export class QueueService extends PublisherReplyQueue {
  constructor(env,store,clock) {super(env,store,clock,noTransport);}
  async bound(initialize=false) {
    const publisher=this.publisher(),binding=publisher.binding(),account=await this.store.account();
    assert(account&&account.issuer===binding.issuer&&account.subject===binding.subject&&account.x_user_id===binding.account,
      'QUEUE_ACCOUNT_BINDING_MISMATCH',403);
    let row=await this.store.first('SELECT * FROM reply_queue_service_bindings WHERE account_id=?',this.account);
    if(!row) {
      // A preexisting unbound queue cannot be adopted by whoever links next.
      const legacy=await this.store.first(`SELECT
        EXISTS(SELECT 1 FROM reply_queue_items WHERE account_id=?) OR
        EXISTS(SELECT 1 FROM reply_queue_intents WHERE account_id=?) OR
        EXISTS(SELECT 1 FROM reply_queue_publisher_attempts WHERE account_id=?) OR
        EXISTS(SELECT 1 FROM reply_queue_accounts WHERE account_id=? AND (claim_token IS NOT NULL OR claim_until!=0 OR next_send_at!=0)) AS present`,
      this.account,this.account,this.account,this.account);
      assert(!legacy.present,'QUEUE_BINDING_INITIALIZATION_REQUIRED',409);
      if(!initialize)return;
      await this.store.run(`INSERT INTO reply_queue_service_bindings(account_id,service_subject,owner_issuer,owner_subject,created_at)
        SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM accounts WHERE id='primary' AND issuer=? AND subject=? AND x_user_id=?)
        AND NOT EXISTS(SELECT 1 FROM reply_queue_items WHERE account_id=?)
        AND NOT EXISTS(SELECT 1 FROM reply_queue_intents WHERE account_id=?)
        AND NOT EXISTS(SELECT 1 FROM reply_queue_publisher_attempts WHERE account_id=?)
        ON CONFLICT DO NOTHING`,this.account,SERVICE.subject,binding.issuer,binding.subject,this.clock(),
      binding.issuer,binding.subject,this.account,this.account,this.account,this.account);
      row=await this.store.first('SELECT * FROM reply_queue_service_bindings WHERE account_id=?',this.account);
    }
    assert(row&&publisher.matches(row,binding),'QUEUE_OWNER_BINDING_MISMATCH',403);
  }
  // Fixed SQL + bounded pages. Cursors are position hints, never authority.
  async page(after,limit,{active=false,due=false}={}) {
    const holds=QUEUE_OPERATIONAL_HOLDS.map(()=>'?').join(',');
    const sql=due?`SELECT * FROM reply_queue_items WHERE account_id=?
      AND state IN ('pending','blocked','approved') AND due_at IS NOT NULL AND due_at<=?
      AND (created_at>? OR (created_at=? AND target_id>?)) ORDER BY created_at,target_id LIMIT ?`
      :active?`SELECT * FROM reply_queue_items WHERE account_id=?
      AND state IN ('pending','blocked','approved')
      AND (due_at IS NOT NULL OR (state='blocked' AND due_at IS NULL AND reason IN (${holds})))
      AND NOT EXISTS(SELECT 1 FROM reply_queue_intents WHERE intent_key=reply_queue_items.intent_key)
      AND (created_at>? OR (created_at=? AND target_id>?)) ORDER BY created_at,target_id LIMIT ?`
      :`SELECT * FROM reply_queue_items WHERE account_id=?
      AND (created_at>? OR (created_at=? AND target_id>?)) ORDER BY created_at,target_id LIMIT ?`;
    const {results}=await this.store.statement(sql,this.account,...(due?[this.clock()]:active?QUEUE_OPERATIONAL_HOLDS:[]),...cursorArgs(after),limit+1).all();
    return {rows:results.slice(0,limit),scan_complete:results.length<=limit,
      next_after:results.length>limit?cursor(results[limit-1]):null};
  }
  async readiness(after) {
    const now=this.clock();
    const gate=await this.store.first('SELECT * FROM reply_queue_accounts WHERE account_id=?',this.account);
    const generation=gate?.candidate_generation??0;
    const page=after&&after.generation!==generation?{rows:[],scan_complete:false,next_after:null,restart_required:true}
      :await this.page(after,QUEUE_SCAN_SIZE,{active:true});
    const {results:counts}=await this.store.statement('SELECT state,COUNT(*) n FROM reply_queue_items WHERE account_id=? GROUP BY state',this.account).all();
    const needsReceipt=await this.store.first(`SELECT intent_key FROM reply_queue_intents
      WHERE account_id=? AND state IN ('dispatching','unknown') LIMIT 1`,this.account);
    let next=null;
    const candidates=[];
    for(const row of page.rows) {
      const raw=row.expires_at<=now?{at:null,reason:'planned_reply_expired'}:await this.eligibility(row);
      const eligible=queueDeadlineEligibility(row,raw,this.clock());
      const at=eligible.at===null?null:Math.max(eligible.at,gate?.claim_until??0);
      const wakeAt=at!==null&&at<row.expires_at?at:null;
      if(wakeAt!==null)next=next===null?wakeAt:Math.min(next,wakeAt);
      candidates.push({target_id:row.target_id,eligible_at:iso(wakeAt),reason:short(wakeAt===null&&at!==null?'planned_reply_expires_before_eligible':eligible.reason)});
    }
    const latest=await this.store.first('SELECT candidate_generation FROM reply_queue_accounts WHERE account_id=?',this.account);
    const restart=page.restart_required===true||(latest?.candidate_generation??0)!==generation;
    if(restart)next=null;
    const complete=!after&&page.scan_complete&&!restart;
    const value={version:1,account_id:this.account,observed_at:iso(now),next_wake_at:complete?iso(next):null,
      wake_key:`reply-queue:${this.account}`,readiness_complete:complete,scan_complete:page.scan_complete&&!restart,
      restart_required:restart,queue_generation:generation,
      next_after:!restart&&page.next_after?{...page.next_after,generation}:null,page_candidate_wake_at:iso(next),scan_limit:QUEUE_SCAN_SIZE,
      counts:Object.fromEntries(counts.map(row=>[row.state,row.n])),receipt_required:!!needsReceipt,
      claim_until:gate?.claim_until>now?iso(gate.claim_until):null,candidates,
      approval_required:true,send_authorized:false};
    value.wake_handoff=complete?replyQueueWakeHandoff(value):{version:1,action:'continue_scan',replace_key:value.wake_key,
      wake_at:null,scheduled:false,requires:'complete_queue_readiness_scan',next_after:value.next_after,restart_required:restart};
    value.processor_handoff=replyQueueProcessorHandoff(value);
    return value;
  }
  // Parent reconciliation calls status(); never use the core's mutating recover
  // or unbounded SELECT from this read surface.
  status() {return this.readiness();}
  async list(args) {
    const page=await this.page(args.after,args.limit??QUEUE_PAGE_SIZE);
    return {version:1,account_id:this.account,observed_at:iso(this.clock()),items:page.rows.map(itemView),
      next_after:page.next_after,has_more:!page.scan_complete,approval_required:true,send_authorized:false};
  }
  async ingest(records) {
    const unique=new Map(),legacy=new Set();
    for(const r of records) {
      assert(r.source_created_at<=this.clock(),'QUEUE_SOURCE_CREATED_AT_REQUIRED',400);
      const prior=unique.get(r.target_id),old=prior??await this.get(r.target_id);
      assert(!old||(old.author_id===r.author_id&&old.root_id===r.root_id),'QUEUE_TARGET_BINDING_CONFLICT',409);
      assert(!old||queueSourceCompatible(old,r.source_created_at),'QUEUE_SOURCE_BINDING_CONFLICT',409);
      if(!prior&&old?.source_created_at_known===0)legacy.add(r.target_id);
      unique.set(r.target_id,r);
    }
    await this.init();
    const now=this.clock();
    if(unique.size)await this.store.db.batch([...unique.values()].flatMap(r=>{
      const times=queueDiscoveryTimes(r,now);
      const insert=this.store.statement(`INSERT INTO reply_queue_items
        (account_id,target_id,author_id,root_id,state,intent_key,context_ref,due_at,created_at,updated_at,source_created_at,expires_at,source_created_at_known)
        VALUES(?,?,?,?,'pending',?,?,?,?,?,?,?,1) ON CONFLICT(account_id,target_id) DO NOTHING`,
      this.account,r.target_id,r.author_id,r.root_id,crypto.randomUUID(),r.context_ref,now,now,now,times.source_created_at,times.expires_at);
      return legacy.has(r.target_id)?[insert,this.legacySourceStatement(r)]:[insert];
    }));
    await this.expire();
    const items=[];
    for(const r of unique.values()) {
      const row=await this.get(r.target_id);
      assert(row.author_id===r.author_id&&row.root_id===r.root_id,'QUEUE_TARGET_BINDING_CONFLICT',409);
      assert(queueSourceCompatible(row,r.source_created_at),'QUEUE_SOURCE_BINDING_CONFLICT',409);
      items.push(itemView(row));
    }
    return {version:1,account_id:this.account,items,readiness:await this.readiness(),approval_required:true,send_authorized:false};
  }
  async claimPage(after) {
    await this.init();await this.recover();
    const now=this.clock(),token=crypto.randomUUID(),until=now+REPLY_QUEUE_LIMITS.reviewLease,binding=this.publisher().binding();
    const gate=await this.store.first(`UPDATE reply_queue_accounts SET claim_token=?,claim_until=?
      WHERE account_id=? AND claim_until<=? AND next_send_at<=?
      AND NOT EXISTS(SELECT 1 FROM reply_queue_intents WHERE account_id=? AND state IN ('dispatching','unknown'))
      AND EXISTS(SELECT 1 FROM accounts WHERE id='primary' AND issuer=? AND subject=? AND x_user_id=?) RETURNING account_id,candidate_generation`,
    token,until,this.account,now,now,this.account,binding.issuer,binding.subject,this.account);
    if(!gate)return {claim:null,reason:'account_not_claimable',scan_complete:false,next_after:null};
    try {
      const page=await this.candidatePage(after,QUEUE_SCAN_SIZE,{generation:gate.candidate_generation,nullDueReasons:QUEUE_OPERATIONAL_HOLDS});
      if(page.restart_required) {
        await this.release(token);
        return {claim:null,reason:'restart_scan',scan_complete:false,next_after:null,restart_required:true,queue_generation:page.generation};
      }
      const lease=async(item,due,reviewOnly)=>{
        const checkedAt=this.clock();
        const row=await this.store.first(`UPDATE reply_queue_items SET claim_token=?,updated_at=?,draft=NULL,reviewed_at=NULL,
          revision=revision+1,state=CASE WHEN state='approved' THEN 'pending' ELSE state END
          WHERE account_id=? AND target_id=? AND state IN ('pending','blocked','approved') AND expires_at>?
          AND NOT EXISTS(SELECT 1 FROM reply_queue_intents WHERE intent_key=reply_queue_items.intent_key)
          AND EXISTS(SELECT 1 FROM reply_queue_accounts WHERE account_id=? AND claim_token=? AND claim_until>? AND candidate_generation=?) RETURNING *`,
        token,checkedAt,this.account,item.target_id,checkedAt,this.account,token,checkedAt,page.generation);
        if(row)return {claim:{...itemView(row),context_ref:row.context_ref,context_is_untrusted:true,
          draft_present:row.draft!==null,claim_token:token,claim_until:iso(until),approval_required:true,send_authorized:false,
          review_only:reviewOnly,eligibility:{eligible_at:iso(due.at),reason:short(due.reason)}},
          reason:reviewOnly?'operational_hold_review_only':'model_review_required',scan_complete:page.scan_complete,next_after:page.next_after,queue_generation:page.generation};
        return null;
      };
      let held=null;
      for(const item of page.rows) {
        const due=queueDeadlineEligibility(item,await this.eligibility(item),this.clock());
        if(due.at!==null&&due.at<=this.clock()) {
          const claimed=await lease(item,due,false);if(claimed)return claimed;
        } else if(!held&&QUEUE_OPERATIONAL_HOLDS.includes(due.reason))held={item,due};
      }
      if(!held&&after&&page.scan_complete) {
        // A persisted operational hold may have appeared on an earlier page.
        // Revisit at most one such item only after the eligible scan completes.
        // The lease UPDATE below still fences the original scan generation.
        const item=await this.store.first(`SELECT * FROM reply_queue_items WHERE account_id=? AND state='blocked'
          AND due_at IS NULL AND expires_at>? AND reason IN (${QUEUE_OPERATIONAL_HOLDS.map(()=>'?').join(',')})
          AND NOT EXISTS(SELECT 1 FROM reply_queue_intents WHERE intent_key=reply_queue_items.intent_key)
          ORDER BY created_at,target_id LIMIT 1`,this.account,this.clock(),...QUEUE_OPERATIONAL_HOLDS);
        if(item) {
          const due=queueDeadlineEligibility(item,await this.eligibility(item),this.clock());
          if(due.at!==null&&due.at<=this.clock()) {
            const claimed=await lease(item,due,false);if(claimed)return claimed;
          } else if(QUEUE_OPERATIONAL_HOLDS.includes(due.reason))held={item,due};
        }
      }
      // Continue a partial scan before offering a held item for cancellation;
      // eligible work on later pages must keep priority over operational holds.
      if(held&&page.scan_complete) {
        const claimed=await lease(held.item,held.due,true);if(claimed)return claimed;
      }
      const generation=await this.store.first('SELECT candidate_generation FROM reply_queue_accounts WHERE account_id=?',this.account);
      await this.release(token);
      if(generation?.candidate_generation!==page.generation)return {claim:null,reason:'restart_scan',scan_complete:false,next_after:null,
        restart_required:true,queue_generation:generation?.candidate_generation??0};
      return {claim:null,reason:page.scan_complete?'no_due_item':'continue_scan',scan_complete:page.scan_complete,next_after:page.next_after,queue_generation:page.generation};
    } catch(error) {await this.release(token);throw error;}
  }
  async reconcileOwned(key) {
    const intent=await this.store.first(`SELECT intent_key FROM reply_queue_intents WHERE account_id=? AND intent_key=?
      AND EXISTS(SELECT 1 FROM reply_queue_items WHERE account_id=? AND intent_key=reply_queue_intents.intent_key)`,this.account,key,this.account);
    assert(intent,'QUEUE_INTENT_NOT_FOUND',404);
    const readiness=await this.reconcile(key);
    const row=await this.store.first('SELECT * FROM reply_queue_items WHERE account_id=? AND intent_key=?',this.account,key);
    return {version:1,account_id:this.account,item:itemView(row),readiness,approval_required:true,send_authorized:false};
  }
  async boundClaim(args,{approved=false}={}) {
    const row=await this.store.first(`SELECT item.*,gate.claim_token AS account_claim_token,gate.claim_until AS lease_until,
      EXISTS(SELECT 1 FROM reply_queue_intents WHERE intent_key=item.intent_key) AS frozen
      FROM reply_queue_items item JOIN reply_queue_accounts gate ON gate.account_id=item.account_id
      WHERE item.account_id=? AND item.target_id=?`,this.account,args.target_id);
    assert(row,'QUEUE_ITEM_NOT_FOUND',404);
    assert(row.intent_key===args.intent_key,'QUEUE_INTENT_MISMATCH',409);
    assert(!row.frozen,'QUEUE_INTENT_FROZEN',409);
    if(row.expires_at<=this.clock()) {
      await this.expire();
      throw new SafeError('QUEUE_PLANNED_REPLY_EXPIRED',409);
    }
    assert(row.claim_token===args.claim_token&&row.account_claim_token===args.claim_token&&row.lease_until>this.clock(),
      'QUEUE_CLAIM_LOST',409);
    assert(row.revision===args.expected_revision,'QUEUE_REVISION_CONFLICT',409);
    assert(['pending','blocked','approved'].includes(row.state),'QUEUE_ITEM_NOT_MUTABLE',409);
    if(approved)assert(row.state==='approved'&&row.reviewed_at>this.clock()-60&&row.reviewed_at<=this.clock(),
      'QUEUE_APPROVAL_EXPIRED',409);
    return {...row,expected_revision:args.expected_revision};
  }
  async approveClaim(args) {
    const claim=await this.boundClaim(args);
    validateWriteArguments('x_reply',{idempotency_key:claim.intent_key,text:args.text,
      in_reply_to_post_id:claim.target_id,in_reply_to_author_id:claim.author_id});
    const approved=await coreCall(()=>this.decide(claim,{action:'approve',text:args.text,context_ref:args.context_ref,
      rechecked_at:args.rechecked_at,conversation_checked:args.conversation_checked,value_checked:args.value_checked,
      stop_checked:args.stop_checked}));
    return {version:1,account_id:this.account,item:itemView(approved),approved_revision:approved.revision,
      claim_token:approved.claim_token,claim_until:iso(claim.lease_until),
      approval_expires_at:iso(Math.min(approved.expires_at,approved.reviewed_at+60,claim.lease_until)),
      publish_binding:{target_id:approved.target_id,intent_key:approved.intent_key,claim_token:approved.claim_token,expected_revision:approved.revision},
      next_operation:'x_reply_queue_publish',published:false};
  }
  async stopAuthor(claim,args) {
    const now=this.clock(),binding=this.publisher().binding(),marker=`explicit_stop:${args.request_id}`;
    const out=await this.store.db.batch([
      this.store.statement(`UPDATE reply_queue_items SET state='cancelled',reason=?,draft=NULL,context_ref='',due_at=NULL,
        reviewed_at=NULL,revision=revision+1,updated_at=? WHERE account_id=? AND target_id=? AND intent_key=? AND claim_token=?
        AND revision=? AND state IN ('pending','blocked','approved') AND expires_at>?
        AND NOT EXISTS(SELECT 1 FROM reply_queue_intents WHERE intent_key=reply_queue_items.intent_key)
        AND EXISTS(SELECT 1 FROM reply_queue_accounts WHERE account_id=? AND claim_token=? AND claim_until>?)
        AND EXISTS(SELECT 1 FROM accounts WHERE id='primary' AND issuer=? AND subject=? AND x_user_id=?) RETURNING intent_key`,
      marker,now,this.account,claim.target_id,claim.intent_key,claim.claim_token,args.expected_revision,now,
      this.account,claim.claim_token,now,binding.issuer,binding.subject,this.account),
      this.store.statement(`INSERT INTO reply_opt_outs(account_id,author_id,source_post_id,created_at)
        SELECT account_id,author_id,target_id,? FROM reply_queue_items
        WHERE account_id=? AND target_id=? AND intent_key=? AND claim_token=? AND revision=? AND state='cancelled' AND reason=?
        ON CONFLICT DO NOTHING`,now,this.account,claim.target_id,claim.intent_key,claim.claim_token,args.expected_revision+1,marker),
      this.store.statement(`UPDATE reply_queue_items SET state='cancelled',reason='reply_author_opted_out',draft=NULL,context_ref='',
        due_at=NULL,claim_token=NULL,reviewed_at=NULL,revision=revision+1,updated_at=?
        WHERE account_id=? AND author_id=? AND state IN ('pending','blocked','approved')
        AND NOT EXISTS(SELECT 1 FROM reply_queue_intents WHERE intent_key=reply_queue_items.intent_key)
        AND EXISTS(SELECT 1 FROM reply_queue_items selected WHERE selected.account_id=? AND selected.target_id=?
          AND selected.intent_key=? AND selected.claim_token=? AND selected.revision=? AND selected.state='cancelled' AND selected.reason=?)`,
      now,this.account,claim.author_id,this.account,claim.target_id,claim.intent_key,claim.claim_token,args.expected_revision+1,marker),
      this.store.statement(`UPDATE reply_queue_items SET reason='reply_author_opted_out',claim_token=NULL
        WHERE account_id=? AND target_id=? AND intent_key=? AND claim_token=? AND revision=? AND state='cancelled' AND reason=? RETURNING *`,
      this.account,claim.target_id,claim.intent_key,claim.claim_token,args.expected_revision+1,marker),
      this.store.statement(`UPDATE reply_queue_accounts SET claim_token=NULL,claim_until=0 WHERE account_id=? AND claim_token=?
        AND EXISTS(SELECT 1 FROM reply_queue_items WHERE account_id=? AND target_id=? AND intent_key=?
          AND revision=? AND state='cancelled' AND reason='reply_author_opted_out')`,
      this.account,claim.claim_token,this.account,claim.target_id,claim.intent_key,args.expected_revision+1)
    ]);
    // The request-specific marker exists only within this transaction. An old
    // opt-out or stale cancellation cannot manufacture proof for another cascade.
    assert(out.length===5&&out.every(r=>r.success!==false)&&out[0].results?.length===1
      &&out[0].results[0].intent_key===claim.intent_key&&out[3].results?.length===1
      &&out[3].results[0].intent_key===claim.intent_key,'QUEUE_CLAIM_LOST',409);
    return out[3].results[0];
  }
  async cancelClaim(args) {
    const claim=await this.boundClaim(args);
    const row=args.reason==='explicit_stop'?await this.stopAuthor(claim,args):await coreCall(()=>this.decide(claim,{action:'cancel',reason:args.reason}));
    return {version:1,account_id:this.account,item:itemView(row),outcome:'cancelled',
      author_opt_out_recorded:args.reason==='explicit_stop',published:false,next_operation:'x_reply_queue_readiness'};
  }
  async operation(name,args) {
    switch(name) {
      case 'x_reply_queue_ingest': return this.ingest(args.records);
      case 'x_reply_queue_list': return this.list(args);
      case 'x_reply_queue_claim': return {version:1,account_id:this.account,...await this.claimPage(args.after),approval_required:true,send_authorized:false};
      case 'x_reply_queue_reconcile': return this.reconcileOwned(args.intent_key);
      case 'x_reply_queue_readiness': return this.readiness(args.after);
      case 'x_reply_queue_approve': return this.approveClaim(args);
      case 'x_reply_queue_cancel': return this.cancelClaim(args);
      default: throw new SafeError('UNKNOWN_QUEUE_OPERATION',400);
    }
  }
  async execute(identity,args) {
    const mutate=queueMutates(identity.operation);
    await this.bound(mutate);
    const request_id=identity.request_id,binding=this.publisher().binding();
    if(!mutate) {
      const value={request_id,request_state:'completed',...await this.operation(identity.operation,args)};
      await this.bound();return value;
    }
    // No mutation runs until this durable tombstone is acknowledged. A crash
    // leaves started forever: a replay cannot claim another item after expiry.
    const inserted=await this.store.first(`INSERT INTO reply_queue_service_requests
      (request_id,account_id,service_subject,owner_issuer,owner_subject,operation,body_sha256,state,created_at)
      VALUES(?,?,?,?,?,?,?,'started',?) ON CONFLICT DO NOTHING RETURNING request_id`,request_id,this.account,
    SERVICE.subject,binding.issuer,binding.subject,identity.operation,identity.body_sha256,this.clock());
    if(!inserted) {
      const row=await this.store.first('SELECT * FROM reply_queue_service_requests WHERE request_id=?',request_id);
      assert(row&&this.publisher().matches(row,binding)&&row.operation===identity.operation&&row.body_sha256===identity.body_sha256,
        'QUEUE_REQUEST_REPLAY_MISMATCH',409);
      await this.bound();
      if(row.state==='completed')return {...JSON.parse(row.response_json),replayed:true};
      return {version:1,request_id,request_state:'indeterminate',replayed:true,approval_required:true,send_authorized:false,
        recovery:identity.operation==='x_reply_queue_publish'?'reconcile_original_intent_do_not_resend':'refresh_readiness_and_wait_for_any_review_lease_to_expire',
        ...(identity.operation==='x_reply_queue_publish'?{intent_key:args.intent_key}:{})};
    }
    const value={request_id,request_state:'completed',replayed:false,result_at:iso(this.clock()),...await this.operation(identity.operation,args)};
    const raw=JSON.stringify(value);
    assert(new TextEncoder().encode(raw).length<=QUEUE_RESULT_MAX_BYTES,'QUEUE_RESPONSE_BOUND',503);
    const saved=await this.store.first(`UPDATE reply_queue_service_requests SET state='completed',response_json=?,completed_at=?
      WHERE request_id=? AND state='started' RETURNING request_id`,raw,this.clock(),request_id);
    assert(saved,'QUEUE_REQUEST_ACK_UNCERTAIN',503);
    await this.bound();
    return value;
  }
}

// Constructed only after the service verifier has authenticated the exact
// publish operation. The factory uses the existing Worker-controlled transport.
export class QueuePublishService extends QueueService {
  constructor(env,store,clock,connectorFactory) {
    super(env,store,clock);
    assert(typeof connectorFactory==='function','QUEUE_PUBLISH_TRANSPORT_REQUIRED',503);
    this.connectorFactory=connectorFactory;
  }
  status() {return null;} // settle must not run another full readiness scan after POST
  async eligibility(item) {
    const due=await super.eligibility(item);
    this.lastEligibility={intent_key:item.intent_key,revision:item.revision,...due};
    return due;
  }
  async publishClaim(args) {
    const claim=await this.boundClaim(args,{approved:true});
    // Revalidate the exact stored publisher arguments; the request supplies none.
    validateWriteArguments('x_reply',{idempotency_key:claim.intent_key,text:claim.draft,
      in_reply_to_post_id:claim.target_id,in_reply_to_author_id:claim.author_id});
    let committed;
    try {committed=await coreCall(()=>this.commit(claim));}
    catch(error) {
      if(error?.code!=='QUEUE_NOT_DUE')throw error;
      const due=this.lastEligibility;
      assert(due&&due.intent_key===claim.intent_key&&due.revision===claim.revision,'QUEUE_PREFLIGHT_UNCERTAIN',503);
      // commit's single local preflight has not inserted an intent. CAS still
      // binds the same approved revision; a competing commit/cancel wins safely.
      const cancel=['reply_author_opted_out','planned_reply_expired'].includes(due.reason);
      const row=await coreCall(()=>this.decide(claim,cancel?{action:'cancel',reason:due.reason}
        :{action:'defer',reason:due.reason,retry_at:due.at}));
      return {version:1,account_id:this.account,item:itemView(row),outcome:cancel?'cancelled':'deferred',
        receipt:null,published:false,next_operation:'x_reply_queue_readiness'};
    }
    let receipt;
    try {receipt=await this.publish(committed);}catch {receipt=this.unknown(committed.idempotency_key);}
    // A settlement or response-ACK failure leaves the committed key fenced.
    // The caller reconciles it; a second publish request cannot pass boundClaim.
    await this.settle(committed.idempotency_key,receipt);
    const row=await this.store.first(`SELECT item.*,intent.receipt_json AS settled_receipt_json
      FROM reply_queue_items item JOIN reply_queue_intents intent ON intent.intent_key=item.intent_key AND intent.account_id=item.account_id
      WHERE item.account_id=? AND item.target_id=?`,this.account,claim.target_id);
    // A concurrent local reconciliation may have confirmed the receipt first.
    // Return that immutable persisted outcome rather than an older local guess.
    const settled=JSON.parse(row.settled_receipt_json);
    return {version:1,account_id:this.account,item:itemView(row),receipt:settled,outcome:row.state,
      published:settled.state==='sent',next_operation:settled.state==='unknown'?'x_reply_queue_reconcile':'x_reply_queue_readiness'};
  }
  async operation(name,args) {
    assert(name==='x_reply_queue_publish','QUEUE_PUBLISH_OPERATION_REQUIRED',403);
    return this.publishClaim(args);
  }
}
