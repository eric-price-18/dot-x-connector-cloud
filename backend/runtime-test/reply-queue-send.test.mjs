// End-to-end signed queue send contract. Real Workerd + disposable D1; the
// harness intercepts every provider request and rejects unexpected egress.
import test from 'node:test';
import assert from 'node:assert/strict';
import {runtime,json} from './helpers.mjs';
import {serviceFixture} from '../test/service-fixtures.mjs';
import {writeScopes} from '../test/write-fixtures.mjs';
import {seal} from '../src/security.mjs';
import {ownerContext} from '../src/reads.mjs';
import {QUEUE_AUDIENCE,QUEUE_PATH,queueScope,QUEUE_TOOLS} from '../src/reply-queue-policy.mjs';
import {periods} from '../src/ongoing.mjs';
import {RUNTIME_NOW as BASE_RUNTIME_NOW} from './clock-fixture.mjs';
const RUNTIME_NOW=BASE_RUNTIME_NOW+3600; // Fixture activity lies within one UTC day.
import {createWorker} from '../src/worker.mjs';

const name=operation=>`x_reply_queue_${operation}`;
const record=(target='1002',author='5050',source=RUNTIME_NOW)=>({target_id:target,author_id:author,root_id:'1000',
  source_created_at:source,context_ref:`synthetic:browser:${target}`});
const success=result=>{assert.equal(result.response.status,200,JSON.stringify(result.body));assert(result.value);return result.value;};
const denied=result=>{assert(result.response.status>=400&&result.response.status<500,JSON.stringify(result.body));return result;};
const common=(claim,revision=claim.revision)=>({target_id:claim.target_id,intent_key:claim.intent_key,
  claim_token:claim.claim_token,expected_revision:revision});

