import { RUNTIME_NOW } from './clock-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime,json } from './helpers.mjs';
import { writeFixture,key,writeScopes } from '../test/write-fixtures.mjs';
import { seal } from '../src/security.mjs';
import { ownerContext } from '../src/reads.mjs';
const args=(n=1,text='Thanks for the useful question.',target='1002',author='5050')=>({text,in_reply_to_post_id:target,in_reply_to_author_id:author,idempotency_key:key(n)});
async function setup(t,overrides={}) {
 const now=RUNTIME_NOW,f=await writeFixture(now);
 const h=await runtime(t,{...f.env,POST_ENABLED:'true',REPLY_ENABLED:'true',X_OWN_THREAD_REPLIES_ENABLED:'true',X_CALLBACK_URL:f.env.PUBLIC_BASE_URL+'/x/callback',
  READ_POLLING_ENABLED:'false',MAX_REPLIES_DAY:'10',MAX_WRITES_DAY:'11',MAX_X_REQUESTS_DAY:'100',MAX_X_REQUESTS_HOUR:'20',X_ONGOING_OPERATIONS_ENABLED:'true',...overrides});
 const encrypted=await seal(h.bindings.TOKEN_ENCRYPTION_KEY,{access_token:'synthetic-browser-reply-token',refresh_token:'synthetic-refresh-token',scopes:writeScopes},ownerContext(h.bindings));
 await h.db.prepare('INSERT INTO accounts(id,issuer,subject,x_user_id,encrypted_tokens,expires_at,updated_at) VALUES(?,?,?,?,?,?,?)')
  .bind('primary',h.bindings.MCP_ISSUER,h.bindings.MCP_ALLOWED_SUBJECT,h.bindings.X_EXPECTED_USER_ID,encrypted,now+7200,now).run();
 await h.db.prepare('INSERT INTO x_credit_budgets VALUES(?,?,?,?,?,?,?)').bind(h.bindings.X_CREDIT_BUDGET_ID,'4242',5000000,0,0,Number(h.bindings.X_CREDIT_EXPIRES_AT),now).run();
 await h.db.prepare('INSERT INTO ongoing_credit_state VALUES(?,?,?,?)').bind('4242',4000000,0,'a'.repeat(64)).run();
 await h.db.prepare('INSERT INTO ongoing_cycles VALUES(?,?,?,?,?,?,?)').bind('4242',now-86400,now+30*86400,0,0,'a'.repeat(64),'2035-01').run();
 await h.db.prepare("INSERT INTO ongoing_legacy_carry VALUES('4242',0,0,0,0,0,0,'2034-12-31','2034-12',1,?)").bind(now).run();
 h.state.xScopes=writeScopes.join(' ');
 async function call(a=args(),claims={},options={}){const r=await f.request('x_reply',a,{iat:h.clock(),exp:h.clock()+45,...claims},options);const res=await h.mf.dispatchFetch(r.url,{method:'POST',headers:r.headers,body:await r.arrayBuffer()});const body=await res.json();return {body,receipt:body.result?.structuredContent,status:res.status};}
 return {...h,call,get db(){return h.db;},get mf(){return h.mf;},sends:()=>h.xCalls().filter(c=>c.method==='POST'&&c.url.pathname==='/2/tweets')};
}
test('fresh browser reply is exactly one HTTP POST, no footer, no reads or scans, with unchanged receipt and idempotency',async t=>{
 const h=await setup(t);const r=await h.call();assert.equal(r.receipt.state,'succeeded',JSON.stringify(r.body));
 assert.equal(h.xCalls().length,1);assert.equal(h.sends().length,1);assert.deepEqual(JSON.parse(h.sends()[0].body),{text:args().text,reply:{in_reply_to_tweet_id:'1002'}});
 assert.equal((await h.db.prepare('SELECT SUM(amount) AS n FROM ongoing_spend').first()).n,15000);
 assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM reply_opt_out_scans').first()).n,0);
 const interaction=await h.db.prepare('SELECT * FROM reply_interactions').first();assert.equal(interaction.author_id,'5050');assert.equal(interaction.root_id,null);
 await h.restart();assert.deepEqual((await h.call()).receipt,r.receipt);assert.equal(h.sends().length,1);
 assert.equal((await h.call(args(2,'Another thought.'))).receipt.code,'reply_interaction_already_claimed');assert.equal(h.sends().length,1);
});
test('explicit stored author and source opt-outs block before any provider request',async t=>{
 for(const [author,source] of [['5050','9999'],['6060','1002']])await t.test(author,async t=>{
  const h=await setup(t);await h.db.prepare('INSERT INTO reply_opt_outs VALUES(?,?,?,?)').bind('4242',author,source,h.clock()).run();
  assert.equal((await h.call()).receipt.code,'reply_author_opted_out');assert.equal(h.xCalls().length,0);
  assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM reply_opt_outs').first()).n,1);
 });
});
test('author field is required, body-bound, and cannot target self or bypass text validation',async t=>{
 const h=await setup(t);const missing=args();delete missing.in_reply_to_author_id;
 assert.equal((await h.call(missing)).status,400);
 assert.equal((await h.call(args(2,'Hi','1003','4242'))).receipt.code,'self_reply_not_supported');
 assert.equal((await h.call(args(3),{in_reply_to_post_id:'9999'})).status,403);
 assert.equal((await h.call(args(4,'Bad\u0001text'))).status,400);
 assert.equal((await h.call({...args(5),ignore_optouts:true})).status,400);
 const tampered=JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'x_reply',arguments:{...args(6),in_reply_to_author_id:'6060'}}});
 assert.equal((await h.call(args(6),{},{sendBody:tampered})).status,401);
 assert.equal(h.xCalls().length,0);
});
test('count and 15-minute cooldown remain enforced without paid reads',async t=>{
 const h=await setup(t);await h.db.prepare('UPDATE accounts SET expires_at=?').bind(h.clock()+86400).run();
 assert.equal((await h.call()).receipt.state,'succeeded');
 assert.equal((await h.call(args(2,'Too soon','1003'))).receipt.code,'ongoing_operation_limit_or_cooldown');
 for(let i=0;i<9;i++){await h.setTime(h.clock()+900);assert.equal((await h.call(args(10+i,'A useful response '+i,String(2000+i),String(6000+Math.floor(i/2))))).receipt.state,'succeeded');}
 await h.setTime(h.clock()+900);assert.equal((await h.call(args(20,'Eleventh response','3000'))).receipt.code,'ongoing_operation_limit_or_cooldown');assert.equal(h.sends().length,10);assert.equal(h.xCalls().length,10);
});
test('zero limit and insufficient dollars stop every provider call',async t=>{
 const zero=await setup(t,{MAX_REPLIES_DAY:'0'});assert.equal((await zero.call()).receipt.code,'ongoing_operation_limit_or_cooldown');assert.equal(zero.xCalls().length,0);
 const h=await setup(t);await h.db.prepare('UPDATE ongoing_cycles SET confirmed_used_micro_usd=4990000').run();assert.equal((await h.call()).receipt.code,'ongoing_spend_cap_or_reconciliation');assert.equal(h.xCalls().length,0);
});
test('unknown and rejected sends remain charged and cannot be resent',async t=>{
 for(const status of [201,400,503])await t.test(String(status),async t=>{
  const h=await setup(t);h.state.onX=()=>json({},status);const r=await h.call();assert.notEqual(r.receipt.state,'succeeded');
  assert.equal(h.sends().length,1);assert.equal((await h.db.prepare('SELECT SUM(amount) AS n FROM ongoing_spend').first()).n,15000);
  await h.restart();assert.deepEqual((await h.call()).receipt,r.receipt);assert.equal(h.sends().length,1);
 });
});
test('rotation during reservation prevents stale-grant reply and releases only unattempted write',async t=>{
 const h=await setup(t);await h.db.prepare("CREATE TRIGGER rotate_reply AFTER INSERT ON budgets BEGIN UPDATE accounts SET version=version+1 WHERE id='primary'; END").run();
 assert.equal((await h.call()).receipt.code,'x_grant_superseded');assert.equal(h.xCalls().length,0);assert.equal((await h.db.prepare('SELECT SUM(amount) AS n FROM ongoing_spend').first()).n,0);
});
test('expired token refresh is disclosed separately: token POST, account GET, then one reply POST',async t=>{
 const h=await setup(t);await h.db.prepare('UPDATE accounts SET expires_at=0').run();
 assert.equal((await h.call()).receipt.state,'succeeded');
 assert.deepEqual(h.xCalls().map(c=>[c.method,c.url.pathname]),[['POST','/2/oauth2/token'],['GET','/2/users/me'],['POST','/2/tweets']]);
 assert.equal((await h.db.prepare('SELECT SUM(amount) AS n FROM ongoing_spend').first()).n,35000);
});

