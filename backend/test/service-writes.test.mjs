import test from 'node:test';
import assert from 'node:assert/strict';
import { response, rejectsCode } from './helpers.mjs';
import { key, writeScopes, writeHarness } from './write-fixtures.mjs';
import { validatePostText,isPostId } from '../src/write-validation.mjs';
import { createWorker } from '../src/worker.mjs';

const post=(text='A public cloud observation',id=1)=>({text,idempotency_key:key(id)});

test('write bridge sends original once and returns durable success/status with no token or text leakage',async t=>{
 const h=await writeHarness(t);await h.seed({scopes:writeScopes});
 const first=await h.call('x_create_original_post',post());assert.equal(first.receipt.state,'succeeded');
 assert.deepEqual(JSON.parse(h.sends()[0].options.body),{text:post().text});
 assert.equal(h.sends()[0].options.headers.authorization,'Bearer mock-seeded-access');
 assert.deepEqual((await h.call('x_create_original_post',post())).receipt,first.receipt);
 assert.deepEqual((await h.status(key(1))).receipt,first.receipt);assert.equal(h.sends().length,1);
 assert(!JSON.stringify(h.db.all('SELECT * FROM service_writes')).includes(post().text));
 assert(!JSON.stringify(first).includes('mock-seeded-access'));
});

test('repost uses exact account endpoint and only tweet_id, same target new key is suppressed',async t=>{
 const h=await writeHarness(t);await h.seed({scopes:writeScopes});
 h.state.onX=(url,options)=>{assert.equal(url,'https://api.x.com/2/users/4242/retweets');assert.deepEqual(JSON.parse(options.body),{tweet_id:'900'});return response({data:{retweeted:true}});};
 const args={post_id:'900',idempotency_key:key(1)};
 const r=await h.call('x_repost',args);assert.equal(r.receipt.state,'succeeded');assert.equal(r.receipt.post_id,'900');
 assert.deepEqual((await h.call('x_repost',args)).receipt,r.receipt);
 assert.equal((await h.call('x_repost',{...args,idempotency_key:key(2)})).receipt.state,'rejected');assert.equal(h.sends().length,1);
 assert.equal(h.db.all('SELECT status FROM sends')[0].status,'sent');
});

test('concurrent same key yields single dispatch; concurrent content under new keys cannot clobber success tombstone',async t=>{
 const h=await writeHarness(t);await h.seed({scopes:writeScopes});
 const same=await Promise.all(Array.from({length:12},()=>h.call('x_create_original_post',post())));
 assert(same.some(r=>r.receipt.state==='succeeded'));assert.equal(h.sends().length,1);
 const other=await Promise.all(Array.from({length:8},(_,i)=>h.call('x_create_original_post',post('One duplicate payload',i+2))));
 assert.equal(other.filter(r=>r.receipt.state==='succeeded').length,1);assert.equal(h.sends().length,2);
 assert(h.db.all('SELECT status FROM sends').every(r=>r.status==='sent'));
});

test('one UUID is bound to exact operation and payload, including rejected duplicate intents',async t=>{
 const h=await writeHarness(t);await h.seed({scopes:writeScopes});await h.call('x_create_original_post',post());
 for(const [name,args] of [['x_create_original_post',post('changed')],['x_repost',{post_id:'900',idempotency_key:key(1)}]])
  assert.equal((await h.call(name,args)).receipt.code,'idempotency_binding_conflict');
 assert.equal((await h.call('x_create_original_post',post(post().text,2))).receipt.state,'rejected');
 assert.equal((await h.call('x_create_original_post',post('changed',2))).receipt.code,'idempotency_binding_conflict');assert.equal(h.sends().length,1);
});

test('legacy and service original posts share persistent duplicate-content tombstones in both directions',async t=>{
 const h=await writeHarness(t);await h.seed({scopes:writeScopes});
 await h.x.send('post',post('Legacy first',1));
 assert.equal((await h.call('x_create_original_post',post('Legacy first',2))).receipt.state,'rejected');
 await h.call('x_create_original_post',post('Service first',3));
 await rejectsCode(h.x.send('post',post('Service first',4)),'DUPLICATE_CONTENT_DO_NOT_RESEND');assert.equal(h.sends().length,2);
 assert(h.db.all('SELECT status FROM sends').every(r=>r.status==='sent'));
});