async function setup(t,{allowRefresh=false}={}) {
  const f=await serviceFixture(RUNTIME_NOW);
  const h=await runtime(t,{...f.env,SERVICE_QUEUE_ENABLED:'true',SERVICE_WRITE_ENABLED:'true',X_WRITE_STATUS_ENABLED:'true',
    POST_ENABLED:'true',REPLY_ENABLED:'true',X_OWN_THREAD_REPLIES_ENABLED:'true',X_ONGOING_OPERATIONS_ENABLED:'true',LIVE_X_ENABLED:'true',
    MAX_REPLIES_DAY:'10',MAX_WRITES_DAY:'11',MAX_X_REQUESTS_DAY:'100',MAX_X_REQUESTS_HOUR:'20',
    X_CALLBACK_URL:f.env.PUBLIC_BASE_URL+'/x/callback'});
  await h.setTime(RUNTIME_NOW);
 const encrypted=await seal(h.bindings.TOKEN_ENCRYPTION_KEY,{access_token:'synthetic-send-token',refresh_token:'synthetic-send-refresh',scopes:writeScopes},ownerContext(h.bindings));
  await h.db.prepare('INSERT INTO accounts(id,issuer,subject,x_user_id,encrypted_tokens,expires_at,updated_at) VALUES(?,?,?,?,?,?,?)')
    .bind('primary',h.bindings.MCP_ISSUER,h.bindings.MCP_ALLOWED_SUBJECT,'4242',encrypted,RUNTIME_NOW+86400,RUNTIME_NOW).run();
  await h.db.prepare('INSERT INTO x_credit_budgets VALUES(?,?,?,?,?,?,?)')
    .bind(h.bindings.X_CREDIT_BUDGET_ID,'4242',5000000,0,0,Number(h.bindings.X_CREDIT_EXPIRES_AT),RUNTIME_NOW).run();
  await h.db.prepare('INSERT INTO ongoing_credit_state VALUES(?,?,?,?)').bind('4242',19970000,0,'a'.repeat(64)).run();
  await h.db.prepare('INSERT INTO ongoing_cycles VALUES(?,?,?,?,?,?,?)')
    .bind('4242',RUNTIME_NOW-86400,RUNTIME_NOW+30*86400,30000,0,'a'.repeat(64),'2035-01').run();
  await h.db.prepare("INSERT INTO ongoing_legacy_carry VALUES('4242',0,0,0,0,0,0,'2034-12-31','2034-12',1,?)").bind(RUNTIME_NOW).run();
  const posts=()=>h.xCalls().filter(call=>call.method==='POST'&&call.url.pathname==='/2/tweets');
  t.after(()=>assert(h.xCalls().every(call=>(call.method==='POST'&&call.url.pathname==='/2/tweets')
    ||(allowRefresh&&((call.method==='POST'&&call.url.pathname==='/2/oauth2/token')||(call.method==='GET'&&call.url.pathname==='/2/users/me')))),
    'provider calls must stay inside the explicitly allowed write/refresh fixture workflow'));
  async function request(operation,args={},claims={},options={}) {
    args={request_id:crypto.randomUUID(),...args};const tool=name(operation),raw=options.raw??f.body(tool,args);
    return f.request(raw,{claims:{aud:QUEUE_AUDIENCE,path:QUEUE_PATH,scope:queueScope(tool),iat:h.clock(),exp:h.clock()+45,
      jti:args.request_id,operation:tool,request_id:args.request_id,...claims}},{url:QUEUE_AUDIENCE,...options});
  }
  async function send(request) {
    const response=await h.mf.dispatchFetch(request.url,{method:request.method,headers:request.headers,redirect:'manual',body:await request.arrayBuffer()});
    const body=await response.json();return {response,body,value:body.result?.structuredContent};
  }
  const call=async(operation,args={},claims={},options={})=>send(await request(operation,args,claims,options));
  const item=target=>h.db.prepare('SELECT * FROM reply_queue_items WHERE target_id=?').bind(target??'1002').first();
  const rows=table=>h.db.prepare(`SELECT * FROM ${table}`).all().then(value=>value.results); // fixed test callers only
  const approval=(claim,changes={})=>({...common(claim),text:'A useful signed reply.',context_ref:claim.context_ref,
    rechecked_at:h.clock(),conversation_checked:true,value_checked:true,stop_checked:true,...changes});
  async function claimed(records=[record()]) {
    success(await call('ingest',{records}));const result=success(await call('claim'));assert(result.claim);return result.claim;
  }
  async function approved(claim,changes={}) {
    const result=success(await call('approve',approval(claim,changes)));
    assert.equal(result.item.state,'approved');assert.equal(result.item.intent_key,claim.intent_key);
    assert.equal(result.approved_revision,result.item.revision);
    return {...common(claim,result.approved_revision),approval:result};
  }
  const publishArgs=approved=>Object.fromEntries(Object.entries(approved).filter(([key])=>key!=='approval'));
  const noIntent=async()=>{assert.equal(posts().length,0);assert.equal((await rows('reply_queue_intents')).length,0);
    assert.equal((await rows('reply_queue_publisher_attempts')).length,0);assert.equal((await rows('service_writes')).length,0);};
  return {h,f,call,request,send,item,rows,posts,approval,claimed,approved,publishArgs,noIntent};
}

test('all eight signed queue tools expose scoped approve/publish/cancel with no caller-supplied publish text',()=>{
  assert.equal(QUEUE_TOOLS.length,8);
  for(const operation of ['approve','publish','cancel'])assert.equal(queueScope(name(operation)),'x:reply');
  const publish=QUEUE_TOOLS.find(tool=>tool.name===name('publish'));
  assert.equal(publish.inputSchema.additionalProperties,false);
  assert.deepEqual(Object.keys(publish.inputSchema.properties).sort(),
    ['request_id','target_id','intent_key','claim_token','expected_revision'].sort());
});

