import { ongoing, claimOperation, reserveOngoing, periods } from './ongoing.mjs';
import { assert, digest, enabled, positiveLimit, readBodyBytes, SafeError } from './security.mjs';
import { SERVICE } from './service.mjs';
import { ReplyGuard, OPT_OUT_NOTICE, REPLY_PREFLIGHT_MICROUSD } from './reply-guard.mjs';
import { canaryMentionAuthorization } from './canary-mention.mjs';
import { isPostId } from './write-validation.mjs';

const receipt=(operation,key,state,code,post_id)=>({version:1,operation,idempotency_key:key,state,code,...(post_id?{post_id}:{})});
const codeOf=error=>error instanceof SafeError?error.code.toLowerCase():'internal_error';
const stalePendingSeconds=120;

// One immutable intent per UUID, one durable sends tombstone per API payload.
// Never release a claim or retry a network mutation, even after restart/timeout.
export class ServiceWrites {
  constructor(env,store,clock,connectorFactory) {
    this.env=env; this.store=store; this.clock=clock; this.connectorFactory=connectorFactory;
  }
  binding() {
    const env=this.env;
    assert(isPostId(env.SERVICE_X_ACCOUNT_ID) && env.SERVICE_X_ACCOUNT_ID===env.X_EXPECTED_USER_ID,
      'VERIFIED_SERVICE_ACCOUNT_REQUIRED',503);
    assert(typeof env.MCP_ISSUER==='string' && typeof env.MCP_ALLOWED_SUBJECT==='string' && env.MCP_ALLOWED_SUBJECT.length>0,
      'OWNER_BINDING_REQUIRED',503);
    return {issuer:env.MCP_ISSUER,subject:env.MCP_ALLOWED_SUBJECT,account:env.SERVICE_X_ACCOUNT_ID};
  }
  matches(row,binding) {
    return row.service_subject===SERVICE.subject && row.owner_issuer===binding.issuer
      && row.owner_subject===binding.subject && row.account_id===binding.account;
  }
  fromRow(row,key) {
    const stale=row.state==='pending' && row.created_at<=this.clock()-stalePendingSeconds;
    return receipt(row.operation,key,stale?'unknown':row.state,stale?'dispatch_outcome_unknown':row.code,row.post_id);
  }
  async status(key) {
    assert(enabled(this.env.X_WRITE_STATUS_ENABLED),'WRITE_STATUS_DISABLED',403);
    const binding=this.binding();
    const row=await this.store.first('SELECT * FROM service_writes WHERE idempotency_key=?',key);
    if(!row || !this.matches(row,binding)) return receipt(null,key,'not_found','write_not_found');
    return this.fromRow(row,key);
  }
  async finish(name,key,state,code,postId,keyHash) {
    const queries=[];
    if(keyHash) queries.push(this.store.statement("UPDATE sends SET status=?,result_id=? WHERE idempotency_hash=?",
      state==='succeeded'?'sent':'uncertain',postId??null,keyHash));
    queries.push(this.store.statement(`UPDATE service_writes SET state=?,code=?,post_id=?,updated_at=?
      WHERE idempotency_key=? AND state IN ('pending','unknown')`,state,code,postId??null,this.clock(),key));
    try {
      const outcomes=await this.store.db.batch(queries);
      assert(outcomes.length===queries.length && outcomes.every(value=>value.success!==false && value.meta?.changes===1),
        'LEDGER_COMMIT_UNCERTAIN',503);
    }
    catch { return receipt(name,key,'unknown','ledger_commit_uncertain'); }
    return receipt(name,key,state,code,postId);
  }
  async reserveCanary(binding,args,canary) {
    if(!canary)return;
    // Single fixed slot across accounts/configuration changes. A prior UUID may
    // not be reinterpreted as the canary. A crash before intent insertion keeps
    // this exact slot; only this same intent can resume without another send.
    await this.store.first(`INSERT INTO canary_mention
      (id,owner_issuer,owner_subject,account_id,idempotency_key,text_sha256,handle,expires_at,created_at)
      SELECT 'one-time-original',?,?,?,?,?,?,?,? WHERE NOT EXISTS
      (SELECT 1 FROM service_writes WHERE idempotency_key=?)
      ON CONFLICT DO NOTHING RETURNING id`,binding.issuer,binding.subject,binding.account,
      args.idempotency_key,canary.hash,canary.handle,canary.expires,this.clock(),args.idempotency_key);
    const row=await this.store.first("SELECT * FROM canary_mention WHERE id='one-time-original'");
    assert(row&&row.owner_issuer===binding.issuer&&row.owner_subject===binding.subject
      &&row.account_id===binding.account&&row.idempotency_key===args.idempotency_key
      &&row.text_sha256===canary.hash&&row.handle===canary.handle&&row.expires_at===canary.expires,
      'CANARY_MENTION_ALREADY_RESERVED',409);
  }
  async execute(name,args) {
    const key=args.idempotency_key;
    if(name==='x_get_write_status')return this.status(key);
    const isReply=name==='x_reply';
    if(isReply && (!enabled(this.env.X_OWN_THREAD_REPLIES_ENABLED)||!enabled(this.env.REPLY_ENABLED)))
      return receipt(name,key,'rejected','own_thread_replies_disabled');
    assert(name==='x_create_original_post'||name==='x_repost'||isReply,'UNKNOWN_WRITE_TOOL');
    if(isReply)assert(args.text.endsWith(OPT_OUT_NOTICE),'REPLY_OPT_OUT_NOTICE_REQUIRED');
    const binding=this.binding();
    const canary=await canaryMentionAuthorization(name,args,this.env,this.clock());
    if(!isReply) {
      assert(enabled(this.env.POST_ENABLED),'POST_DISABLED',403);
      assert(enabled(this.env[name==='x_repost'?'X_REPOSTS_ENABLED':'X_ORIGINAL_POSTS_ENABLED']), 'SERVICE_OPERATION_DISABLED',403);
    }
    // Require the existing egress kill switch even for injected test transports.
    assert(enabled(this.env.LIVE_X_ENABLED),'LIVE_X_DISABLED',503);
    const payload=name==='x_repost'?{tweet_id:args.post_id}:{text:args.text,...(isReply?{reply:{in_reply_to_tweet_id:args.in_reply_to_post_id}}:{})};
    const payloadHash=await digest(JSON.stringify({operation:name,payload}));
    await this.reserveCanary(binding,args,canary);
    const inserted=await this.store.first(`INSERT INTO service_writes
      (idempotency_key,service_subject,owner_issuer,owner_subject,account_id,operation,payload_hash,state,code,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,'pending','dispatch_pending',?,?) ON CONFLICT DO NOTHING RETURNING idempotency_key`,
      key,SERVICE.subject,binding.issuer,binding.subject,binding.account,name,payloadHash,this.clock(),this.clock());
    if(!inserted) {
      const row=await this.store.first('SELECT * FROM service_writes WHERE idempotency_key=?',key);
      if(!row || !this.matches(row,binding) || row.operation!==name || row.payload_hash!==payloadHash)
        return receipt(name,key,'rejected','idempotency_binding_conflict');
      return this.fromRow(row,key);
    }
    let x,keyHash,ownedSend=false,prepaidId;
    const replyGuard=isReply?new ReplyGuard(this.env,this.store,this.clock):null;
    try {
      if(isReply)await replyGuard.checkUnclaimed(args);
      x=this.connectorFactory();
      // Bind before any token read/refresh. Key tombstones match the legacy API
      // for original payloads, preserving duplicate suppression across routes.
      x.bind(await this.store.account());
      keyHash=await digest(`${x.context('send')}:${key}`);
      const sendHash=await digest(`${x.context('send')}:${JSON.stringify(payload)}`);
      if(!isReply) {
        const prior=await this.store.reserveSend(keyHash,sendHash);
        if(prior) {
          assert(isPostId(prior.id),'X_SEND_RESULT_INVALID',502);
          return this.finish(name,key,'succeeded','previously_succeeded',prior.id);
        }
        ownedSend=true;
      }
      if(ongoing(this.env)) {
        assert(name!=='x_repost','ONGOING_REPOST_NOT_AUTHORIZED',403);
        this.store.operationDay=periods(this.clock()).day;
        await claimOperation(this.store,this.env,isReply?'reply':'original',key);
        if(isReply) {
          // Reserve the full bounded workflow BEFORE any paid token/lookup call:
          // refresh + identity .02 + root/target .12 + four ancestors .24 + STOP .15 + dispatch .20.
          const day=periods(this.clock()).day;
          prepaidId=await reserveOngoing(this.store,this.env,REPLY_PREFLIGHT_MICROUSD);
          this.store.ongoingReservationDay=day;
          this.store.prepaidCredit={remaining:REPLY_PREFLIGHT_MICROUSD,consumed:0,resolved:0};
          x.store.prepaidCredit=this.store.prepaidCredit;
          x.store.ongoingReservationDay=day;
          x.store.ongoingCycleEnd=this.store.ongoingCycleEnd;
          x.store.operationDay=day;
        }
      }
      const grant=await x.tokens({withVersion:true});
      const tokens=grant.tokens;
      assert(tokens.scopes.includes('tweet.write'),'X_WRITE_SCOPE_REQUIRED',403);
      const interaction=isReply?await replyGuard.verify(x,tokens.access_token,args):null;
      if(isReply && !ongoing(this.env)) {
        const day=Math.floor(this.clock()/86400);
        await this.store.reserve(`replies:day:${day}`,1,positiveLimit(this.env,'MAX_REPLIES_DAY',1,5),(day+1)*86400);
      }
      if(name==='x_repost') {
        const day=Math.floor(this.clock()/86400);
        await this.store.reserve(`reposts:day:${day}`,1,positiveLimit(this.env,'MAX_REPOSTS_DAY',1,2),(day+1)*86400);
      }
      // Existing request/hour/day and total write budgets stay in force and are
      // pessimistic: unsuccessful/unknown dispatches are never refunded.
      await this.store.reserveX(this.env,0,true,undefined);
      const current=await this.store.account();x.bind(current);
      assert(current.version===grant.version && current.refresh_status==='idle','X_GRANT_SUPERSEDED',409);
      if(isReply) {
        await replyGuard.claimDispatch(binding,grant.version,interaction,keyHash,sendHash);
        ownedSend=true;
      }
      const path=name==='x_repost'?`/2/users/${binding.account}/retweets`:'/2/tweets';
      const outcome=await this.dispatch(x,path,tokens.access_token,payload,name,args,grant.version,canary);
      return this.finish(name,key,outcome.state,outcome.code,outcome.post_id,keyHash);
    } catch(error) {
      // Only pre-dispatch failures reach this catch. dispatch contains all
      // transport, response and post-dispatch cooldown errors as unknown.
      return this.finish(name,key,'rejected',codeOf(error),undefined,ownedSend?keyHash:undefined);
    } finally {
      // Release only budget for stages never attempted. Each attempted/unknown
      // call keeps its full bound; a crash keeps the entire original envelope.
      if(prepaidId && this.store.prepaidCredit) {
        try {await this.store.run(`UPDATE ongoing_spend SET amount=?,unresolved_micro_usd=? WHERE id=? AND kind='api' AND amount=?`,this.store.prepaidCredit.consumed,this.store.prepaidCredit.consumed-this.store.prepaidCredit.resolved,prepaidId,REPLY_PREFLIGHT_MICROUSD);} catch {}
      }
    }
  }
  async dispatch(x,path,token,payload,name,args,grantVersion,canary) {
    this.store.checkCreditWindow(this.env);
    if(ongoing(this.env)&&name==='x_reply') {
      const slot=await this.store.first(`UPDATE ongoing_operations SET created_at=? WHERE intent=? AND kind='reply'
        AND NOT EXISTS(SELECT 1 FROM ongoing_operations AS other WHERE other.account_id=ongoing_operations.account_id
          AND other.kind='reply' AND other.intent<>ongoing_operations.intent AND other.created_at>?) RETURNING intent`,
        this.clock(),args.idempotency_key,this.clock()-900);
      assert(slot,'ONGOING_DISPATCH_COOLDOWN',429);
      this.store.checkCreditWindow(this.env);
    }
    assert(!canary||this.clock()<canary.expires,'CANARY_MENTION_EXPIRED',403);
    const unknown=code=>({state:'unknown',code});
    let response;
    try {
      response=await x.xFetch(`https://api.x.com${path}`,{method:'POST',redirect:'manual',signal:AbortSignal.timeout(8000),
        headers:{accept:'application/json',authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(payload)});
    } catch { return unknown('x_dispatch_uncertain'); }
    if(response.status===429) {
      try {
        const reset=Number(response.headers.get('x-rate-limit-reset'));
        await this.store.setCooldown(Number.isFinite(reset)&&reset>this.clock()?reset:this.clock()+900);
      } catch { return unknown('cooldown_commit_uncertain'); }
      return {state:'rejected',code:'x_rate_limited'};
    }
    // Explicit X client-error responses establish rejection. A timeout, 5xx,
    // redirect, malformed body or unverified success never does.
    if(response.status===401) {
      try { await this.store.run("UPDATE accounts SET refresh_status='reconnect' WHERE id='primary' AND version=? AND refresh_status='idle'",grantVersion); }
      catch {return unknown('connection_state_commit_uncertain');}
    }
    if([400,401,403,404,405,409,410,413,415,422].includes(response.status))
      return {state:'rejected',code:response.status===401?'x_reconnect_required':'x_request_rejected'};
    if(!response.ok) return unknown('x_response_uncertain');
    try {
      assert(response.headers.get('content-type')?.toLowerCase().startsWith('application/json'),'X_INVALID_RESPONSE',502);
      const result=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readBodyBytes(response,65536)));
      assert(!result.errors,'X_INVALID_RESPONSE',502);
      if(name==='x_repost') {
        assert(result.data?.retweeted===true,'X_INVALID_RESPONSE',502);
        return {state:'succeeded',code:'repost_succeeded',post_id:args.post_id};
      }
      assert(isPostId(result.data?.id),'X_INVALID_RESPONSE',502);
      if(ongoing(this.env))await this.store.resolveCredit();
      return {state:'succeeded',code:name==='x_reply'?'reply_succeeded':'post_succeeded',post_id:result.data.id};
    } catch { return unknown('x_result_unverified'); }
  }
}
