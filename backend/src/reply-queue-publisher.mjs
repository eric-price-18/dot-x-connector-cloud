import { ReplyQueue, queueDeadlineEligibility } from './reply-queue.mjs';
import { ReplyQueueStore } from './reply-queue-store.mjs';
import { ServiceWrites } from './service-writes.mjs';
import { replyQueuePreflight } from './reply-queue-preflight.mjs';
import { validateWriteArguments } from './write-validation.mjs';
import { originalPrice } from './pricing.mjs';
import { assert } from './security.mjs';

// The existing publisher owns every grant, operation, quota and spend reservation.
// This adapter only records durable evidence around its normal transport call.
class TrackedPublisher extends ServiceWrites {
  async onIntentCreated(key) {
    const owned=await this.store.first(`UPDATE reply_queue_publisher_attempts SET service_intent_owned=1
      WHERE intent_key=? AND account_id=? AND phase='prepared' AND service_intent_owned=0 RETURNING intent_key`,key,this.binding().account);
    assert(owned,'QUEUE_INTENT_OWNERSHIP_UNCERTAIN',503);
  }
  async dispatch(x,path,token,payload,name,args,grantVersion,canary) {
    const binding=this.binding();
    const review=await this.store.first(`SELECT intent.reviewed_at,intent.expires_at,gate.claim_until,
      intent.review_claim_token,gate.claim_token,owner.expires_at AS grant_expires_at FROM reply_queue_intents intent
      JOIN reply_queue_accounts gate ON gate.account_id=intent.account_id
      JOIN accounts owner ON owner.id='primary' AND owner.x_user_id=intent.account_id
      WHERE intent.account_id=? AND intent.intent_key=?`,binding.account,args.idempotency_key);
    let stopped=null;
    const timeFailure=(row,now)=>!row||!Number.isSafeInteger(row.reviewed_at)||!Number.isSafeInteger(row.expires_at)
      ?'queue_approval_binding_mismatch':now>=row.expires_at?'planned_reply_expired'
      :row.reviewed_at>now||row.reviewed_at<=now-60?'queue_review_expired'
      :row.claim_until<=now||row.claim_token!==row.review_claim_token?'queue_claim_lost'
      :row.grant_expires_at<=now?'queue_dispatch_guard_failed':null;
    const stopGuard=async code=>{
      // This proof is written only while this invocation knows no transport call
      // happened. A failed ACK stays unknown unless durable proof is recovered.
      const sql=code==='planned_reply_expired'
        ?`UPDATE reply_queue_publisher_attempts SET expired_before_transport=1,no_dispatch_code=?
          WHERE intent_key=? AND account_id=? AND service_intent_owned=1
          AND phase IN ('prepared','may_dispatch') AND expired_before_transport=0 AND no_dispatch_code IS NULL RETURNING intent_key`
        :`UPDATE reply_queue_publisher_attempts SET no_dispatch_code=?
          WHERE intent_key=? AND account_id=? AND service_intent_owned=1
          AND phase IN ('prepared','may_dispatch') AND expired_before_transport=0 AND no_dispatch_code IS NULL RETURNING intent_key`;
      const proof=await this.store.first(sql,code,args.idempotency_key,binding.account);
      assert(proof?.intent_key===args.idempotency_key,'QUEUE_GUARD_PROOF_UNCERTAIN',503);
      stopped=code;
    };
    const early=timeFailure(review,this.clock());
    if(early){await stopGuard(early);return {state:'rejected',code:early};}
    const transport=x.xFetch;
    x.xFetch=async (...parameters)=>{
      const now=this.clock();
      const proof=await this.store.first(`UPDATE reply_queue_publisher_attempts SET phase='may_dispatch'
        WHERE intent_key=? AND account_id=? AND phase='prepared' AND service_intent_owned=1
        AND expired_before_transport=0 AND no_dispatch_code IS NULL
        AND EXISTS(SELECT 1 FROM reply_queue_items item
          JOIN reply_queue_intents frozen ON frozen.intent_key=item.intent_key AND frozen.account_id=item.account_id
          JOIN reply_queue_accounts gate ON gate.account_id=item.account_id
          JOIN accounts owner ON owner.id='primary' AND owner.x_user_id=item.account_id
          WHERE item.intent_key=reply_queue_publisher_attempts.intent_key AND item.account_id=reply_queue_publisher_attempts.account_id
          AND item.state='dispatching' AND frozen.state='dispatching'
          AND item.target_id=frozen.target_id AND item.author_id=frozen.author_id
          AND item.draft=frozen.draft AND item.context_ref=frozen.context_ref
          AND item.revision=frozen.review_revision AND item.claim_token=frozen.review_claim_token
          AND item.reviewed_at=frozen.reviewed_at AND item.expires_at=frozen.expires_at
          AND frozen.target_id=? AND frozen.author_id=? AND frozen.draft=?
          AND frozen.reviewed_at>? AND frozen.reviewed_at<=? AND frozen.expires_at>?
          AND gate.claim_token=frozen.review_claim_token AND gate.claim_until>?
          AND owner.issuer=? AND owner.subject=? AND owner.version=? AND owner.refresh_status='idle' AND owner.expires_at>?
          AND NOT EXISTS(SELECT 1 FROM reply_opt_outs stop WHERE stop.account_id=item.account_id
            AND (stop.author_id=item.author_id OR stop.source_post_id=item.target_id)))
        RETURNING intent_key,
          (SELECT reviewed_at FROM reply_queue_intents WHERE intent_key=reply_queue_publisher_attempts.intent_key) AS reviewed_at,
          (SELECT expires_at FROM reply_queue_intents WHERE intent_key=reply_queue_publisher_attempts.intent_key) AS expires_at,
          (SELECT review_claim_token FROM reply_queue_intents WHERE intent_key=reply_queue_publisher_attempts.intent_key) AS review_claim_token,
          (SELECT claim_token FROM reply_queue_accounts WHERE account_id=reply_queue_publisher_attempts.account_id) AS claim_token,
          (SELECT claim_until FROM reply_queue_accounts WHERE account_id=reply_queue_publisher_attempts.account_id) AS claim_until,
          (SELECT expires_at FROM accounts WHERE id='primary' AND x_user_id=reply_queue_publisher_attempts.account_id) AS grant_expires_at`,
      args.idempotency_key,binding.account,args.in_reply_to_post_id,args.in_reply_to_author_id,args.text,
      now-60,now,now,now,binding.issuer,binding.subject,grantVersion,now);
      const payloadMatches=name==='x_reply'&&path==='/2/tweets'&&payload.text===args.text
        &&payload.reply?.in_reply_to_tweet_id===args.in_reply_to_post_id;
      const code=timeFailure(proof??review,this.clock())??(!proof?'queue_dispatch_guard_failed':null)
        ??(!payloadMatches?'queue_approval_binding_mismatch':null);
      if(code){await stopGuard(code);throw Error(code);}
      // No await between the fresh clock/immutable-payload checks and transport.
      return transport(...parameters);
    };
    try {
      const outcome=await super.dispatch(x,path,token,payload,name,args,grantVersion,canary);
      return stopped?{state:'rejected',code:stopped}:outcome;
    } finally {x.xFetch=transport;}
  }
}
export class PublisherReplyQueue extends ReplyQueue {
  constructor(env,store,clock,connectorFactory) {
    const binding=new ServiceWrites(env,store,clock,()=>{throw Error('preflight cannot create connector');}).binding();
    super(store,binding.account,{clock});
    Object.assign(this,{env,connectorFactory});
  }
  publisher(tracked=false) {
    // Publisher Store carries ephemeral credit/refund state; never share it across runs.
    const store=new ReplyQueueStore(this.store.db,this.clock),Type=tracked?TrackedPublisher:ServiceWrites;
    return new Type(this.env,store,this.clock,()=>this.connectorFactory(store));
  }
  costFor(item) {return 20000+originalPrice(item.draft);}
  async eligibility(item) {
    const gate=await this.store.first('SELECT * FROM reply_queue_accounts WHERE account_id=?',this.account);
    if(await this.store.first(`SELECT intent_key FROM reply_queue_intents WHERE account_id=? AND state IN ('dispatching','unknown') LIMIT 1`,this.account))
      return {at:null,reason:'receipt_required'};
    const p=await replyQueuePreflight(this.publisher(),item);
    const at=p.ready?this.clock():p.retry_at;
    return queueDeadlineEligibility(item,{at:at===null?null:Math.max(at,item.due_at??this.clock(),gate?.next_send_at??0),reason:p.reason??'ready'},this.clock());
  }
  async publish(args) {
    const item=await this.store.first(`SELECT item.*,frozen.draft AS frozen_draft,frozen.context_ref AS frozen_context_ref,
      frozen.target_id AS frozen_target,frozen.author_id AS frozen_author,frozen.review_revision,frozen.review_claim_token
      FROM reply_queue_items item JOIN reply_queue_intents frozen ON frozen.intent_key=item.intent_key AND frozen.account_id=item.account_id
      WHERE item.account_id=? AND item.target_id=?`,this.account,args.in_reply_to_post_id);
    assert(item?.intent_key===args.idempotency_key&&item.state==='dispatching'&&item.draft===args.text
      &&item.frozen_draft===args.text&&item.context_ref===args.context_ref&&item.frozen_context_ref===args.context_ref
      &&item.frozen_target===item.target_id&&item.frozen_author===item.author_id
      &&item.review_revision===item.revision&&item.review_claim_token===item.claim_token,'QUEUE_INTENT_MISMATCH',409);
    const validated=validateWriteArguments('x_reply',{idempotency_key:args.idempotency_key,text:args.text,
      in_reply_to_post_id:item.target_id,in_reply_to_author_id:item.author_id});
    const started=await this.store.first(`INSERT INTO reply_queue_publisher_attempts(intent_key,account_id,phase,created_at)
      VALUES(?,?,'prepared',?) ON CONFLICT DO NOTHING RETURNING intent_key`,item.intent_key,this.account,this.clock());
    assert(started,'QUEUE_PUBLISH_ALREADY_ENTERED_DO_NOT_RETRY',409);
    const publisher=this.publisher(true);
    let result;
    try {result=await publisher.execute('x_reply',validated);} catch {return this.unknown(item.intent_key);}
    const proof=await this.store.first('SELECT * FROM reply_queue_publisher_attempts WHERE intent_key=? AND account_id=?',item.intent_key,this.account);
    const receipt=this.mapReceipt(result,proof);
    // A failed acknowledgement returns unknown. It never causes another publish.
    await this.store.run('UPDATE reply_queue_publisher_attempts SET receipt_json=? WHERE intent_key=? AND account_id=?',
      JSON.stringify(receipt),item.intent_key,this.account);
    return receipt;
  }
  unknown(key) {return {idempotency_key:key,state:'unknown',receipt_ref:`service-write:${key}`};}
  mapReceipt(receipt,proof) {
    const key=proof?.intent_key;
    if(!proof||proof.service_intent_owned!==1||receipt?.idempotency_key!==key)return this.unknown(receipt?.idempotency_key??key);
    const base={idempotency_key:key,receipt_ref:`service-write:${key}`};
    if(proof.expired_before_transport===1)return {...base,state:'rejected',dispatched:false,code:'planned_reply_expired'};
    if(proof.no_dispatch_code)return {...base,state:'rejected',dispatched:false,code:proof.no_dispatch_code};
    if(receipt.state==='succeeded'&&proof.phase==='may_dispatch')return {...base,state:'sent',post_id:receipt.post_id};
    if(receipt.state==='rejected')return {...base,state:'rejected',dispatched:proof.phase==='may_dispatch',code:receipt.code};
    return this.unknown(key);
  }
  async reconcile(key) {
    const proof=await this.store.first('SELECT * FROM reply_queue_publisher_attempts WHERE intent_key=? AND account_id=?',key,this.account);
    if(!proof)return this.settle(key,this.unknown(key));
    // Saved receipts were derived from owned intent and durable transport proof.
    if(proof.receipt_json) {
      const saved=JSON.parse(proof.receipt_json);
      if(saved.state!=='unknown')return this.settle(key,saved);
    }
    const result=await this.publisher().status(key);
    return this.settle(key,this.mapReceipt(result,proof));
  }
  async processOne(revalidate) {
    await this.init();
    // A recorded explicit STOP cancels every still-unsent item for that author.
    // No mutation of committed intents and no notification state is consulted.
    await this.store.run(`UPDATE reply_queue_items SET state='cancelled',due_at=NULL,reason='reply_author_opted_out',updated_at=?
      WHERE account_id=? AND state IN ('pending','blocked','approved')
      AND NOT EXISTS(SELECT 1 FROM reply_queue_intents WHERE intent_key=reply_queue_items.intent_key)
      AND EXISTS(SELECT 1 FROM reply_opt_outs WHERE account_id=reply_queue_items.account_id
        AND (author_id=reply_queue_items.author_id OR source_post_id=reply_queue_items.target_id))`,this.clock(),this.account);
    return super.runOne({revalidate,preflight:item=>replyQueuePreflight(this.publisher(),item),publish:args=>this.publish(args)});
  }
}
