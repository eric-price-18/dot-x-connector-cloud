// Offline fault matrix: real disposable D1, real queue/publisher, and an injected
// transport that cannot leave this process. Faults affect only the chosen Store.
import test from 'node:test';
import assert from 'node:assert/strict';
import {runtime} from './helpers.mjs';
import {writeFixture,writeScopes} from '../test/write-fixtures.mjs';
import {seal,configuration} from '../src/security.mjs';
import {ownerContext} from '../src/reads.mjs';
import {Store} from '../src/storage.mjs';
import {XConnector} from '../src/x.mjs';
import {PublisherReplyQueue} from '../src/reply-queue-publisher.mjs';
import {RUNTIME_NOW as BASE_RUNTIME_NOW} from './clock-fixture.mjs';
const RUNTIME_NOW=BASE_RUNTIME_NOW+3600; // Fixture activity lies within one UTC day.

const record=(target='1002',author='5050')=>({target_id:target,author_id:author,root_id:'1000',context_ref:`synthetic:browser:${target}`});
const faultMessage='OFFLINE_INJECTED_DURABILITY_FAULT';

async function setup(t) {
  const f=await writeFixture(RUNTIME_NOW);
  const h=await runtime(t,{...f.env,POST_ENABLED:'true',REPLY_ENABLED:'true',X_OWN_THREAD_REPLIES_ENABLED:'true',
    X_CALLBACK_URL:f.env.PUBLIC_BASE_URL+'/x/callback',READ_POLLING_ENABLED:'false',MAX_REPLIES_DAY:'10',MAX_WRITES_DAY:'11',
    MAX_X_REQUESTS_DAY:'100',MAX_X_REQUESTS_HOUR:'20',X_ONGOING_OPERATIONS_ENABLED:'true'});
  await h.setTime(RUNTIME_NOW);
 const encrypted=await seal(h.bindings.TOKEN_ENCRYPTION_KEY,{access_token:'synthetic-fault-token',refresh_token:'synthetic-refresh',scopes:writeScopes},ownerContext(h.bindings));
  await h.db.prepare('INSERT INTO accounts(id,issuer,subject,x_user_id,encrypted_tokens,expires_at,updated_at) VALUES(?,?,?,?,?,?,?)')
    .bind('primary',h.bindings.MCP_ISSUER,h.bindings.MCP_ALLOWED_SUBJECT,'4242',encrypted,RUNTIME_NOW+86400,RUNTIME_NOW).run();
  await h.db.prepare('INSERT INTO x_credit_budgets VALUES(?,?,?,?,?,?,?)')
    .bind(h.bindings.X_CREDIT_BUDGET_ID,'4242',5000000,0,0,Number(h.bindings.X_CREDIT_EXPIRES_AT),RUNTIME_NOW).run();
  await h.db.prepare('INSERT INTO ongoing_credit_state VALUES(?,?,?,?)').bind('4242',19970000,0,'a'.repeat(64)).run();
  await h.db.prepare('INSERT INTO ongoing_cycles VALUES(?,?,?,?,?,?,?)')
    .bind('4242',RUNTIME_NOW-86400,RUNTIME_NOW+30*86400,30000,0,'a'.repeat(64),'2035-01').run();
  await h.db.prepare("INSERT INTO ongoing_legacy_carry VALUES('4242',0,0,0,0,0,0,'2034-12-31','2034-12',1,?)").bind(RUNTIME_NOW).run();
  const posts=[],accepted=[];
  let loseResponse=false,onAccepted=async()=>{};
  const transport=async(url,options)=>{
    assert.equal(url,'https://api.x.com/2/tweets');assert.equal(options.method,'POST');
    posts.push(JSON.parse(options.body));
    const postId=String(9000+posts.length);accepted.push(postId);
    await onAccepted();
    if(loseResponse)throw new Error('Offline provider accepted the POST; response was lost');
    return new Response(JSON.stringify({data:{id:postId}}),{status:201,headers:{'content-type':'application/json'}});
  };
  const make=()=>new PublisherReplyQueue(h.bindings,new Store(h.db,h.clock),h.clock,
    store=>new XConnector(h.bindings,configuration(h.bindings),store,transport,h.clock));
  const revalidate=async item=>({action:'approve',text:'A useful fault-test reply.',context_ref:item.context_ref,rechecked_at:h.clock(),
    conversation_checked:true,value_checked:true,stop_checked:true});
  const q=make();await q.init();await q.discover([record()]);
  t.after(()=>assert.equal(h.xCalls().length,0,'every provider POST must use the local injected transport'));
  return {h,q,make,revalidate,posts,accepted,loseResponse:()=>{loseResponse=true;},afterAccepted:callback=>{onAccepted=callback;}};
}

