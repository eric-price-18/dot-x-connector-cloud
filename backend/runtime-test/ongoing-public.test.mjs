import { RUNTIME_NOW } from './clock-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime,json } from './helpers.mjs';
import { writeFixture,key,writeScopes } from '../test/write-fixtures.mjs';
import { replyData,replyArgs,lookupResponse } from '../test/reply-fixtures.mjs';
import { seal } from '../src/security.mjs';
import { ownerContext } from '../src/reads.mjs';

async function setup(t,overrides={}) {
 const now=RUNTIME_NOW,f=await writeFixture(now);
 const h=await runtime(t,{...f.env,POST_ENABLED:'false',REPLY_ENABLED:'true',X_OWN_THREAD_REPLIES_ENABLED:'true',
  X_CALLBACK_URL:f.env.PUBLIC_BASE_URL+'/x/callback',READ_POLLING_ENABLED:'false',MAX_REPLIES_DAY:'5',MAX_WRITES_DAY:'6',X_ONGOING_OPERATIONS_ENABLED:'true',...overrides});
 const encrypted=await seal(h.bindings.TOKEN_ENCRYPTION_KEY,{access_token:'runtime-reply-token',refresh_token:'runtime-refresh-token',scopes:writeScopes},ownerContext(h.bindings));
 await h.db.prepare('INSERT INTO accounts(id,issuer,subject,x_user_id,encrypted_tokens,expires_at,updated_at) VALUES(?,?,?,?,?,?,?)')
  .bind('primary',h.bindings.MCP_ISSUER,h.bindings.MCP_ALLOWED_SUBJECT,h.bindings.X_EXPECTED_USER_ID,encrypted,now+7200,now).run();
 await h.db.prepare('INSERT INTO x_credit_budgets VALUES(?,?,?,?,?,?,?)').bind(h.bindings.X_CREDIT_BUDGET_ID,'4242',5000000,0,0,Number(h.bindings.X_CREDIT_EXPIRES_AT),now).run();
 await h.db.prepare('INSERT INTO ongoing_credit_state VALUES(?,?,?,?)').bind('4242',4000000,0,'a'.repeat(64)).run();
 await h.db.prepare('INSERT INTO ongoing_cycles VALUES(?,?,?,?,?,?,?)').bind('4242',now-86400,now+30*86400,0,0,'a'.repeat(64),'2035-01').run();
 await h.db.prepare("INSERT INTO ongoing_legacy_carry VALUES('4242',0,0,0,0,0,0,'2034-12-31','2034-12',1,?)").bind(now).run();
 h.state.xScopes=writeScopes.join(' ');
 const data=replyData(now);
 h.state.onX=call=>{
  if(call.method==='GET'&&call.url.pathname==='/2/tweets/'+data.target.id)return json(lookupResponse(data.target));
  if(call.method==='GET'&&call.url.pathname==='/2/tweets/'+data.root.id)return json(lookupResponse(data.root));
  if(call.url.pathname==='/2/users/4242/mentions')return json(typeof data.mentions==='function'?data.mentions(call.url):data.mentions);
 };
 async function call(args=replyArgs(),name='x_reply') {
  const request=await f.request(name,args,{iat:h.state.now,exp:h.state.now+45});const response=await h.mf.dispatchFetch(request.url,{method:'POST',headers:request.headers,body:await request.arrayBuffer()});
  const body=await response.json();return {body,receipt:body.result?.structuredContent};
 }
 return {...h,data,call,get mf(){return h.mf;},get db(){return h.db;},sends:()=>h.xCalls().filter(v=>v.method==='POST'&&v.url.pathname==='/2/tweets')};
}

test('workerd ongoing: full envelope reserved before reads, cooldown and restart claims',async t=>{
 const h=await setup(t);const r=await h.call();assert.equal(r.receipt.state,'succeeded',JSON.stringify(r.body));
 assert.equal((await h.db.prepare('SELECT SUM(amount) AS n FROM ongoing_spend').first()).n,15000);
 await h.restart();assert.deepEqual((await h.call()).receipt,r.receipt);
 h.data.target={...h.data.target,id:'1003',edit_history_post_ids:['1003']};const before=h.xCalls().length;
 assert.equal((await h.call(replyArgs(2,replyArgs().text,'1003'))).receipt.code,'ongoing_operation_limit_or_cooldown');
 assert.equal(h.xCalls().length,before);
});
test('workerd ongoing: insufficient full envelope causes zero paid preflight calls',async t=>{
 const h=await setup(t);await h.db.prepare('UPDATE x_credit_budgets SET used_micro_usd=600000').run();
 assert.equal((await h.call()).receipt.code,'ongoing_spend_cap_or_reconciliation');assert.equal(h.xCalls().length,0);
});