test('signed claim, fresh approval and publish make one POST; replay and reconciliation never reserve or send again',async t=>{
  const f=await setup(t),claim=await f.claimed(),approved=await f.approved(claim);
  await f.noIntent();const request_id=crypto.randomUUID(),args={...f.publishArgs(approved),request_id};
  const sent=success(await f.call('publish',args));assert.equal(sent.item.state,'sent');assert.equal(sent.item.intent_key,claim.intent_key);
  assert.equal(f.posts().length,1);assert.deepEqual(JSON.parse(f.posts()[0].body),
    {text:'A useful signed reply.',reply:{in_reply_to_tweet_id:'1002'}});
  assert.equal((await f.rows('service_writes'))[0].idempotency_key,claim.intent_key);
  assert.equal((await f.rows('ongoing_operations')).length,1);
  assert.equal((await f.h.db.prepare('SELECT SUM(amount) n FROM ongoing_spend').first()).n,15000);
  const ledger=await f.rows('ongoing_spend'),budgets=await f.rows('budgets');
  await f.h.restart();const replay=success(await f.call('publish',args));assert.equal(replay.replayed,true);assert.equal(replay.item.state,'sent');
  const reconciled=success(await f.call('reconcile',{intent_key:claim.intent_key}));assert.equal(reconciled.item.state,'sent');
  assert.equal(f.posts().length,1);assert.deepEqual(await f.rows('ongoing_spend'),ledger);assert.deepEqual(await f.rows('budgets'),budgets);
  assert.equal((await f.rows('reply_queue_intents')).length,1);
});

test('signed Workerd publish refreshes a same-owner grant and still reserves and posts exactly once',async t=>{
  const f=await setup(t,{allowRefresh:true}),claim=await f.claimed(),approved=await f.approved(claim);
  f.h.state.xScopes=writeScopes.join(' ');await f.h.db.prepare('UPDATE accounts SET expires_at=0').run();
  const args={...f.publishArgs(approved),request_id:crypto.randomUUID()},result=success(await f.call('publish',args));
  assert.equal(result.item.state,'sent');assert.equal(result.item.intent_key,claim.intent_key);
  assert.deepEqual(f.h.xCalls().map(call=>[call.method,call.url.pathname]),
    [['POST','/2/oauth2/token'],['GET','/2/users/me'],['POST','/2/tweets']]);
  const day=periods(f.h.clock()).day,hour=Math.floor(f.h.clock()/3600);
  for(const [bucket,n] of [[`writes:day:${day}`,1],[`requests:day:${day}`,3],[`requests:hour:${hour}`,3]])
    assert.equal((await f.h.db.prepare('SELECT used FROM budgets WHERE bucket=?').bind(bucket).first()).used,n);
  assert.equal((await f.h.db.prepare('SELECT SUM(amount) n FROM ongoing_spend').first()).n,35000);
  assert.equal((await f.rows('ongoing_operations')).length,1);assert.equal((await f.rows('reply_interactions')).length,1);
  assert.equal((await f.rows('service_writes')).length,1);
  success(await f.call('publish',args));assert.equal(f.h.xCalls().length,3);
});

test('approval requires current model checks, exact signed body and x:reply scope',async t=>{
  const f=await setup(t),claim=await f.claimed();
  for(const changes of [{conversation_checked:false},{value_checked:false},{stop_checked:false},
    {rechecked_at:RUNTIME_NOW-61},{rechecked_at:RUNTIME_NOW+1},{text:'@somebody unreviewed mention'}])
    denied(await f.call('approve',f.approval(claim,changes)));
  denied(await f.call('approve',f.approval(claim),{scope:'x:read'}));
  const args={...f.approval(claim),request_id:crypto.randomUUID()};
  denied(await f.call('approve',args,{}, {sendBody:f.f.body(name('approve'),{...args,text:'Changed after signing.'})}));
  assert.equal((await f.item()).state,'pending');assert.equal((await f.item()).draft,null);await f.noIntent();
});

test('wrong intent, target, revision or claim token cannot approve or publish another item',async t=>{
  const f=await setup(t),claim=await f.claimed();
  const mutations=[{intent_key:crypto.randomUUID()},{target_id:'9999'},{expected_revision:claim.revision+1},{claim_token:crypto.randomUUID()}];
  for(const changes of mutations)denied(await f.call('approve',f.approval(claim,changes)));
  await f.noIntent();const approved=await f.approved(claim);
  for(const changes of [{intent_key:crypto.randomUUID()},{target_id:'9999'},{expected_revision:approved.expected_revision+1},
    {claim_token:crypto.randomUUID()},{text:'Injected publish text.'}])
    denied(await f.call('publish',{...f.publishArgs(approved),...changes}));
  assert.equal((await f.item()).draft,'A useful signed reply.');await f.noIntent();
});