for(const [label,reply] of [
 ['lost response',()=>{throw Error('private transport error');}],['HTTP500',()=>response({},500)],['HTTP408',()=>response({},408)],
 ['redirect',()=>new Response(null,{status:302,headers:{location:'https://must-not-follow.invalid'}})],
 ['malformedJSON',()=>new Response('{',{headers:{'content-type':'application/json'}})],['missingID',()=>response({})],
 ['numericID',()=>response({data:{id:9001}})],['partialerror',()=>response({data:{id:'9001'},errors:[{detail:'private'}]})],
 ['oversize',()=>new Response('x'.repeat(65537),{headers:{'content-type':'application/json'}})]
]) test(`write bridge ${label} stays unknown, never dispatches a retry or accepts a new key duplicate`,async t=>{
 const h=await writeHarness(t);await h.seed({scopes:writeScopes});h.state.onX=reply;
 const r=await h.call('x_create_original_post',post());assert.equal(r.receipt.state,'unknown');assert(!r.receipt.post_id);
 h.state.onX=null;
 assert.equal((await h.call('x_create_original_post',post())).receipt.state,'unknown');
 assert.equal((await h.call('x_create_original_post',post(post().text,2))).receipt.state,'rejected');assert.equal(h.sends().length,1);
 assert.equal((await h.status(key(1))).receipt.state,'unknown');
});

for(const status of [400,401,403,404,409,422,429])test(`explicit HTTP${status} is durably rejected without retry`,async t=>{
 const h=await writeHarness(t);await h.seed({scopes:writeScopes});h.state.onX=()=>response({detail:'must not escape'},status);
 const r=await h.call('x_create_original_post',post());assert.equal(r.receipt.state,'rejected');
 assert.deepEqual((await h.call('x_create_original_post',post())).receipt,r.receipt);assert.equal(h.sends().length,1);
 assert(!JSON.stringify(r.body).includes('must not escape'));
});

test('storage failure after remote success returns unknown; receipt and tombstone are never replayed',async t=>{
 const h=await writeHarness(t);await h.seed({scopes:writeScopes});
 h.db.beforeQuery=sql=>{if(sql.includes('UPDATE service_writes SET state='))throw Error('private db error');};
 const r=await h.call('x_create_original_post',post());assert.equal(r.receipt.state,'unknown');assert.equal(r.receipt.code,'ledger_commit_uncertain');
 h.db.beforeQuery=null;assert.equal(h.db.all('SELECT status FROM sends')[0].status,'pending');
 assert.equal((await h.call('x_create_original_post',post())).receipt.state,'pending');assert.equal(h.sends().length,1);
 h.state.now+=121;
 assert.equal((await h.status(key(1),{iat:h.clock(),exp:h.clock()+45})).receipt.state,'unknown');
});

test('receipt insert acknowledgment lost after commit cannot dispatch on retry',async t=>{
 const h=await writeHarness(t);await h.seed({scopes:writeScopes});const prepare=h.db.prepare.bind(h.db);let lose=true;
 h.db.prepare=sql=>{const statement=prepare(sql);const first=statement.first;statement.first=async function(){const value=await first.call(this);if(lose&&sql.startsWith('INSERT INTO service_writes')){lose=false;throw Error('lost db ack');}return value;};return statement;};
 const r=await h.call('x_create_original_post',post());assert.equal(r.body.result.isError,true);
 assert.equal((await h.call('x_create_original_post',post())).receipt.state,'pending');assert.equal(h.sends().length,0);
});