// A before fault models execution failing before a durable write. An after fault
// commits to D1, then loses the acknowledgement. No synthetic receipt is supplied.
function faultStore(store,{method,pattern,when}) {
  let hits=0;
  const maybe=async(sql,perform)=>{
    if(hits||!pattern.test(sql))return perform();
    hits++;
    if(when==='before')throw new Error(faultMessage);
    await perform();throw new Error(faultMessage);
  };
  if(method==='batch') {
    const statements=new WeakMap(),statement=store.statement.bind(store),db=store.db;
    store.statement=(sql,...args)=>{const value=statement(sql,...args);statements.set(value,sql);return value;};
    store.db=new Proxy(db,{get(target,key){
      if(key==='batch')return values=>maybe(values.map(value=>statements.get(value)??'').join('\n'),()=>db.batch(values));
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }});
  } else {
    const original=store[method].bind(store);
    store[method]=(sql,...args)=>maybe(sql,()=>original(sql,...args));
  }
  return ()=>hits;
}

function inject(f,{where,...fault}) {
  if(where==='queue')return faultStore(f.q.store,fault);
  const publisher=f.q.publisher.bind(f.q);
  let hits=()=>0,installed=false;
  f.q.publisher=tracked=>{
    const value=publisher(tracked);
    if(tracked&&!installed){installed=true;hits=faultStore(value.store,fault);}
    return value;
  };
  return ()=>hits();
}

async function rows(f,key) {
  return {
    item:await f.h.db.prepare('SELECT * FROM reply_queue_items WHERE intent_key=?').bind(key).first(),
    intent:await f.h.db.prepare('SELECT * FROM reply_queue_intents WHERE intent_key=?').bind(key).first(),
    proof:await f.h.db.prepare('SELECT * FROM reply_queue_publisher_attempts WHERE intent_key=?').bind(key).first(),
    service:await f.h.db.prepare('SELECT * FROM service_writes WHERE idempotency_key=?').bind(key).first()
  };
}
const frozen=row=>Object.fromEntries(['intent_key','account_id','target_id','author_id','draft','context_ref','dispatch_at','cost_micro_usd','expires_at']
  .map(key=>[key,row[key]]));

async function restartAndCheck(f,key,before,{posts,reconciled}) {
  await f.h.setTime(RUNTIME_NOW+3600);await f.h.restart();const q=f.make();
  await q.discover([record()]);await q.reconcile(key);
  const after=await rows(f,key);
  assert.equal(after.item.intent_key,key);assert.equal(after.item.state,reconciled);
  assert.deepEqual(frozen(after.intent),frozen(before.intent),'the frozen send intent survives restart unchanged');
  assert.deepEqual(after.proof,before.proof,'reconciliation cannot recreate or weaken dispatch proof');
  assert.equal(f.posts.length,posts);
  if(reconciled==='unknown') {
    await q.discover([record('1003','6060')]);
    await f.h.db.prepare('INSERT INTO reply_opt_outs VALUES(?,?,?,?)').bind('4242','5050','1002',f.h.clock()).run();
    let reviewed=0;
    for(let i=0;i<3;i++) {
      const result=await q.processOne(async()=>{reviewed++;return {action:'cancel',reason:'explicit_stop'};});
      assert.equal(result.next_wake_at,null,'unknown transport evidence conservatively holds the entire account');
    }
    assert.equal(reviewed,0,'an expired lease or STOP cannot reopen an immutable dispatch intent');
    assert.equal((await q.get('1002')).state,'unknown');
    assert.equal((await q.get('1003')).state,'pending');
    await assert.rejects(q.resume('1002'),/QUEUE_RESUME_DENIED/);
    await assert.rejects(q.newOwnerIntent('1002','owner:specific-but-unproven-retry'),/QUEUE_PROVEN_NO_DISPATCH_REQUIRED/);
  } else {
    let reviewed=0;await q.processOne(async()=>{reviewed++;return {action:'cancel',reason:'too_late'};});assert.equal(reviewed,0);
    const settled=await rows(f,key);
    assert.equal(settled.intent.receipt_ref,`service-write:${key}`);
    assert.equal(JSON.parse(settled.intent.receipt_json).post_id,f.accepted[0]);
    await assert.rejects(q.newOwnerIntent('1002','owner:cannot-resend-success'),/QUEUE_PROVEN_NO_DISPATCH_REQUIRED/);
  }
  assert.equal(f.posts.length,posts,'restart, local reconciliation, scans, STOP and lease expiry never resend');
  const final=await rows(f,key);
  assert.equal(final.item.intent_key,key);assert.deepEqual(frozen(final.intent),frozen(before.intent));
  assert.deepEqual(final.proof,before.proof,'subsequent cancellation and retry requests cannot weaken dispatch evidence');
  assert.equal((await f.h.db.prepare('SELECT COUNT(*) n FROM reply_queue_intents WHERE target_id=?').bind('1002').first()).n,1);
}