test('reclaimed review leases fence old approvals and old publish tokens',async t=>{
  const f=await setup(t),old=await f.claimed(),oldApproved=await f.approved(old);
  await f.h.setTime(RUNTIME_NOW+120);
  const current=success(await f.call('claim')).claim;assert(current);assert.notEqual(current.claim_token,old.claim_token);
  denied(await f.call('approve',f.approval(old)));
  denied(await f.call('publish',f.publishArgs(oldApproved)));await f.noIntent();
  const fresh=await f.approved(current,{text:'Rechecked after reclaim.'});
  assert.equal(success(await f.call('publish',f.publishArgs(fresh))).item.state,'sent');assert.equal(f.posts().length,1);
});

test('a replacement lease cannot inherit a still-fresh approval from the prior lease',async t=>{
  const f=await setup(t),old=await f.claimed();
  await f.h.setTime(RUNTIME_NOW+119);await f.approved(old);
  await f.h.setTime(RUNTIME_NOW+120);
  const replacement=success(await f.call('claim')).claim;assert(replacement);assert.notEqual(replacement.claim_token,old.claim_token);
  denied(await f.call('publish',common(replacement)));await f.noIntent();
  const reviewed=await f.approved(replacement,{text:'Approved by the replacement review.'});
  assert.equal(success(await f.call('publish',f.publishArgs(reviewed))).item.state,'sent');assert.equal(f.posts().length,1);
  assert.equal(JSON.parse(f.posts()[0].body).text,'Approved by the replacement review.');
});

test('revising an unsent approval invalidates the old revision and publishes only the exact new stored text',async t=>{
  const f=await setup(t),claim=await f.claimed(),old=await f.approved(claim);
  const nextClaim={...claim,revision:old.expected_revision};
  const fresh=await f.approved(nextClaim,{text:'Revised after a fresh model check.'});
  assert(fresh.expected_revision>old.expected_revision);
  denied(await f.call('publish',f.publishArgs(old)));await f.noIntent();
  success(await f.call('publish',f.publishArgs(fresh)));
  assert.equal(f.posts().length,1);assert.equal(JSON.parse(f.posts()[0].body).text,'Revised after a fresh model check.');
});

test('concurrent signed publish requests with distinct request UUIDs share one immutable send intent',async t=>{
  const f=await setup(t),claim=await f.claimed(),approved=await f.approved(claim);
  const args=Array.from({length:2},()=>({...f.publishArgs(approved),request_id:crypto.randomUUID()}));
  const results=await Promise.all(args.map(value=>f.call('publish',value)));
  assert(results.some(result=>result.value?.item?.state==='sent'),JSON.stringify(results.map(result=>result.body)));
  assert.equal(f.posts().length,1);assert.equal((await f.rows('service_writes')).length,1);
  assert.equal((await f.rows('ongoing_operations')).length,1);assert.equal((await f.rows('reply_queue_intents')).length,1);
  for(const value of args)await f.call('publish',value);
  assert.equal(f.posts().length,1);assert.equal((await f.h.db.prepare('SELECT SUM(amount) n FROM ongoing_spend').first()).n,15000);
});

test('discovery during review advances queue generation without invalidating the held item revision',async t=>{
  const f=await setup(t),claim=await f.claimed();
  success(await f.call('ingest',{records:[record('1003','6060')]}));
  const approved=await f.approved(claim);
  success(await f.call('ingest',{records:[record('1004','7070')]}));
  const sent=success(await f.call('publish',f.publishArgs(approved)));
  assert.equal(sent.item.state,'sent');assert.equal(sent.item.intent_key,claim.intent_key);
  assert.equal(f.posts().length,1);assert.equal(JSON.parse(f.posts()[0].body).reply.in_reply_to_tweet_id,'1002');
  assert.equal((await f.item('1003')).state,'pending');assert.equal((await f.item('1004')).state,'pending');
});

