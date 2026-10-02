import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, rejectsCode, response } from './helpers.mjs';
import { createWorker } from '../src/worker.mjs';

const writeScopes=['tweet.read','users.read','offline.access','tweet.write'];
const args=(text='Mock original post',key='mock-send-key-0001')=>({text,idempotency_key:key});
const sendCalls=h=>h.state.xCalls.filter(v=>new URL(v.url).pathname==='/2/tweets');

test('post tool sends only after both MCP and X write scopes plus its own enable flag', async t => {
  const h=harness(t,{POST_ENABLED:'true'}); h.state.mcpScopes='x:read x:post'; await h.seed({scopes:writeScopes});
  const res=await h.call('x_create_post',args());
  assert.equal(res.response.status,200); assert(!res.body.result.isError);
  assert.equal(res.body.result.structuredContent.duplicate,false);
  assert.deepEqual(JSON.parse(sendCalls(h)[0].options.body),{text:'Mock original post'});
  assert.equal(sendCalls(h)[0].options.headers.authorization,'Bearer mock-seeded-access');
  assert.equal(h.db.all('SELECT * FROM sends')[0].status,'sent');
  assert(!JSON.stringify(h.db.all('SELECT * FROM sends')).includes('Mock original post'));
});

test('post enable flag cannot enable replies; direct sends recheck the flag', async t => {
  const h=harness(t,{POST_ENABLED:'true'}); await h.seed({scopes:writeScopes});
  await rejectsCode(h.x.send('reply',{...args(),in_reply_to_post_id:'1002'}),'REPLY_APPROVAL_REQUIRED');
  h.env.POST_ENABLED='false';
  await rejectsCode(h.x.send('post',args()),'POST_DISABLED');
  assert.equal(h.state.xCalls.length,0);
});

test('a read-only X grant cannot post even when MCP permission and flag are present', async t => {
  const h=harness(t,{POST_ENABLED:'true'}); h.state.mcpScopes='x:read x:post'; await h.seed();
  const res=await h.call('x_create_post',args());
  assert.equal(res.body.result.content[0].text,'X_WRITE_SCOPE_REQUIRED');
  assert.equal(h.state.xCalls.length,0);
  assert.equal(h.db.all('SELECT * FROM sends').length,0);
});

test('production X egress guard still blocks a write if tool flag and scopes are enabled', async t => {
  const h=harness(t,{POST_ENABLED:'true'}); h.state.mcpScopes='x:read x:post'; await h.seed({scopes:writeScopes});
  const worker=createWorker({clock:h.clock,idpFetch:h.idpFetch,logger:()=>{}});
  const res=await worker.fetch(h.request('/mcp',{method:'POST',auth:true,headers:{accept:'application/json, text/event-stream'},
    data:{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'x_create_post',arguments:args()}}}),h.env);
  assert.equal((await res.json()).result.content[0].text,'LIVE_X_DISABLED');
  assert.equal(h.state.xCalls.length,0);
});

test('write authorization asks for tweet.write only with the corresponding permission and enable flag', async t => {
  const h=harness(t,{POST_ENABLED:'true'});
  const denied=await h.api('/x/connect',{method:'POST',auth:true,data:{mode:'post'}});
  assert.equal((await denied.json()).error,'POST_DISABLED_OR_UNAUTHORIZED');
  h.state.mcpScopes='x:read x:post';
  const start=await h.start('post');
  assert.equal(start.url.searchParams.get('scope'),'tweet.read users.read offline.access tweet.write');
  assert.equal((await (await h.api('/x/connect',{method:'POST',auth:true,data:{mode:'reply'}})).json()).error,'REPLY_DISABLED_OR_UNAUTHORIZED');
  const read=await h.start('read');
  assert(!read.url.searchParams.get('scope').includes('tweet.write'));
});

test('same idempotency key and payload return the saved result without resending', async t => {
  const h=harness(t,{POST_ENABLED:'true'}); await h.seed({scopes:writeScopes});
  const first=await h.x.send('post',args());
  const second=await h.x.send('post',args());
  assert.equal(second.id,first.id); assert.equal(second.duplicate,true);
  assert.equal(sendCalls(h).length,1);
});

test('same key with changed payload and same payload with a new key are blocked', async t => {
  const h=harness(t,{POST_ENABLED:'true'}); await h.seed({scopes:writeScopes});
  await h.x.send('post',args());
  await rejectsCode(h.x.send('post',args('Different post')),'IDEMPOTENCY_KEY_REUSED');
  await rejectsCode(h.x.send('post',args('Mock original post','mock-send-key-0002')),'DUPLICATE_CONTENT_DO_NOT_RESEND');
  assert.equal(sendCalls(h).length,1);
});

test('key conflict wins when a changed payload also belongs to another successful send', async t => {
  const h=harness(t,{POST_ENABLED:'true'}); await h.seed({scopes:writeScopes});
  await h.x.send('post',args('Post A','mock-send-key-0001'));
  await h.x.send('post',args('Post B','mock-send-key-0002'));
  await rejectsCode(h.x.send('post',args('Post B','mock-send-key-0001')),'IDEMPOTENCY_KEY_REUSED');
  assert.equal(sendCalls(h).length,2);
});

test('concurrent identical send attempts produce at most one outbound create call', async t => {
  const h=harness(t,{POST_ENABLED:'true'}); await h.seed({scopes:writeScopes});
  const outcomes=await Promise.allSettled(Array.from({length:8},()=>h.x.send('post',args())));
  assert(outcomes.some(v=>v.status==='fulfilled'));
  assert.equal(sendCalls(h).length,1);
  for (const v of outcomes.filter(v=>v.status==='rejected')) assert.equal(v.reason.code,'SEND_PENDING_OR_UNCERTAIN_DO_NOT_RETRY');
});

