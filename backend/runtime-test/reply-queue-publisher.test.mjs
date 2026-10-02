import test from 'node:test';
import assert from 'node:assert/strict';
import {runtime} from './helpers.mjs';
import {writeFixture,writeScopes} from '../test/write-fixtures.mjs';
import {seal,configuration} from '../src/security.mjs';
import {ownerContext} from '../src/reads.mjs';
import {Store} from '../src/storage.mjs';
import {XConnector} from '../src/x.mjs';
import {ServiceWrites} from '../src/service-writes.mjs';
import {PublisherReplyQueue} from '../src/reply-queue-publisher.mjs';
import {replyQueuePreflight} from '../src/reply-queue-preflight.mjs';
import {dayStart,periods,monthEnd} from '../src/ongoing.mjs';
import {RUNTIME_NOW as BASE_RUNTIME_NOW} from './clock-fixture.mjs';
const RUNTIME_NOW=BASE_RUNTIME_NOW+3600; // Fixture activity lies within one UTC day.
const record=(target='1002',author='5050')=>({target_id:target,author_id:author,root_id:'1000',context_ref:'synthetic:browser:'+target});
async function setup(t,overrides={}) {
 const now=RUNTIME_NOW,f=await writeFixture(now);
 const h=await runtime(t,{...f.env,POST_ENABLED:'true',REPLY_ENABLED:'true',X_OWN_THREAD_REPLIES_ENABLED:'true',
  X_CALLBACK_URL:f.env.PUBLIC_BASE_URL+'/x/callback',READ_POLLING_ENABLED:'false',MAX_REPLIES_DAY:'10',MAX_WRITES_DAY:'11',
  MAX_X_REQUESTS_DAY:'100',MAX_X_REQUESTS_HOUR:'20',X_ONGOING_OPERATIONS_ENABLED:'true',...overrides});
 await h.setTime(RUNTIME_NOW);
 const encrypted=await seal(h.bindings.TOKEN_ENCRYPTION_KEY,{access_token:'synthetic-queue-token',refresh_token:'synthetic-refresh',scopes:writeScopes},ownerContext(h.bindings));
 await h.db.prepare('INSERT INTO accounts(id,issuer,subject,x_user_id,encrypted_tokens,expires_at,updated_at) VALUES(?,?,?,?,?,?,?)')
  .bind('primary',h.bindings.MCP_ISSUER,h.bindings.MCP_ALLOWED_SUBJECT,'4242',encrypted,now+86400,now).run();
 await h.db.prepare('INSERT INTO x_credit_budgets VALUES(?,?,?,?,?,?,?)').bind(h.bindings.X_CREDIT_BUDGET_ID,'4242',5000000,0,0,Number(h.bindings.X_CREDIT_EXPIRES_AT),now).run();
 await h.db.prepare('INSERT INTO ongoing_credit_state VALUES(?,?,?,?)').bind('4242',19970000,0,'a'.repeat(64)).run();
 await h.db.prepare('INSERT INTO ongoing_cycles VALUES(?,?,?,?,?,?,?)').bind('4242',now-86400,now+30*86400,30000,0,'a'.repeat(64),'2035-01').run();
 await h.db.prepare("INSERT INTO ongoing_legacy_carry VALUES('4242',0,0,0,0,0,0,'2034-12-31','2034-12',1,?)").bind(now).run();
 const calls=[];let response=async()=>new Response(JSON.stringify({data:{id:String(9000+calls.length)}}),{status:201,headers:{'content-type':'application/json'}});
 const transport=async(url,options)=>{
  assert.equal(url,'https://api.x.com/2/tweets');assert.equal(options.method,'POST');
  calls.push(JSON.parse(options.body));return response();
 };
 const connector=store=>new XConnector(h.bindings,configuration(h.bindings),store,transport,h.clock);
 const make=()=>new PublisherReplyQueue(h.bindings,new Store(h.db,h.clock),h.clock,connector);
 const revalidate=async item=>({action:'approve',text:'A useful reply.',context_ref:item.context_ref,rechecked_at:h.clock(),
  conversation_checked:true,value_checked:true,stop_checked:true});
 const q=make();await q.init();
 const charge=async amount=>h.db.prepare("INSERT INTO ongoing_spend(account_id,day,month,amount,unresolved_micro_usd,kind,created_at) VALUES('4242',?,?,?,0,'api',?)")
  .bind(periods(h.clock()).day,periods(h.clock()).month,amount,h.clock()).run();
 return {h,q,make,revalidate,calls,charge,connector,response:fn=>{response=fn;}};
}
test('integrated two-item queue uses normal single POST, shared ledger, exact boundary, concurrent runners and restart',async t=>{
 const f=await setup(t);await f.q.discover([record(),record('1003','6060')]);
 const all=await Promise.all(Array.from({length:6},()=>f.make().processOne(f.revalidate)));
 assert.equal(f.calls.length,1);assert(all.some(s=>s.next_wake_at===new Date((RUNTIME_NOW+900)*1000).toISOString()));
 assert.equal((await f.h.db.prepare('SELECT SUM(amount) n FROM ongoing_spend').first()).n,15000);
 assert.equal((await f.h.db.prepare('SELECT cost_micro_usd n FROM reply_queue_intents').first()).n,35000);
 await f.h.restart();let q=f.make();await q.discover([record(),record('1003','6060')]);
 await f.h.setTime(RUNTIME_NOW+899);await q.processOne(f.revalidate);assert.equal(f.calls.length,1);
 await f.h.setTime(RUNTIME_NOW+900);await q.processOne(f.revalidate);assert.equal(f.calls.length,2);
 assert.equal((await f.h.db.prepare('SELECT COUNT(*) n FROM service_writes').first()).n,2);
 assert.equal(f.h.xCalls().length,0); // Node adapter transport is separately intercepted above.
});
test('pre-intent shared dollar and hour caps defer without consuming keys or making HTTP calls',async t=>{
 const f=await setup(t);await f.q.discover([record()]);await f.charge(990000);
 let state=await f.q.processOne(f.revalidate);assert.equal(f.calls.length,0);
 assert.equal(state.next_wake_at,'2035-01-02T00:00:00.000Z'); // UTC, not UTC
 assert.equal(state.items[0].eligibility_reason,'daily_spend_cap');
 assert.equal((await f.h.db.prepare('SELECT COUNT(*) n FROM service_writes').first()).n,0);
 await f.h.db.prepare('UPDATE ongoing_spend SET amount=0').run();
 const hour=Math.floor(f.h.clock()/3600);await f.h.db.prepare('INSERT INTO budgets VALUES(?,?,?)').bind(`requests:hour:${hour}`,20,(hour+1)*3600).run();
 state=await f.q.processOne(f.revalidate);assert.equal(state.next_wake_at,new Date((hour+1)*3600000).toISOString());assert.equal(f.calls.length,0);
});
test('model URL revision checks full envelope and blocks same key before committing an intent',async t=>{
 const f=await setup(t);await f.charge(900000);await f.q.discover([record()]);const key=(await f.q.get('1002')).intent_key;
 const result=await f.q.processOne(async item=>({...await f.revalidate(item),text:'Useful reference https://example.com/guide'}));
 assert.equal(result.items[0].state,'blocked');assert.equal(result.items[0].intent_key,key);assert.equal(f.calls.length,0);
 assert.equal((await f.h.db.prepare('SELECT COUNT(*) n FROM reply_queue_intents').first()).n,0);
 assert.equal((await f.h.db.prepare('SELECT COUNT(*) n FROM service_writes').first()).n,0);
});
test('publisher budget race after commit is proven no-dispatch, terminal and requires a specific owner request',async t=>{
 const f=await setup(t);await f.q.discover([record()]);
 await f.h.db.prepare(`CREATE TRIGGER test_budget_race AFTER INSERT ON reply_queue_publisher_attempts BEGIN
   UPDATE ongoing_cycles SET confirmed_used_micro_usd=4999999; END`).run();
 const result=await f.q.processOne(f.revalidate),key=result.items[0].intent_key;
 assert.equal(result.items[0].state,'blocked');assert.equal(result.items[0].reason,'specific_owner_request_required');assert.equal(f.calls.length,0);
 await f.h.restart();const q=f.make();await q.reconcile(key);await q.processOne(f.revalidate);assert.equal(f.calls.length,0);
 const intent=await f.h.db.prepare('SELECT receipt_json FROM reply_queue_intents WHERE intent_key=?').bind(key).first();
 assert.equal(JSON.parse(intent.receipt_json).dispatched,false);
 const next=await q.newOwnerIntent('1002','owner:separate-specific-request');assert.notEqual(next.intent_key,key);
});
test('unknown receipt across restart cannot be retried; HTTP rejection proves dispatched',async t=>{
 for(const status of [503,400])await t.test(String(status),async t=>{
  const f=await setup(t);f.response(async()=>new Response('{}',{status,headers:{'content-type':'application/json'}}));
  await f.q.discover([record(),record('1003','6060')]);const result=await f.q.processOne(f.revalidate),key=result.items[0].intent_key;
  assert.equal(result.items[0].state,status===503?'unknown':'cancelled');assert.equal(f.calls.length,1);
  await f.h.restart();const q=f.make();await q.reconcile(key);await q.discover([record()]);
  await assert.rejects(q.newOwnerIntent('1002','owner:retry'),/NO_DISPATCH/);assert.equal(f.calls.length,1);
 });
});
test('author fairness uses shared interactions; STOP cancels and no-value is model-owned',async t=>{
 const f=await setup(t);
 for(let i=0;i<2;i++)await f.h.db.prepare('INSERT INTO reply_interactions VALUES(?,?,?,?,?,?)')
  .bind('4242',String(2000+i),crypto.randomUUID(),'5050',null,f.h.clock()-3600).run();
 await f.q.discover([record(),record('1003','6060')]);await f.q.processOne(f.revalidate);
 assert.equal(f.calls[0].reply.in_reply_to_tweet_id,'1003');
 await f.h.db.prepare('INSERT INTO reply_opt_outs VALUES(?,?,?,?)').bind('4242','5050','2009',f.h.clock()).run();
 await f.q.processOne(f.revalidate);assert.equal((await f.q.get('1002')).state,'cancelled');
 await f.h.setTime(f.h.clock()+900);await f.q.discover([record('1004','7070')]);
 await f.q.processOne(async()=>({action:'cancel',reason:'no_value'}));assert.equal((await f.q.get('1004')).state,'cancelled');assert.equal(f.calls.length,1);
});
test('shared 10 replies, 11 writes and monthly cap are visible before HTTP; provider exhaustion has no automatic wake',async t=>{
 for(const mode of ['replies','writes','month','provider'])await t.test(mode,async t=>{
  const f=await setup(t);await f.q.discover([record()]);const day=periods(f.h.clock()).day;
  if(mode==='replies')for(let i=0;i<10;i++)await f.h.db.prepare("INSERT INTO ongoing_operations VALUES(?,? ,?,'reply',?)").bind(crypto.randomUUID(),'4242',day,f.h.clock()-3600).run();
  if(mode==='writes')await f.h.db.prepare('INSERT INTO budgets VALUES(?,?,?)').bind(`writes:day:${day}`,11,f.h.clock()+86400).run();
  if(mode==='month')await f.h.db.prepare("INSERT INTO ongoing_spend(account_id,day,month,amount,kind,created_at) VALUES('4242','2035-01-01','2035-01',4990000,'legacy',?)").bind(f.h.clock()-86400).run();
  if(mode==='provider')await f.h.db.prepare('UPDATE ongoing_cycles SET confirmed_used_micro_usd=4990000').run();
  const s=await f.q.processOne(f.revalidate);assert.equal(f.calls.length,0);
  assert.equal(s.next_wake_at,['provider','month'].includes(mode)?null:new Date(dayStart(dayStart(f.h.clock())+36*3600)*1000).toISOString());
 });
});
test('late direct-publisher confirmation establishes queue spacing and final publisher fence',async t=>{
 const f=await setup(t);f.response(async()=>{await f.h.setTime(RUNTIME_NOW+8);return new Response('{"data":{"id":"9001"}}',{status:201,headers:{'content-type':'application/json'}});});
 const store=new Store(f.h.db,f.h.clock),publisher=new ServiceWrites(f.h.bindings,store,f.h.clock,()=>f.connector(store));
 await publisher.execute('x_reply',{idempotency_key:crypto.randomUUID(),text:'Direct reply.',in_reply_to_post_id:'2000',in_reply_to_author_id:'8080'});
 await f.q.discover([record()]);assert.equal((await f.q.status()).next_wake_at,new Date((RUNTIME_NOW+908)*1000).toISOString());
 await f.h.setTime(RUNTIME_NOW+900);await f.q.processOne(f.revalidate);assert.equal(f.calls.length,1);
 const p=await replyQueuePreflight(f.q.publisher(),await f.q.get('1002'));assert.equal(p.reason,'reply_spacing');
 const otherStore=new Store(f.h.db,f.h.clock),other=new ServiceWrites(f.h.bindings,otherStore,f.h.clock,()=>f.connector(otherStore));
 const denied=await other.execute('x_reply',{idempotency_key:crypto.randomUUID(),text:'Another direct reply.',in_reply_to_post_id:'2001',in_reply_to_author_id:'9090'});
 assert.equal(denied.code,'ongoing_dispatch_cooldown');assert.equal(f.calls.length,1);
});
test('UTC midnight preserves confirmation spacing and cancels stale wake handoffs',async t=>{
 const {replyQueueWakeHandoff}=await import('../src/reply-queue-wake.mjs');
 const f=await setup(t),midnight=Date.parse('2035-01-02T00:00:00Z')/1000;
 await f.h.setTime(midnight-300);await f.q.discover([record(),record('1003','6060')]);
 const s=await f.q.processOne(f.revalidate);assert.equal(s.next_wake_at,new Date((midnight+600)*1000).toISOString());
 const wake=replyQueueWakeHandoff(s);assert.equal(wake.action,'replace_once');assert.equal(wake.scheduled,false);
 await f.h.setTime(midnight);await f.q.processOne(f.revalidate);assert.equal(f.calls.length,1);
 await f.h.setTime(midnight+600);const done=await f.q.processOne(f.revalidate);assert.equal(f.calls.length,2);
 assert.equal(replyQueueWakeHandoff(done).action,'cancel');
 assert.throws(()=>replyQueueWakeHandoff({...done,wake_key:'foreign'}),/INVALID/);
});
test('90-second UTC boundary pause and local scope denial create no terminal intent',async t=>{
 const f=await setup(t);await f.h.setTime(Date.parse('2035-01-01T23:59:00Z')/1000);
 await f.q.discover([record()]);const s=await f.q.processOne(f.revalidate);
 assert.equal(s.next_wake_at,'2035-01-02T00:00:00.000Z');assert.equal(f.calls.length,0);
 await f.h.setTime(Date.parse('2035-01-02T00:00:00Z')/1000);
 const encrypted=await seal(f.h.bindings.TOKEN_ENCRYPTION_KEY,{access_token:'synthetic',scopes:['tweet.read']},ownerContext(f.h.bindings));
 await f.h.db.prepare('UPDATE accounts SET encrypted_tokens=?').bind(encrypted).run();
 const blocked=await f.q.processOne(f.revalidate);assert.equal(blocked.next_wake_at,null);
 assert.equal(blocked.items[0].eligibility_reason,'x_write_scope_required');
 assert.equal((await f.h.db.prepare('SELECT COUNT(*) n FROM service_writes').first()).n,0);
});
test('historical rejected service key cannot manufacture proven-no-dispatch from a new prepared proof',async t=>{
 const {SERVICE}=await import('../src/service.mjs'),{digest}=await import('../src/security.mjs');
 const f=await setup(t);await f.q.discover([record()]);const c=await f.q.claim();
 await f.q.decide(c,await f.revalidate(c));const args=await f.q.commit(c);
 const payload={text:args.text,reply:{in_reply_to_tweet_id:args.in_reply_to_post_id}};
 await f.h.db.prepare(`INSERT INTO service_writes(idempotency_key,service_subject,owner_issuer,owner_subject,account_id,
   operation,payload_hash,state,code,created_at,updated_at) VALUES(?,?,?,?,?,'x_reply',?,'rejected','x_request_rejected',?,?)`)
   .bind(args.idempotency_key,SERVICE.subject,f.h.bindings.MCP_ISSUER,f.h.bindings.MCP_ALLOWED_SUBJECT,'4242',
    await digest(JSON.stringify({operation:'x_reply',payload})),f.h.clock(),f.h.clock()).run();
 const receipt=await f.q.publish(args);assert.equal(receipt.state,'unknown');assert.equal(f.calls.length,0);
 await f.q.settle(args.idempotency_key,receipt);
 await assert.rejects(f.q.newOwnerIntent('1002','owner:cannot-retry'),/NO_DISPATCH/);
});