for(const decision of ['revise','cancel'])test(`concurrent ${decision} and publish have exactly one revision-CAS winner`,async t=>{
  const f=await setup(t),claim=await f.claimed(),approved=await f.approved(claim);
  const current={...claim,revision:approved.expected_revision};
  const decisionRequest=decision==='revise'
    ?f.call('approve',f.approval(current,{text:'Concurrent revised reply.'}))
    :f.call('cancel',{...common(current),reason:'no_value'});
  const [changed,sent]=await Promise.all([decisionRequest,f.call('publish',f.publishArgs(approved))]);
  if(sent.value?.item?.state==='sent') {
    denied(changed);assert.equal(f.posts().length,1);assert.equal((await f.item()).draft,'A useful signed reply.');
  } else {
    const value=success(changed);denied(sent);assert.equal(f.posts().length,0);
    if(decision==='cancel')assert.equal(value.item.state,'cancelled');
    else {
      assert.equal(value.item.state,'approved');
      success(await f.call('publish',common(claim,value.approved_revision)));
      assert.equal(f.posts().length,1);assert.equal(JSON.parse(f.posts()[0].body).text,'Concurrent revised reply.');
    }
  }
  assert.equal((await f.rows('reply_queue_intents')).length,f.posts().length);
  assert.equal((await f.rows('service_writes')).length,f.posts().length);
});

for(const cap of ['daily_dollars','monthly_dollars','ten_replies','two_per_author','eleven_writes','grant_revoked'])
test(`publish rechecks ${cap} after approval and defers without consuming its intent`,async t=>{
  const f=await setup(t),claim=await f.claimed(),approved=await f.approved(claim),{day,month}=periods(f.h.clock());
  if(cap==='daily_dollars'||cap==='monthly_dollars')await f.h.db.prepare(
    "INSERT INTO ongoing_spend(account_id,day,month,amount,unresolved_micro_usd,kind,created_at) VALUES('4242',?,?,?,0,'legacy',?)")
    .bind(cap==='daily_dollars'?day:'2034-12-30',month,cap==='daily_dollars'?990000:4990000,f.h.clock()).run();
  if(cap==='ten_replies')for(let i=0;i<10;i++)await f.h.db.prepare("INSERT INTO ongoing_operations VALUES(?,'4242',?,'reply',?)")
    .bind(crypto.randomUUID(),day,f.h.clock()-3600).run();
  if(cap==='two_per_author')for(let i=0;i<2;i++)await f.h.db.prepare('INSERT INTO reply_interactions VALUES(?,?,?,?,?,?)')
    .bind('4242',String(2000+i),crypto.randomUUID(),'5050',null,f.h.clock()-3600).run();
  if(cap==='eleven_writes')await f.h.db.prepare('INSERT INTO budgets VALUES(?,?,?)').bind(`writes:day:${day}`,11,f.h.clock()+86400).run();
  if(cap==='grant_revoked')await f.h.db.prepare("UPDATE accounts SET refresh_status='reconnect',version=version+1").run();
  const spend=await f.rows('ongoing_spend'),operations=await f.rows('ongoing_operations'),budgets=await f.rows('budgets');
  const args={...f.publishArgs(approved),request_id:crypto.randomUUID()},result=success(await f.call('publish',args));
  assert.equal(result.outcome,'deferred');assert.equal(result.item.intent_key,claim.intent_key);assert.equal(result.item.state,'blocked');
  assert.equal((await f.item()).draft,null);await f.noIntent();
  assert.equal(success(await f.call('publish',args)).replayed,true);
  assert.deepEqual(await f.rows('ongoing_spend'),spend);assert.deepEqual(await f.rows('ongoing_operations'),operations);
  assert.deepEqual(await f.rows('budgets'),budgets);
});

test('stored STOP between approval and publish cancels without a terminal intent or provider call',async t=>{
  const f=await setup(t),claim=await f.claimed(),approved=await f.approved(claim);
  await f.h.db.prepare('INSERT INTO reply_opt_outs VALUES(?,?,?,?)').bind('4242','5050','1002',f.h.clock()).run();
  const result=success(await f.call('publish',f.publishArgs(approved)));
  assert.equal(result.outcome,'cancelled');assert.equal(result.item.state,'cancelled');assert.equal(result.item.intent_key,claim.intent_key);
  await f.noIntent();
});