test('queue commit failure before persistence leaves the same unsent intent reviewable after restart',async t=>{
  const f=await setup(t),key=(await f.q.get('1002')).intent_key;
  const hits=inject(f,{where:'queue',method:'batch',pattern:/INSERT INTO reply_queue_intents/,when:'before'});
  await assert.rejects(f.q.processOne(f.revalidate),new RegExp(faultMessage));assert.equal(hits(),1);
  assert.equal(f.posts.length,0);assert.equal((await rows(f,key)).intent,null);
  await f.h.setTime(RUNTIME_NOW+121);await f.h.restart();const q=f.make();
  let reviewed=0;await q.processOne(async item=>{reviewed++;return f.revalidate(item);});
  assert.equal(reviewed,1);assert.equal(f.posts.length,1);assert.equal((await q.get('1002')).intent_key,key);
  assert.equal((await q.get('1002')).state,'sent');
});

const boundaries=[
  {name:'queue commit acknowledgement loss',where:'queue',method:'batch',pattern:/INSERT INTO reply_queue_intents/,when:'after',throws:true,phase:null,owned:null,service:null,posts:0,reconciled:'unknown'},
  {name:'publisher attempt insertion fails before persistence',where:'queue',method:'first',pattern:/INSERT INTO reply_queue_publisher_attempts/,when:'before',phase:null,owned:null,service:null,posts:0,reconciled:'unknown'},
  {name:'publisher attempt acknowledgement loss',where:'queue',method:'first',pattern:/INSERT INTO reply_queue_publisher_attempts/,when:'after',phase:'prepared',owned:0,service:null,posts:0,reconciled:'unknown'},
  {name:'service intent insertion fails before persistence',where:'publisher',method:'first',pattern:/INSERT INTO service_writes/,when:'before',phase:'prepared',owned:0,service:null,posts:0,reconciled:'unknown'},
  {name:'service intent acknowledgement loss',where:'publisher',method:'first',pattern:/INSERT INTO service_writes/,when:'after',phase:'prepared',owned:0,service:'pending',posts:0,reconciled:'unknown'},
  {name:'service ownership proof fails before persistence',where:'publisher',method:'first',pattern:/SET service_intent_owned=1/,when:'before',phase:'prepared',owned:0,service:'pending',posts:0,reconciled:'unknown'},
  {name:'service ownership proof acknowledgement loss',where:'publisher',method:'first',pattern:/SET service_intent_owned=1/,when:'after',phase:'prepared',owned:1,service:'pending',posts:0,reconciled:'unknown'},
  {name:'may_dispatch proof fails before persistence',where:'publisher',method:'first',pattern:/SET phase='may_dispatch'/,when:'before',phase:'prepared',owned:1,service:'unknown',posts:0,reconciled:'unknown'},
  {name:'may_dispatch proof acknowledgement loss',where:'publisher',method:'first',pattern:/SET phase='may_dispatch'/,when:'after',phase:'may_dispatch',owned:1,service:'unknown',posts:0,reconciled:'unknown'},
  {name:'accepted provider POST before service ledger commit',where:'publisher',method:'batch',pattern:/UPDATE service_writes SET state=/,when:'before',phase:'may_dispatch',owned:1,service:'pending',posts:1,reconciled:'unknown'},
  {name:'service ledger commit acknowledgement loss',where:'publisher',method:'batch',pattern:/UPDATE service_writes SET state=/,when:'after',phase:'may_dispatch',owned:1,service:'succeeded',posts:1,reconciled:'sent'},
  {name:'adapter receipt save fails before persistence',where:'queue',method:'run',pattern:/UPDATE reply_queue_publisher_attempts SET receipt_json=/,when:'before',phase:'may_dispatch',owned:1,service:'succeeded',posts:1,reconciled:'sent'},
  {name:'adapter receipt save acknowledgement loss',where:'queue',method:'run',pattern:/UPDATE reply_queue_publisher_attempts SET receipt_json=/,when:'after',phase:'may_dispatch',owned:1,service:'succeeded',posts:1,reconciled:'sent'},
  {name:'saved adapter receipt before queue settlement',where:'queue',method:'batch',pattern:/UPDATE reply_queue_intents SET state=\?,receipt_ref=/,when:'before',throws:true,phase:'may_dispatch',owned:1,service:'succeeded',posts:1,reconciled:'sent'},
  {name:'queue settlement acknowledgement loss',where:'queue',method:'batch',pattern:/UPDATE reply_queue_intents SET state=\?,receipt_ref=/,when:'after',throws:true,phase:'may_dispatch',owned:1,service:'succeeded',posts:1,reconciled:'sent'}
];
for(const boundary of boundaries)test(boundary.name+' never repeats an HTTP mutation',async t=>{
  const f=await setup(t),key=(await f.q.get('1002')).intent_key,hits=inject(f,boundary);
  if(boundary.throws)await assert.rejects(f.q.processOne(f.revalidate),new RegExp(faultMessage));
  else await f.q.processOne(f.revalidate);
  assert.equal(hits(),1,'the intended crash boundary must actually be exercised');
  assert.equal(f.posts.length,boundary.posts);assert.equal(f.accepted.length,boundary.posts);
  const before=await rows(f,key);
  assert.equal(before.proof?.phase??null,boundary.phase);
  assert.equal(before.proof?.service_intent_owned??null,boundary.owned);
  assert.equal(before.service?.state??null,boundary.service);
  await restartAndCheck(f,key,before,boundary);
});

