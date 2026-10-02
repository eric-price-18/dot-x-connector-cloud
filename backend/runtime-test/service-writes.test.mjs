import { RUNTIME_NOW } from './clock-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime,json } from './helpers.mjs';
import { writeFixture,key,writeScopes } from '../test/write-fixtures.mjs';
import { seal } from '../src/security.mjs';
import { ownerContext } from '../src/reads.mjs';

async function setup(t,changes={}) {
 const f=await writeFixture(RUNTIME_NOW);
 const h=await runtime(t,{...f.env,X_CALLBACK_URL:new URL(f.env.PUBLIC_BASE_URL).origin+'/x/callback',...changes});
 const now=RUNTIME_NOW;
 const encrypted=await seal(h.bindings.TOKEN_ENCRYPTION_KEY,{access_token:'runtime-write-access',refresh_token:'runtime-write-refresh',scopes:writeScopes},ownerContext(h.bindings));
 await h.db.prepare('INSERT INTO accounts(id,issuer,subject,x_user_id,encrypted_tokens,expires_at,updated_at) VALUES(?,?,?,?,?,?,?)')
  .bind('primary',h.bindings.MCP_ISSUER,h.bindings.MCP_ALLOWED_SUBJECT,h.bindings.X_EXPECTED_USER_ID,encrypted,now+7200,now).run();
 async function call(name,args,claims={},options={}) {
  const request=await f.request(name,args,claims,options);
  const response=await h.mf.dispatchFetch(request.url,{method:request.method,headers:request.headers,redirect:'manual',body:await request.arrayBuffer()});
  const body=await response.json();return {response,body,receipt:body.result?.structuredContent};
 }
 const sends=()=>h.xCalls().filter(v=>v.method==='POST'&&v.url.pathname!=='/2/oauth2/token');
 return {...h,f,call,sends,status:idempotency_key=>call('x_get_write_status',{idempotency_key}),get db(){return h.db;}};
}
const post=(text='Runtime original',n=1)=>({text,idempotency_key:key(n)});

test('workerd write: real ES256/WebCrypto/D1 sends once, receipt persists through restart',async t=>{
 const h=await setup(t);const r=await h.call('x_create_original_post',post());
 assert.equal(r.receipt.state,'succeeded',JSON.stringify(r.body));assert.equal(h.sends().length,1);
 assert.deepEqual(JSON.parse(h.sends()[0].body),{text:'Runtime original'});
 await h.restart();assert.deepEqual((await h.status(key(1))).receipt,r.receipt);
 assert.deepEqual((await h.call('x_create_original_post',post())).receipt,r.receipt);assert.equal(h.sends().length,1);
});

test('workerd write: concurrent same-key and alternate-key content have one durable dispatch',async t=>{
 const h=await setup(t);
 const results=await Promise.all(Array.from({length:12},()=>h.call('x_create_original_post',post())));
 assert(results.some(v=>v.receipt.state==='succeeded'));assert.equal(h.sends().length,1);
 const more=await Promise.all(Array.from({length:8},(_,i)=>h.call('x_create_original_post',post('Shared second payload',i+2))));
 assert.equal(more.filter(v=>v.receipt.state==='succeeded').length,1);assert.equal(h.sends().length,2);
 const rows=await h.db.prepare('SELECT status FROM sends').all();assert(rows.results.every(v=>v.status==='sent'));
});

test('workerd write: ambiguous accepted response never retries after restart or a new key',async t=>{
 const h=await setup(t);h.state.onX=call=>call.url.pathname==='/2/tweets'?json({},201):undefined;
 assert.equal((await h.call('x_create_original_post',post())).receipt.state,'unknown');
 await h.restart();h.state.onX=null;
 assert.equal((await h.call('x_create_original_post',post())).receipt.state,'unknown');
 assert.equal((await h.call('x_create_original_post',post(post().text,2))).receipt.state,'rejected');assert.equal(h.sends().length,1);
});

test('workerd write: DB finalization abort after remote success preserves pending claim through restart',async t=>{
 const h=await setup(t);
 await h.db.prepare("CREATE TRIGGER fail_service_update BEFORE UPDATE ON service_writes BEGIN SELECT RAISE(ABORT,'mock finalization failure'); END").run();
 const r=await h.call('x_create_original_post',post());assert.equal(r.receipt.state,'unknown');
 await h.db.prepare('DROP TRIGGER fail_service_update').run();await h.restart();
 assert.equal((await h.status(key(1))).receipt.state,'pending');
 assert.equal((await h.call('x_create_original_post',post())).receipt.state,'pending');assert.equal(h.sends().length,1);
 await h.db.prepare('UPDATE service_writes SET created_at=created_at-121').run();
 assert.equal((await h.status(key(1))).receipt.state,'unknown');
});