test('Unicode punctuation and emoji are unchanged in the single POST at the ordinary create rate',async t=>{
 const h=await setup(t);const text='A café thought: “because we can” can be fun 😀';
 assert.equal((await h.call(args(1,text))).receipt.state,'succeeded');assert.equal(h.xCalls().length,1);
 assert.equal(JSON.parse(h.sends()[0].body).text,text);assert.equal((await h.db.prepare('SELECT SUM(amount) AS n FROM ongoing_spend').first()).n,15000);
});
test('opt-out arriving during reservation is atomically honored at dispatch claim',async t=>{
 const h=await setup(t);await h.db.prepare("CREATE TRIGGER late_stop AFTER INSERT ON budgets BEGIN INSERT OR IGNORE INTO reply_opt_outs VALUES('4242','5050','1002',0); END").run();
 assert.equal((await h.call()).receipt.code,'reply_dispatch_claim_denied');assert.equal(h.xCalls().length,0);
 assert.equal((await h.db.prepare('SELECT SUM(amount) AS n FROM ongoing_spend').first()).n,0);
 assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM reply_opt_outs').first()).n,1);
});
test('concurrent same-intent replies claim one POST and keep a single interaction',async t=>{
 const h=await setup(t);const results=await Promise.all(Array.from({length:6},()=>h.call()));
 assert.equal(results.filter(r=>r.receipt?.state==='succeeded').length,1);assert.equal(h.xCalls().length,1);
 assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM reply_interactions').first()).n,1);
});