test('an operational NULL-due pause resumes the same pre-intent key only after recovery and fresh model approval',async t=>{
  const f=await setup(t),claim=await f.claimed(),approved=await f.approved(claim);
  await f.h.db.prepare('UPDATE ongoing_cycles SET confirmed_used_micro_usd=4999999').run();
  const paused=success(await f.call('publish',f.publishArgs(approved)));
  assert.equal(paused.outcome,'deferred');assert.equal((await f.item()).due_at,null);await f.noIntent();
  await f.h.db.prepare('UPDATE ongoing_cycles SET confirmed_used_micro_usd=30000').run();
  const current=success(await f.call('claim')).claim;assert(current);assert.equal(current.intent_key,claim.intent_key);
  assert.equal(current.review_only,false);assert.equal(current.eligibility.reason,'ready');
  denied(await f.call('publish',common(current)));await f.noIntent();
  const fresh=await f.approved(current,{text:'Useful after the pause cleared.'});
  const sent=success(await f.call('publish',f.publishArgs(fresh)));
  assert.equal(sent.item.state,'sent');assert.equal(sent.item.intent_key,claim.intent_key);assert.equal(f.posts().length,1);
});

test('an operational NULL-due item can be claimed for cancellation while its provider budget remains paused',async t=>{
  const f=await setup(t),claim=await f.claimed(),approved=await f.approved(claim);
  await f.h.db.prepare('UPDATE ongoing_cycles SET confirmed_used_micro_usd=4999999').run();
  success(await f.call('publish',f.publishArgs(approved)));await f.noIntent();
  const held=success(await f.call('claim'));assert(held.claim);assert.equal(held.reason,'operational_hold_review_only');
  assert.equal(held.claim.review_only,true);assert.equal(held.claim.eligibility.eligible_at,null);
  assert.equal(held.claim.intent_key,claim.intent_key);
  const cancelled=success(await f.call('cancel',{...common(held.claim),reason:'no_value'}));
  assert.equal(cancelled.item.state,'cancelled');assert.equal(cancelled.item.intent_key,claim.intent_key);
  assert.equal((await f.rows('reply_opt_outs')).length,0);await f.noIntent();
});

test('model no-value cancels one item; explicit STOP cancels all unsent items for its stored author',async t=>{
  const f=await setup(t),claim=await f.claimed([record(),record('1003')]);
  const cancelled=success(await f.call('cancel',{...common(claim),reason:'no_value'}));
  assert.equal(cancelled.item.state,'cancelled');assert.equal((await f.item('1003')).state,'pending');
  assert.equal((await f.rows('reply_opt_outs')).length,0);
  const second=success(await f.call('claim')).claim;assert.equal(second.target_id,'1003');
  success(await f.call('ingest',{records:[record('1004'),record('1005','6060')]}));
  const stopped=success(await f.call('cancel',{...common(second),reason:'explicit_stop'}));
  assert.equal(stopped.item.state,'cancelled');assert.equal((await f.item('1004')).state,'cancelled');
  assert.equal((await f.item('1005')).state,'pending');assert.equal((await f.rows('reply_opt_outs'))[0].author_id,'5050');
  await f.noIntent();
});

for(const delay of [61,120,86400])test(`approval delayed ${delay} seconds cannot cross the final send boundary`,async t=>{
  const f=await setup(t),claim=await f.claimed(),approved=await f.approved(claim);
  await f.h.setTime(RUNTIME_NOW+delay);
  denied(await f.call('publish',f.publishArgs(approved)));await f.noIntent();
  assert.equal((await f.item()).intent_key,claim.intent_key);
});

test('account or owner relink after approval refuses publication without changing the draft or key',async t=>{
  const f=await setup(t),claim=await f.claimed(),approved=await f.approved(claim),before=await f.item();
  await f.h.db.prepare("UPDATE accounts SET x_user_id='9999'").run();
  assert.equal((await f.call('publish',f.publishArgs(approved))).response.status,403);
  await f.h.db.prepare("UPDATE accounts SET x_user_id='4242',subject='different-owner'").run();
  assert.equal((await f.call('publish',f.publishArgs(approved))).response.status,403);
  assert.deepEqual(await f.item(),before);await f.noIntent();
});