test('claim failure before dispatch, missing migration and noDB all fail closed',async t=>{
 const h=await writeHarness(t);await h.seed({scopes:writeScopes});h.db.beforeQuery=sql=>{if(sql.startsWith('INSERT INTO service_writes'))throw Error('private db error');};
 assert.equal((await h.call('x_create_original_post',post())).body.result.content[0].text,'INTERNAL_ERROR');
 h.db.beforeQuery=null;h.db.sqlite.exec('DROP TABLE service_writes');
 assert.equal((await h.call('x_create_original_post',post())).body.result.isError,true);delete h.env.DB;
 assert.equal((await h.call('x_create_original_post',post())).body.result.content[0].text,'D1_BINDING_REQUIRED');assert.equal(h.sends().length,0);
});

test('original+repost share existing daily budget, and separate repost budget is pessimistic',async t=>{
 const h=await writeHarness(t,{MAX_WRITES_DAY:'1'});await h.seed({scopes:writeScopes});
 await h.call('x_create_original_post',post());
 assert.equal((await h.call('x_repost',{post_id:'900',idempotency_key:key(2)})).receipt.code,'local_budget_exhausted');assert.equal(h.sends().length,1);
 const before=h.db.all('SELECT * FROM sends');assert.equal(before.length,2);
 assert.equal((await h.call('x_repost',{post_id:'900',idempotency_key:key(2)})).receipt.state,'rejected');
});

test('failed refresh retains both consumed service key and existing refresh reconnect marker',async t=>{
 const h=await writeHarness(t);await h.seed({scopes:writeScopes,expires:h.clock()-1});
 h.state.onX=()=>{throw Error('refresh response lost');};
 assert.equal((await h.call('x_create_original_post',post())).receipt.state,'rejected');
 assert.equal((await h.store.account()).refresh_status,'reconnect');assert.equal(h.state.xCalls.length,1);
 await h.call('x_create_original_post',post());assert.equal(h.state.xCalls.length,1);assert.equal(h.sends().length,0);
});

test('status lookups never read/refresh tokens, survive revoked live gate, and hide other owner/account receipts',async t=>{
 const h=await writeHarness(t);await h.seed({scopes:writeScopes});await h.call('x_create_original_post',post());
 await h.store.run("UPDATE accounts SET encrypted_tokens='must-not-decrypt',expires_at=0");h.env.LIVE_X_ENABLED='false';
 assert.equal((await h.status(key(1))).receipt.state,'succeeded');assert.equal((await h.status(key(9))).receipt.state,'not_found');
 h.env.MCP_ALLOWED_SUBJECT='different-owner';assert.equal((await h.status(key(1))).receipt.state,'not_found');assert.equal(h.sends().length,1);
});

for(const change of [{SERVICE_X_ACCOUNT_ID:''},{SERVICE_X_ACCOUNT_ID:'77'},{X_EXPECTED_USER_ID:'77'},{POST_ENABLED:'false'},{X_ORIGINAL_POSTS_ENABLED:'false'},{LIVE_X_ENABLED:'false'}])
 test('fixed verified account and independent write gates fail closed '+JSON.stringify(change),async t=>{
 const h=await writeHarness(t,change);await h.seed({scopes:writeScopes});
 assert.equal((await h.call('x_create_original_post',post())).body.result.isError,true);assert.equal(h.sends().length,0);
});

test('token owner/account binding failure is consumed without X dispatch; reply gate cannot be enabled with env',async t=>{
 const h=await writeHarness(t,{REPLY_ENABLED:'true',X_REPLIES_ENABLED:'true'});await h.seed({scopes:writeScopes});
 await h.store.run("UPDATE accounts SET subject='wrong-owner'");assert.equal((await h.call('x_create_original_post',post())).receipt.state,'rejected');
 const reply=await h.call('x_reply',{text:'A reply',in_reply_to_post_id:'900',in_reply_to_author_id:'5050',idempotency_key:key(2)});
 assert.equal(reply.receipt.code,'own_thread_replies_disabled');assert.equal(h.sends().length,0);
});