for(const scenario of [
 {name:'review 59 seconds remains fresh',approvedAt:0,at:59,posts:1,state:'sent'},
 {name:'review 60 seconds blocks final POST',approvedAt:0,at:60,posts:0,state:'blocked',code:'queue_review_expired'},
 {name:'exact review lease boundary blocks final POST',approvedAt:100,at:120,posts:0,state:'blocked',code:'queue_claim_lost'}
])test(scenario.name,async t=>{
 const f=await setup(t);await f.q.discover([record()]);const claim=await f.q.claim();
 await f.h.setTime(RUNTIME_NOW+scenario.approvedAt);const approved=await f.q.decide(claim,await f.revalidate(claim));
 const args=await f.q.commit({...claim,expected_revision:approved.revision});
 const publisher=f.q.publisher.bind(f.q);let delayed=false;
 f.q.publisher=tracked=>{
  const value=publisher(tracked);
  if(tracked) {
   const first=value.store.first.bind(value.store);
   value.store.first=async(sql,...params)=>{
    const result=await first(sql,...params);
    if(sql.includes("SET phase='may_dispatch'")&&!delayed){delayed=true;await f.h.setTime(RUNTIME_NOW+scenario.at);}
    return result;
   };
  }
  return value;
 };
 const receipt=await f.q.publish(args);await f.q.settle(args.idempotency_key,receipt);
 assert(delayed);assert.equal(f.calls.length,scenario.posts);assert.equal((await f.q.get('1002')).state,scenario.state);
 const proof=await f.h.db.prepare('SELECT * FROM reply_queue_publisher_attempts WHERE intent_key=?').bind(args.idempotency_key).first();
 assert.equal(proof.no_dispatch_code,scenario.code??null);
 const frozen=await f.h.db.prepare('SELECT * FROM reply_queue_intents WHERE intent_key=?').bind(args.idempotency_key).first();
 assert.equal(frozen.reviewed_at,RUNTIME_NOW+scenario.approvedAt);assert.equal(frozen.review_claim_token,claim.claim_token);
 await f.h.restart();await f.make().reconcile(args.idempotency_key);await f.make().processOne(f.revalidate);
 assert.equal(f.calls.length,scenario.posts);assert.equal((await f.make().get('1002')).intent_key,args.idempotency_key);
});
for(const scenario of ['stop','grant','frozen_payload'])test(`final SQL fence blocks late ${scenario} after reservations`,async t=>{
 const f=await setup(t);await f.q.discover([record()]);const publisher=f.q.publisher.bind(f.q);let changed=false;
 f.q.publisher=tracked=>{
  const value=publisher(tracked);
  if(tracked) {
   const first=value.store.first.bind(value.store);
   value.store.first=async(sql,...params)=>{
    if(sql.includes("SET phase='may_dispatch'")&&!changed) {
     changed=true;
     if(scenario==='stop')await f.h.db.prepare('INSERT INTO reply_opt_outs VALUES(?,?,?,?)').bind('4242','5050','1002',f.h.clock()).run();
     if(scenario==='grant')await f.h.db.prepare("UPDATE accounts SET version=version+1 WHERE id='primary'").run();
     if(scenario==='frozen_payload')await f.h.db.prepare("UPDATE reply_queue_items SET draft='unapproved changed text' WHERE target_id='1002'").run();
    }
    return first(sql,...params);
   };
  }
  return value;
 };
 const result=await f.q.processOne(f.revalidate),item=await f.q.get('1002');
 assert(changed);assert.equal(f.calls.length,0);assert.equal(item.state,'blocked');
 assert.equal(item.reason,'specific_owner_request_required');
 const proof=await f.h.db.prepare('SELECT * FROM reply_queue_publisher_attempts WHERE intent_key=?').bind(item.intent_key).first();
 assert.equal(proof.phase,'prepared');assert.equal(proof.no_dispatch_code,'queue_dispatch_guard_failed');
 const frozen=await f.h.db.prepare('SELECT * FROM reply_queue_intents WHERE intent_key=?').bind(item.intent_key).first();
 assert.equal(frozen.draft,'A useful reply.');assert.equal(JSON.parse(frozen.receipt_json).dispatched,false);
 assert.equal(result.items[0].intent_key,item.intent_key);
 await f.h.restart();await f.make().reconcile(item.intent_key);assert.equal(f.calls.length,0);
});