test('lost request completion ACK after a confirmed POST replays indeterminate and recovers from the local receipt only',async t=>{
  const f=await setup(t),claim=await f.claimed(),approved=await f.approved(claim),args={...f.publishArgs(approved),request_id:crypto.randomUUID()};
  await f.h.db.prepare(`CREATE TRIGGER lose_publish_request_ack BEFORE UPDATE ON reply_queue_service_requests
    WHEN NEW.operation='x_reply_queue_publish' BEGIN SELECT RAISE(ABORT,'offline request acknowledgement lost'); END`).run();
  assert.equal((await f.call('publish',args)).response.status,500);assert.equal(f.posts().length,1);assert.equal((await f.item()).state,'sent');
  const intent=(await f.rows('reply_queue_intents'))[0];assert.equal(intent.draft,'A useful signed reply.');
  await f.h.db.prepare('DROP TRIGGER lose_publish_request_ack').run();await f.h.restart();
  const replay=success(await f.call('publish',args));assert.equal(replay.request_state,'indeterminate');
  assert.equal(success(await f.call('reconcile',{intent_key:claim.intent_key})).item.state,'sent');
  denied(await f.call('cancel',{...f.publishArgs(approved),reason:'no_value'}));
  assert.deepEqual((await f.rows('reply_queue_intents'))[0],intent);assert.equal(f.posts().length,1);
});

test('provider uncertainty stays unknown across replay, lease expiry, cancellation and local reconciliation',async t=>{
  const f=await setup(t),claim=await f.claimed(),approved=await f.approved(claim),args={...f.publishArgs(approved),request_id:crypto.randomUUID()};
  f.h.state.onX=call=>{assert.equal(call.method,'POST');return json({},503);};
  const sent=success(await f.call('publish',args));assert.equal(sent.item.state,'unknown');assert.equal(f.posts().length,1);
  const intent=(await f.rows('reply_queue_intents'))[0],proof=(await f.rows('reply_queue_publisher_attempts'))[0];
  await f.h.setTime(RUNTIME_NOW+3600);await f.h.restart();
  assert.equal(success(await f.call('publish',args)).replayed,true);
  assert.equal(success(await f.call('claim')).claim,null,'unknown frozen intents never enter operational-hold recovery');
  await f.call('publish',f.publishArgs(approved));
  denied(await f.call('cancel',{...f.publishArgs(approved),reason:'explicit_stop'}));
  assert.equal(success(await f.call('reconcile',{intent_key:claim.intent_key})).item.state,'unknown');
  assert.equal((await f.item()).intent_key,claim.intent_key);assert.equal((await f.rows('reply_queue_intents'))[0].draft,intent.draft);
  assert.equal((await f.rows('reply_queue_publisher_attempts'))[0].phase,proof.phase);
  assert.equal((await f.rows('reply_opt_outs')).length,0,'a rejected cancellation must not record a stop as a side effect');
  assert.equal(f.posts().length,1);assert.equal((await f.rows('service_writes')).length,1);
});