test('text validation uses real weighted280, URL and grapheme rules and excludes mention/quote paths',()=>{
 for(const text of ['a'.repeat(280),'漢'.repeat(140),'👨‍👩‍👧‍👦'.repeat(140),'a'.repeat(256)+' https://example.com/'+ 'long'.repeat(30)])assert.equal(validatePostText(text),text);
 for(const text of ['a'.repeat(281),'漢'.repeat(141),'👨‍👩‍👧‍👦'.repeat(141),'e\u0301','\ud800','\udc00','Good \ud800 text','Hi @someone','＠someone','\u202eHidden','https://x.com/a/status/1','twitter.com/i/web/status/2','https://mobile.x.com/a/%73tatus/3','https://t.co/abc'])assert.throws(()=>validatePostText(text));
 for(const id of ['1','9007199254740993','9999999999999999999'])assert(isPostId(id));
 for(const id of [1,'0','01','-1','1e3','18446744073709551615'])assert(!isPostId(id));
});

test('legacy original text cannot bypass mention/quote/weighted validation',async t=>{
 const h=await writeHarness(t);await h.seed({scopes:writeScopes});
 for(const text of ['Hi @someone','漢'.repeat(141),'https://x.com/a/status/1'])await assert.rejects(h.x.send('post',post(text)));
 assert.equal(h.sends().length,0);
});

test('newer owner grant between token read and dispatch fences the old write token',async t=>{
 const h=await writeHarness(t);await h.seed({scopes:writeScopes});let changed=false;
 h.db.beforeQuery=(sql,args)=>{if(!changed&&sql.includes('INSERT INTO budgets')){changed=true;h.db.sqlite.prepare("UPDATE accounts SET version=version+1,encrypted_tokens='newer-grant' WHERE id='primary'").run();}};
 assert.equal((await h.call('x_create_original_post',post())).receipt.code,'x_grant_superseded');
 assert.equal(h.sends().length,0);assert.equal((await h.call('x_create_original_post',post())).receipt.state,'rejected');
});

test('legacy sends reject partial errors and numeric IDs so they cannot seed false service success',async t=>{
 const h=await writeHarness(t);await h.seed({scopes:writeScopes});h.state.onX=()=>response({data:{id:'9001'},errors:[{detail:'partial'}]});
 await rejectsCode(h.x.send('post',post()),'X_SEND_RESULT_INVALID');
 assert.equal((await h.call('x_create_original_post',post())).receipt.state,'rejected');
 assert.equal(h.sends().length,1);
});

test('X401 marks reconnect without refresh retry and cannot poison a newer grant',async t=>{
 const h=await writeHarness(t);await h.seed({scopes:writeScopes});h.state.onX=()=>response({},401);
 const r=await h.call('x_create_original_post',post());assert.equal(r.receipt.code,'x_reconnect_required');
 assert.equal((await h.store.account()).refresh_status,'reconnect');assert.equal(h.state.xCalls.length,1);
});

test('X401 arriving after reauthorization preserves newer grant state',async t=>{
 const h=await writeHarness(t);await h.seed({scopes:writeScopes});
 h.state.onX=()=>{h.db.sqlite.prepare("UPDATE accounts SET version=version+1 WHERE id='primary'").run();return response({},401);};
 assert.equal((await h.call('x_create_original_post',post())).receipt.state,'rejected');
 assert.equal((await h.store.account()).refresh_status,'idle');assert.equal(h.state.xCalls.length,1);
});

test('legacy write grant is rechecked after budget awaits immediately before fetch',async t=>{
 const h=await writeHarness(t);await h.seed({scopes:writeScopes});let changed=false;
 h.db.beforeQuery=sql=>{if(!changed&&sql.includes('INSERT INTO budgets')){changed=true;h.db.sqlite.prepare("UPDATE accounts SET version=version+1 WHERE id='primary'").run();}};
 await rejectsCode(h.x.send('post',post()),'X_GRANT_SUPERSEDED');assert.equal(h.sends().length,0);
});

test('read connection status never advertises replies when policy gate is hard-disabled',async t=>{
 const h=await writeHarness(t,{REPLY_ENABLED:'true'});await h.seed({scopes:writeScopes});
 const {readTool}=await import('../src/reads.mjs');
 assert.equal((await readTool('x_connection_status',h.env,h.clock)).reply_enabled,false);
});