test('two per author is local, independent across authors, and resets only at UTC midnight',async t=>{
 const h=await setup(t);assert.equal((await h.call()).receipt.state,'succeeded');
 await h.setTime(h.clock()+900);assert.equal((await h.call(args(2,'Second useful answer.','1003'))).receipt.state,'succeeded');
 await h.setTime(h.clock()+900);assert.equal((await h.call(args(3,'Third answer.','1004'))).receipt.code,'reply_author_daily_limit');assert.equal(h.xCalls().length,2);
 assert.equal((await h.call(args(4,'Another person.','1005','6060'))).receipt.state,'succeeded');
 await h.setTime(Date.parse('2035-01-01T23:59:59Z')/1000);assert.equal((await h.call(args(6,'Still the same UTC day.','1007'))).receipt.code,'reply_author_daily_limit');assert.equal(h.xCalls().length,3);
 await h.setTime(Date.parse('2035-01-02T00:00:00Z')/1000);await h.db.prepare('UPDATE accounts SET expires_at=?').bind(h.clock()+7200).run();
 assert.equal((await h.call(args(5,'A new day.','1006'))).receipt.state,'succeeded');assert.equal(h.xCalls().length,4);
 assert.equal((await h.db.prepare("SELECT COUNT(*) AS n FROM reply_interactions WHERE author_id='5050'").first()).n,3);
});
test('atomic per-author claim prevents concurrent third dispatch and includes pending/unknown claims',async t=>{
 const {Store}=await import('../src/storage.mjs');const {ReplyGuard}=await import('../src/reply-guard.mjs');
 const h=await setup(t);await h.call();await h.db.prepare("UPDATE service_writes SET state='unknown',post_id=NULL").run();
 for(const n of [2,3])await h.db.prepare("INSERT INTO service_writes SELECT ?,service_subject,owner_issuer,owner_subject,account_id,operation,payload_hash,'pending','dispatch_pending',NULL,created_at,updated_at FROM service_writes WHERE idempotency_key=?").bind(key(n),key(1)).run();
 const guard=new ReplyGuard(h.bindings,new Store(h.db,h.clock),h.clock),binding={issuer:h.bindings.MCP_ISSUER,subject:h.bindings.MCP_ALLOWED_SUBJECT,account:'4242'};
 const results=await Promise.allSettled([2,3].map(n=>guard.claimBrowserDispatch(binding,1,{author:'5050',target:String(2000+n),root:null,key:key(n)},'synthetic-key-'+n,'synthetic-send-'+n)));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.equal((await h.db.prepare("SELECT COUNT(*) AS n FROM reply_interactions WHERE author_id='5050'").first()).n,2);
 await assert.rejects(guard.verifyBrowser(args(4,'Third','1004')),e=>e.code==='REPLY_AUTHOR_DAILY_LIMIT');
 assert.equal(h.sends().length,1);
});