test('workerd write: pending status while remote response is delayed becomes verified late success',async t=>{
 const h=await setup(t);let release,started;
 const gate=new Promise(resolve=>{release=resolve;});const entered=new Promise(resolve=>{started=resolve;});
 h.state.onX=async call=>{if(call.url.pathname==='/2/tweets'){started();await gate;return json({data:{id:'9007199254740993'}},201);}};
 const first=h.call('x_create_original_post',post());await entered;
 assert.equal((await h.status(key(1))).receipt.state,'pending');
 assert.equal((await h.call('x_create_original_post',post())).receipt.state,'pending');assert.equal(h.sends().length,1);
 release();const success=await first;assert.equal(success.receipt.post_id,'9007199254740993');
 assert.equal((await h.status(key(1))).receipt.state,'succeeded');
});

test('workerd write: exact repost endpoint/body, distinct conservative cap',async t=>{
 const h=await setup(t,{MAX_REPOSTS_DAY:'1'});
 h.state.onX=call=>{assert.equal(call.url.pathname,'/2/users/4242/retweets');assert.deepEqual(JSON.parse(call.body),{tweet_id:'900'});return json({data:{retweeted:true}});};
 const first=await h.call('x_repost',{post_id:'900',idempotency_key:key(1)});assert.equal(first.receipt.post_id,'900');
 assert.equal((await h.call('x_repost',{post_id:'901',idempotency_key:key(2)})).receipt.code,'local_budget_exhausted');assert.equal(h.sends().length,1);
});

test('workerd write: read-only status never decrypts expired tokens or invokes any provider',async t=>{
 const h=await setup(t);await h.db.prepare("UPDATE accounts SET encrypted_tokens='invalid',expires_at=0").run();
 assert.equal((await h.status(key(1))).receipt.state,'not_found');assert.equal(h.state.calls.length,0);
});

test('workerd write: signature/body/proof binding, broad tools, policy reply gate fail closed',async t=>{
 const h=await setup(t,{REPLY_ENABLED:'true',X_REPLIES_ENABLED:'true'});
 assert.equal((await h.call('x_create_original_post',post(),{scope:'x:read'})).response.status,401);
 assert.equal((await h.call('x_create_original_post',post(),{idempotency_key:key(2)})).response.status,403);
 assert.equal((await h.call('x_create_original_post',post(),{}, {sendBody:h.f.body('x_create_original_post',post('tampered'))})).response.status,401);
 assert.equal((await h.call('x_delete_post',post())).response.status,401);
 assert.equal((await h.call('x_reply',{text:'Runtime reply',in_reply_to_post_id:'900',idempotency_key:key(1)})).receipt.code,'own_thread_replies_disabled');
 const mention=await h.call('x_create_original_post',post('@someone hello'));
 assert.equal(mention.response.status,403);assert.equal(mention.body.error.message,'CANARY_MENTION_NOT_CONFIGURED');
 assert.equal(h.state.calls.length,0);
});

test('workerd write:401 marks reconnect and rejected intent survives restart',async t=>{
 const h=await setup(t);h.state.onX=call=>call.url.pathname==='/2/tweets'?json({},401):undefined;
 assert.equal((await h.call('x_create_original_post',post())).receipt.code,'x_reconnect_required');
 assert.equal((await h.db.prepare("SELECT refresh_status FROM accounts WHERE id='primary'").first()).refresh_status,'reconnect');
 await h.restart();assert.equal((await h.call('x_create_original_post',post())).receipt.state,'rejected');assert.equal(h.sends().length,1);
});

test('workerd write: concurrent distinct intents cannot overrun combined daily write cap',async t=>{
 const h=await setup(t,{MAX_WRITES_DAY:'1'});
 const results=await Promise.all(Array.from({length:8},(_,i)=>h.call('x_create_original_post',post('Concurrent unique '+i,i+1))));
 assert.equal(results.filter(r=>r.receipt.state==='succeeded').length,1);
 assert.equal(results.filter(r=>r.receipt.state==='rejected').length,7);assert.equal(h.sends().length,1);
});

test('workerd write: service/operation/live gates and absent fixed ID deny before outbound calls',async t=>{
 const h=await setup(t,{SERVICE_X_ACCOUNT_ID:''});
 const r=await h.call('x_create_original_post',post());assert.equal(r.body.result.content[0].text,'VERIFIED_SERVICE_ACCOUNT_REQUIRED');
 assert.equal(h.state.calls.length,0);
});