test('provider acceptance with a lost response remains unknown even after restart and STOP',async t=>{
  const f=await setup(t),key=(await f.q.get('1002')).intent_key;f.loseResponse();
  const result=await f.q.processOne(f.revalidate);
  assert.equal(result.items[0].state,'unknown');assert.equal(f.posts.length,1);assert.equal(f.accepted.length,1);
  const before=await rows(f,key);
  assert.equal(before.proof.phase,'may_dispatch');assert.equal(before.proof.service_intent_owned,1);
  assert.equal(before.service.state,'unknown');
  assert.equal(before.service.post_id,null,'provider fixture knowledge must not manufacture a local success receipt');
  await restartAndCheck(f,key,before,{posts:1,reconciled:'unknown'});
});

const expiryBoundaries=[
  {name:'deadline read acknowledgement',delay:/SELECT intent\.reviewed_at,intent\.expires_at,gate\.claim_until/,phase:'prepared'},
  {name:'may_dispatch acknowledgement',delay:/SET phase='may_dispatch'/,phase:'may_dispatch'},
  {name:'expiry proof persistence failure',delay:/SET phase='may_dispatch'/,phase:'may_dispatch',proofFault:'before'},
  {name:'expiry proof acknowledgement loss',delay:/SET phase='may_dispatch'/,phase:'may_dispatch',proofFault:'after'}
];
for(const boundary of expiryBoundaries)test(`expiry during ${boundary.name} prevents the provider POST`,async t=>{
  const f=await setup(t),key=(await f.q.get('1002')).intent_key;
  // A valid 24-hour-old source is one second from expiry when review starts.
  await f.h.db.prepare('UPDATE reply_queue_items SET source_created_at=?,expires_at=? WHERE intent_key=?')
    .bind(RUNTIME_NOW-86399,RUNTIME_NOW+1,key).run();
  const publisher=f.q.publisher.bind(f.q);let delays=0,proofFaults=0;
  f.q.publisher=tracked=>{
    const value=publisher(tracked);
    if(tracked) {
      const first=value.store.first.bind(value.store);
      value.store.first=async(sql,...args)=>{
        if(boundary.proofFault&&!proofFaults&&/SET expired_before_transport=1/.test(sql)) {
          proofFaults++;
          if(boundary.proofFault==='after')await first(sql,...args);
          throw new Error(faultMessage);
        }
        const result=await first(sql,...args);
        if(!delays&&boundary.delay.test(sql)){delays++;await f.h.setTime(RUNTIME_NOW+1);}
        return result;
      };
    }
    return value;
  };
  await f.q.processOne(f.revalidate);assert.equal(delays,1);
  assert.equal(proofFaults,boundary.proofFault?1:0);
  assert.equal(f.posts.length,0);assert.equal(f.accepted.length,0);
  const before=await rows(f,key);
  assert.equal(before.proof.phase,boundary.phase);assert.equal(before.proof.service_intent_owned,1);
  assert.equal(before.proof.expired_before_transport,boundary.proofFault==='before'?0:1);
  if(boundary.proofFault==='before') {
    assert.equal(before.item.state,'unknown');assert.equal(before.service.state,'unknown');
    await restartAndCheck(f,key,before,{posts:0,reconciled:'unknown'});
  } else {
    assert.equal(before.item.state,'cancelled');assert.equal(before.item.reason,'planned_reply_expired');
    const receipt=JSON.parse(before.intent.receipt_json);
    assert.equal(receipt.dispatched,false);assert.equal(receipt.code,'planned_reply_expired');
    assert.equal(before.service.state,boundary.proofFault==='after'?'unknown':'rejected');
    await f.h.setTime(RUNTIME_NOW+3600);await f.h.restart();const q=f.make();
    await q.reconcile(key);await q.discover([record()]);
    let reviewed=0;await q.processOne(async()=>{reviewed++;return {action:'approve'};});assert.equal(reviewed,0);
    await assert.rejects(q.newOwnerIntent('1002','owner:expired-plan-cannot-be-resurrected'),/QUEUE_PLANNED_REPLY_EXPIRED/);
    const after=await rows(f,key);
    assert.equal(after.item.state,'cancelled');assert.equal(after.item.intent_key,key);
    assert.deepEqual(frozen(after.intent),frozen(before.intent));assert.deepEqual(after.proof,before.proof);
    assert.equal(after.intent.draft,'A useful fault-test reply.','expiry preserves committed audit evidence');
    assert.equal((await q.status()).next_wake_at,null);
  }
  assert.equal(f.posts.length,0,'expiry never invokes even the intercepted transport');
});

for(const responseLost of [false,true])test(`expiry after provider acceptance preserves ${responseLost?'unknown evidence':'the sent receipt'}`,async t=>{
  const f=await setup(t),key=(await f.q.get('1002')).intent_key;
  await f.h.db.prepare('UPDATE reply_queue_items SET source_created_at=?,expires_at=? WHERE intent_key=?')
    .bind(RUNTIME_NOW-86399,RUNTIME_NOW+1,key).run();
  f.afterAccepted(()=>f.h.setTime(RUNTIME_NOW+1));if(responseLost)f.loseResponse();
  await f.q.processOne(f.revalidate);
  const before=await rows(f,key),state=responseLost?'unknown':'sent';
  assert.equal(f.posts.length,1);assert.equal(f.accepted.length,1);assert.equal(before.item.state,state);
  assert.equal(before.proof.phase,'may_dispatch');assert.equal(before.proof.service_intent_owned,1);
  assert.equal(before.proof.expired_before_transport,0,'a provider invocation can never become a no-transport expiry proof');
  assert.equal(before.intent.draft,'A useful fault-test reply.');assert.equal(before.intent.context_ref,'synthetic:browser:1002');
  await restartAndCheck(f,key,before,{posts:1,reconciled:state});
});