test('workerd ongoing: owner diagnostics count legacy reply liabilities once with local D1 only',async t=>{
 const {Store}=await import('../src/storage.mjs');
 const {dayStart,periods}=await import('../src/ongoing.mjs');
 const {ownerDiagnostics}=await import('../src/ongoing-diagnostics.mjs');
 const h=await setup(t);await h.setTime(h.clock()+3600);
 const store=new Store(h.db,h.clock),now=h.clock(),start=dayStart(now),account=h.bindings.X_EXPECTED_USER_ID;
 async function diagnosticCount(expected) {
  const result=await ownerDiagnostics(h.bindings,store,h.clock);
  assert.equal(result.reconciled,true);assert.equal(result.claimed_reply_attempts_today,expected);
  assert.equal(h.state.calls.length,0);
 }
 async function receipt(n,state,{accountId=account,operation='x_reply',createdAt=now}={}) {
  await h.db.prepare(`INSERT INTO service_writes
   (idempotency_key,service_subject,owner_issuer,owner_subject,account_id,operation,payload_hash,state,code,post_id,created_at,updated_at)
   VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).bind(key(n),'synthetic-service',h.bindings.MCP_ISSUER,h.bindings.MCP_ALLOWED_SUBJECT,
    accountId,operation,'synthetic-payload',state,'synthetic-code',state==='succeeded'?String(9000+n):null,createdAt,createdAt).run();
 }
 async function operation(n,{accountId=account,kind='reply',createdAt=now}={}) {
  await h.db.prepare('INSERT INTO ongoing_operations(intent,account_id,day,kind,created_at) VALUES(?,?,?,?,?)')
   .bind(key(n),accountId,periods(createdAt).day,kind,createdAt).run();
 }
 await diagnosticCount(0);
 await operation(20);await diagnosticCount(1);
 let expected=1;
 for(const [index,state] of ['pending','succeeded','unknown'].entries()) {
  await receipt(index+1,state,{createdAt:index===0?start:now});await diagnosticCount(++expected);
 }
 // The pending receipt and its ongoing claim represent the same attempt.
 await operation(1,{createdAt:start});await diagnosticCount(4);
 for(const [n,state,overrides] of [[4,'rejected',{}],[5,'pending',{accountId:'8484'}],
  [6,'succeeded',{createdAt:start-1}],[7,'unknown',{operation:'x_create_original_post'}],[8,'pending',{operation:'x_repost'}]]) {
  await receipt(n,state,overrides);await diagnosticCount(4);
 }
 for(const [n,overrides] of [[21,{accountId:'8484'}],[22,{createdAt:start-1}],[23,{kind:'original'}]]) {
  await operation(n,overrides);await diagnosticCount(4);
 }
 assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM ongoing_spend').first()).n,0);
 assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM budgets').first()).n,0);
 assert.deepEqual(h.state.calls,[]);
});

test('atomic request quotas and dollars: concurrent losers leave no partial reservations',async t=>{
 const {Store}=await import('../src/storage.mjs');const {periods}=await import('../src/ongoing.mjs');
 const h=await setup(t,{MAX_X_REQUESTS_DAY:'3',MAX_X_REQUESTS_HOUR:'3'});
 const attempts=await Promise.allSettled(Array.from({length:10},()=>new Store(h.db,h.clock).reserveX(h.bindings,1,false,15000)));
 assert.equal(attempts.filter(r=>r.status==='fulfilled').length,3);
 assert.equal((await h.db.prepare('SELECT SUM(amount) AS n FROM ongoing_spend').first()).n,45000);
 const rows=(await h.db.prepare('SELECT bucket,used FROM budgets').all()).results;
 assert.equal(rows.length,3);assert(rows.every(r=>r.used===3));assert.equal(h.xCalls().length,0);
 await h.restart();assert.equal((await h.db.prepare('SELECT SUM(amount) AS n FROM ongoing_spend').first()).n,45000);
});
test('money denial rolls back request counters; local cooldown denial preserves existing reservations',async t=>{
 const {Store}=await import('../src/storage.mjs');const {periods}=await import('../src/ongoing.mjs');
 const h=await setup(t);const {day,month}=periods(h.clock());
 await h.db.prepare("INSERT INTO ongoing_spend(account_id,day,month,amount,kind,created_at) VALUES('4242',?,?,999999,'api',?)").bind(day,month,h.clock()).run();
 const s=new Store(h.db,h.clock);await assert.rejects(s.reserveX(h.bindings,1,false,15000));
 assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM budgets').first()).n,0);
 assert.equal((await h.db.prepare('SELECT SUM(amount) AS n FROM ongoing_spend').first()).n,999999);
 await h.db.prepare("INSERT INTO cooldowns VALUES('x',?)").bind(h.clock()+900).run();
 await assert.rejects(s.reserveX(h.bindings,0,false,1),e=>e.code==='X_RATE_LIMIT_COOLDOWN');
 assert.equal((await h.db.prepare('SELECT SUM(amount) AS n FROM ongoing_spend').first()).n,999999);
});
test('only never-dispatched current attempts release; marked unknown and historical reservations remain',async t=>{
 const {Store}=await import('../src/storage.mjs');const h=await setup(t),s=new Store(h.db,h.clock);
 await s.reserveX(h.bindings,0,false,10000);const unattempted=s.creditAttempt;await s.releaseUnattemptedCredit();await s.releaseUnattemptedCredit();
 assert.equal((await h.db.prepare('SELECT SUM(amount) AS n FROM ongoing_spend').first()).n,0);
 await s.reserveX(h.bindings,0,false,10000);s.markCreditDispatched();await s.releaseUnattemptedCredit();
 assert.equal((await h.db.prepare('SELECT SUM(amount) AS n FROM ongoing_spend').first()).n,10000);
 await new Store(h.db,h.clock).releaseUnattemptedCredit();
 assert.equal((await h.db.prepare('SELECT SUM(amount) AS n FROM ongoing_spend').first()).n,10000);
});
test('failed and unknown plain reply dispatches retain new full attempted rate without resending',async t=>{
 for(const status of [400,503,201])await t.test(String(status),async t=>{
  const h=await setup(t),before=h.state.onX;h.state.onX=call=>call.method==='POST'&&call.url.pathname==='/2/tweets'?json({},status):before(call);
  const r=await h.call();assert.notEqual(r.receipt.state,'succeeded');assert.equal(h.sends().length,1);
  assert.equal((await h.db.prepare('SELECT SUM(amount) AS n FROM ongoing_spend').first()).n,15000);
  await h.restart();await h.call();assert.equal(h.sends().length,1);
 });
});

test('ambiguous committed DB response retains dollars without dispatch or historical refund',async t=>{
 const {Store}=await import('../src/storage.mjs');const h=await setup(t);
 const db={prepare:sql=>h.db.prepare(sql),async batch(statements){await h.db.batch(statements);throw new Error('synthetic lost response')}};
 const s=new Store(db,h.clock);await assert.rejects(s.reserveX(h.bindings,1,false,15000));await s.releaseUnattemptedCredit();
 assert.equal((await h.db.prepare('SELECT SUM(amount) AS n FROM ongoing_spend').first()).n,15000);assert.equal(h.xCalls().length,0);
});
test('shared prepaid stages cannot consume the same allowance concurrently',async t=>{
 const {Store}=await import('../src/storage.mjs');const h=await setup(t);
 const prepaid={remaining:10000,consumed:0,resolved:0};
 const outcomes=await Promise.allSettled(Array.from({length:4},()=>{const s=new Store(h.db,h.clock);s.prepaidCredit=prepaid;return s.reserveX(h.bindings,0,false,10000)}));
 assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);assert.equal(prepaid.remaining,0);assert.equal(prepaid.consumed,10000);
 const rows=(await h.db.prepare('SELECT used FROM budgets').all()).results;assert.equal(rows.length,2);assert(rows.every(r=>r.used===1));
});
test('local dispatch-claim rejection releases only unattempted write without paid eligibility checks',async t=>{
 const h=await setup(t);
 await h.db.prepare("CREATE TRIGGER deny_local_claim BEFORE INSERT ON reply_interactions BEGIN SELECT RAISE(ABORT,'synthetic claim rejection'); END").run();
 assert.equal((await h.call()).receipt.state,'rejected');assert.equal(h.sends().length,0);
 assert.equal((await h.db.prepare('SELECT SUM(amount) AS n FROM ongoing_spend').first()).n,0);
 assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM reply_interactions').first()).n,0);
});

test('grant rotation during atomic reservation prevents original dispatch and preserves historical liability',async t=>{
 const h=await setup(t,{POST_ENABLED:'true',X_ORIGINAL_POSTS_ENABLED:'true'});
 await h.db.prepare("INSERT INTO ongoing_spend(account_id,day,month,amount,unresolved_micro_usd,kind,created_at) VALUES('4242','2035-01-01','2035-01',40000,40000,'api',?)").bind(h.clock()).run();
 await h.db.prepare("CREATE TRIGGER rotate_during_reservation AFTER INSERT ON budgets BEGIN UPDATE accounts SET version=version+1 WHERE id='primary'; END").run();
 const r=await h.call({text:'A plain sentence.',idempotency_key:key(40)},'x_create_original_post');
 assert.equal(r.receipt.code,'x_grant_superseded');assert.equal(h.sends().length,0);assert.equal(h.xCalls().length,0);
 assert.equal((await h.db.prepare('SELECT SUM(amount) AS n FROM ongoing_spend').first()).n,40000);
 assert.equal((await h.db.prepare('SELECT SUM(unresolved_micro_usd) AS n FROM ongoing_spend').first()).n,40000);
 assert.equal((await h.db.prepare('SELECT state FROM service_writes WHERE idempotency_key=?').bind(key(40)).first()).state,'rejected');
});