test('grant expiry during final proof acknowledgement prevents the provider POST',async t=>{
 const f=await setup(t);await f.q.discover([record()]);const publisher=f.q.publisher.bind(f.q);let delayed=false;
 f.q.publisher=tracked=>{
  const value=publisher(tracked);
  if(tracked) {
   const first=value.store.first.bind(value.store);
   value.store.first=async(sql,...params)=>{
    if(sql.includes("SET phase='may_dispatch'")&&!delayed) {
     delayed=true;
     await f.h.db.prepare("UPDATE accounts SET expires_at=? WHERE id='primary'").bind(RUNTIME_NOW+1).run();
     const proof=await first(sql,...params);await f.h.setTime(RUNTIME_NOW+1);return proof;
    }
    return first(sql,...params);
   };
  }
  return value;
 };
 await f.q.processOne(f.revalidate);assert(delayed);assert.equal(f.calls.length,0);
 const item=await f.q.get('1002');assert.equal(item.state,'blocked');assert.equal(item.reason,'specific_owner_request_required');
 const proof=await f.h.db.prepare('SELECT * FROM reply_queue_publisher_attempts WHERE intent_key=?').bind(item.intent_key).first();
 assert.equal(proof.phase,'may_dispatch');assert.equal(proof.no_dispatch_code,'queue_dispatch_guard_failed');
});