test('lost send response remains uncertain and cannot be retried after time passes', async t => {
  const h=harness(t,{POST_ENABLED:'true'}); await h.seed({scopes:writeScopes});
  h.state.onX=()=>{throw new Error('Mock network loss after remote acceptance');};
  await rejectsCode(h.x.send('post',args()),'X_REQUEST_UNCERTAIN');
  assert.equal(h.db.all('SELECT * FROM sends')[0].status,'uncertain');
  h.state.onX=null; h.state.now+=86400; await h.seed({scopes:writeScopes});
  await rejectsCode(h.x.send('post',args()),'SEND_PENDING_OR_UNCERTAIN_DO_NOT_RETRY');
  await rejectsCode(h.x.send('post',args('Mock original post','mock-send-key-0002')),'DUPLICATE_CONTENT_DO_NOT_RESEND');
  assert.equal(sendCalls(h).length,1);
});

test('storage failure after remote success preserves a durable send tombstone', async t => {
  const h=harness(t,{POST_ENABLED:'true'}); await h.seed({scopes:writeScopes});
  h.db.beforeQuery=sql=>{if(sql.includes("SET status='sent'")) throw new Error('Mock storage failure');};
  await assert.rejects(h.x.send('post',args()));
  h.db.beforeQuery=null;
  assert.equal(h.db.all('SELECT * FROM sends')[0].status,'uncertain');
  await rejectsCode(h.x.send('post',args()),'SEND_PENDING_OR_UNCERTAIN_DO_NOT_RETRY');
  assert.equal(sendCalls(h).length,1);
});

test('pending send left by a crashed process is never automatically resent', async t => {
  const h=harness(t,{POST_ENABLED:'true'}); await h.seed({scopes:writeScopes});
  await h.x.send('post',args());
  await h.store.run("UPDATE sends SET status='pending',result_id=NULL");
  const before=sendCalls(h).length;
  await rejectsCode(h.x.send('post',args()),'SEND_PENDING_OR_UNCERTAIN_DO_NOT_RETRY');
  assert.equal(sendCalls(h).length,before);
});

test('daily write budget blocks the third unique send', async t => {
  const h=harness(t,{POST_ENABLED:'true'}); await h.seed({scopes:writeScopes});
  await h.x.send('post',args('One','mock-budget-key-001'));
  await h.x.send('post',args('Two','mock-budget-key-002'));
  await rejectsCode(h.x.send('post',args('Three','mock-budget-key-003')),'LOCAL_BUDGET_EXHAUSTED');
  assert.equal(sendCalls(h).length,2);
});

test('legacy replies stay disabled even with fresh mentions and the reply flag', async t => {
  const h=harness(t,{REPLY_ENABLED:'true'}); h.state.mcpScopes='x:read x:reply'; await h.seed({scopes:writeScopes});
  await h.x.pollKind('mentions',await h.x.tokens());
  const res=await h.call('x_reply_to_post',{...args('Mock reply'),in_reply_to_post_id:'1002'});
  assert.equal(res.body.error.message,'UNKNOWN_OR_DISABLED_TOOL');
  assert.equal(sendCalls(h).length,0);
  assert.equal((await h.call('x_create_post',args())).body.error.message,'UNKNOWN_OR_DISABLED_TOOL');
});

test('all legacy reply targets require written X approval before any send', async t => {
  const h=harness(t,{REPLY_ENABLED:'true'}); await h.seed({scopes:writeScopes});
  await h.x.pollKind('mentions',await h.x.tokens());
  await rejectsCode(h.x.send('reply',{...args(),in_reply_to_post_id:'9999'}),'REPLY_APPROVAL_REQUIRED');
  h.state.now+=8*3600; await h.seed({scopes:writeScopes}); h.state.mentions={meta:{result_count:0}};
  await h.x.pollKind('mentions',await h.x.tokens());
  assert.equal((await h.x.cached('mentions')).stale,false);
  assert.equal((await h.x.cached('mentions')).records[0].id,'1002');
  await rejectsCode(h.x.send('reply',{...args(),in_reply_to_post_id:'1002'}),'REPLY_APPROVAL_REQUIRED');
  assert.equal(sendCalls(h).length,0);
});

test('invalid text, key, target and extra proxy arguments never reach X', async t => {
  const h=harness(t,{POST_ENABLED:'true',REPLY_ENABLED:'true'}); h.state.mcpScopes='x:read x:post x:reply'; await h.seed({scopes:writeScopes});
  for (const input of [args(''),args('x'.repeat(281)),args('Text','short'),{...args(),url:'https://attacker.invalid'},{...args(),access_token:'mock-token'}]) {
    const res=await h.call('x_create_post',input);
    assert(res.body.error || res.body.result.isError);
  }
  const res=await h.call('x_reply_to_post',{...args(),in_reply_to_post_id:'../dm'});
  assert.equal(res.body.error.code,-32602);
  assert.equal(h.state.xCalls.length,0);
});

test('upstream errors and malformed send results never count as confirmed success', async t => {
  const h=harness(t,{POST_ENABLED:'true'}); await h.seed({scopes:writeScopes});
  h.state.onX=()=>response({detail:'mock private failure'},500);
  await rejectsCode(h.x.send('post',args()),'X_UPSTREAM_REJECTED');
  h.state.onX=()=>response({data:{id:'not-a-post-id'}});
  await rejectsCode(h.x.send('post',args('Other text','mock-other-key-002')),'X_SEND_RESULT_INVALID');
  assert(h.db.all('SELECT * FROM sends').every(v=>v.status==='uncertain'));
});