for(const {refresh,lateStop=false} of [{refresh:false},{refresh:true},{refresh:true,lateStop:true}])
test(`signed publish statement budget with ${refresh?'token refresh':'a current token'}${lateStop?' and a late STOP':''}`,async t=>{
  const f=await setup(t),claim=await f.claimed(),approved=await f.approved(claim);
  if(refresh)await f.h.db.prepare('UPDATE accounts SET expires_at=0').run();
  const raw=f.h.db,statements=new WeakMap(),queries=[],calls=[];
  let stopInjected=false;
  const wrap=(statement,sql)=>{
    const wrapped={bind:(...args)=>wrap(statement.bind(...args),sql),
      first:(...args)=>{queries.push(sql);return statement.first(...args);},
      all:(...args)=>{queries.push(sql);return statement.all(...args);},
      run:(...args)=>{queries.push(sql);return statement.run(...args);}};
    statements.set(wrapped,{statement,sql});return wrapped;
  };
  const db={prepare:sql=>wrap(raw.prepare(sql),sql),batch:async values=>{
    const entries=values.map(value=>statements.get(value));queries.push(...entries.map(value=>value.sql));
    const result=await raw.batch(entries.map(value=>value.statement));
    if(lateStop&&!stopInjected&&entries.some(value=>/INSERT INTO sends\(/.test(value.sql))) {
      // Model a distinct concurrent owner operation after the publisher's
      // acknowledged claim. This external write is not part of its query count.
      stopInjected=true;
      await raw.prepare('INSERT INTO reply_opt_outs(account_id,author_id,source_post_id,created_at) VALUES(?,?,?,?)')
        .bind('4242','5050','1002',RUNTIME_NOW).run();
    }
    return result;
  }};
  // The exact signed Worker handler runs against the same real D1 binding. Node
  // execution makes statement instrumentation possible without production hooks.
  // Independent tests above exercise that handler in Workerd as well.
  const worker=createWorker({clock:f.h.clock,logger:()=>{},xFetch:async(url,options)=>{
    const target=new URL(url);assert.equal(target.origin,'https://api.x.com');calls.push({path:target.pathname,method:options.method??'GET'});
    let data;
    if(target.pathname==='/2/oauth2/token')data={token_type:'bearer',expires_in:7200,scope:writeScopes.join(' '),access_token:'refreshed-synthetic',refresh_token:'refreshed-synthetic-refresh'};
    else if(target.pathname==='/2/users/me')data={data:{id:'4242',username:'synthetic'}};
    else {assert.equal(target.pathname,'/2/tweets');assert.equal(options.method,'POST');data={data:{id:'9001'}};}
    return new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}});
  }});
  const args={...f.publishArgs(approved),request_id:crypto.randomUUID()};
  const response=await worker.fetch(await f.request('publish',args),{...f.h.bindings,DB:db},{}),body=await response.json();
  t.diagnostic(JSON.stringify({mode:lateStop?'refresh_late_stop':refresh?'refresh':'current_token',d1_statements:queries.length,
    http:calls,...(queries.length>50?{statement_groups:queries.reduce((counts,sql)=>{
      const prefix=sql.replace(/\s+/g,' ').trim().slice(0,96);counts[prefix]=(counts[prefix]??0)+1;return counts;
    },{})}:{})}));
  assert.equal(response.status,200,JSON.stringify(body));assert.equal(body.result.structuredContent.item.state,lateStop?'blocked':'sent');
  assert.deepEqual(calls.map(call=>call.path),lateStop?['/2/oauth2/token','/2/users/me']
    :refresh?['/2/oauth2/token','/2/users/me','/2/tweets']:['/2/tweets']);
  assert.equal((await f.rows('ongoing_operations')).length,1);assert.equal((await f.rows('reply_interactions')).length,1);
  assert.equal((await f.rows('service_writes')).length,1);
  assert.equal((await f.h.db.prepare('SELECT SUM(amount) n FROM ongoing_spend').first()).n,refresh?35000:15000);
  const day=periods(f.h.clock()).day,hour=Math.floor(f.h.clock()/3600);
  for(const [bucket,n] of [[`writes:day:${day}`,1],[`requests:day:${day}`,refresh?3:1],[`requests:hour:${hour}`,refresh?3:1]])
    assert.equal((await f.h.db.prepare('SELECT used FROM budgets WHERE bucket=?').bind(bucket).first()).used,n);
  assert(queries.length<=50,`signed publish used ${queries.length} D1 statements; supported free-tier limit is 50`);
  if(lateStop) {
    assert.equal(stopInjected,true,'the STOP race must occur after the real dispatch claim is acknowledged');
    const receipt=body.result.structuredContent.receipt,proof=(await f.rows('reply_queue_publisher_attempts'))[0];
    assert.equal(receipt.state,'rejected');assert.equal(receipt.dispatched,false);
    assert.equal(proof.no_dispatch_code,'queue_dispatch_guard_failed');assert.equal(proof.phase,'prepared');
    assert.equal(proof.service_intent_owned,1);
    const replay=success(await f.call('publish',args));assert.equal(replay.replayed,true);
    success(await f.call('reconcile',{intent_key:claim.intent_key}));
    denied(await f.call('publish',f.publishArgs(approved)));
    assert.deepEqual((await f.rows('reply_queue_publisher_attempts'))[0],proof);
    assert.equal(f.posts().length,0);assert.equal(calls.filter(call=>call.path==='/2/tweets').length,0);
  }
});
