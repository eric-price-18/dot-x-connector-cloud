import test from 'node:test';
import assert from 'node:assert/strict';
import { writeHarness,key,writeScopes } from './write-fixtures.mjs';
import { SERVICE } from '../src/service.mjs';

const args={text:'Verified exact intent',idempotency_key:key(1)};
for(const [label,claims] of [
 ['issuer',{iss:'https://another.invalid'}],['subject',{sub:'someone-else'}],['read audience',{aud:SERVICE.audience}],
 ['read scope',{scope:'x:read'}],['reply scope',{scope:'x:reply'}],['status scope',{scope:'x:write:status'}],['broad scope',{scope:'x:write x:read'}],
 ['method',{method:'GET'}],['read path',{path:'/service/mcp'}],['unknown operation',{operation:'x_delete_post'}],
 ['non UUID key',{idempotency_key:'not-a-uuid'}],['uppercase UUID',{idempotency_key:'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'}],
 ['non UUID nonce',{jti:'nonce'}],['extra claim',{admin:true}],['reply claim on original',{in_reply_to_post_id:'900'}],
 ['wrong hash',{body_sha256:'A'.repeat(43)}],['45s only',{exp:1790856060}]
])test('write proof rejects '+label+' before all DB/provider actions',async t=>{
 const h=await writeHarness(t);const before=h.db.queries;
 const r=await h.call('x_create_original_post',args,claims);assert.equal(r.response.status,401,JSON.stringify(r.body));
 assert.equal(h.db.queries,before);assert.equal(h.state.xCalls.length,0);assert.equal(h.state.idpCalls.length,0);
});

test('valid signature cannot decouple operation, idempotency key, or reply target from body',async t=>{
 const h=await writeHarness(t);
 const wrongKey=await h.call('x_create_original_post',args,{idempotency_key:key(2)});assert.equal(wrongKey.response.status,403);
 const wrongOp=await h.call('x_create_original_post',args,{operation:'x_repost'});assert.equal(wrongOp.response.status,403);
 const reply=await h.call('x_reply',{text:'reply',in_reply_to_post_id:'900',idempotency_key:key(1)},{in_reply_to_post_id:'901'});assert.equal(reply.response.status,403);
 assert.equal(h.state.xCalls.length,0);assert.equal(h.db.all('SELECT * FROM service_writes').length,0);
});

test('expiry, future issue time, TTL, tampered body and origin/query target all fail closed',async t=>{
 const h=await writeHarness(t);
 for(const claims of [{iat:h.clock()-45,exp:h.clock()},{iat:h.clock()+6,exp:h.clock()+51},{exp:h.clock()+44},{exp:h.clock()+46}])
  assert.equal((await h.call('x_create_original_post',args,claims)).response.status,401);
 assert.equal((await h.call('x_create_original_post',args,{}, {sendBody:h.f.body('x_create_original_post',{...args,text:'tamper'})})).response.status,401);
 assert.equal((await h.call('x_create_original_post',args,{}, {headers:{origin:new URL(SERVICE.issuer).origin}})).response.status,403);
 assert.equal((await h.call('x_create_original_post',args,{}, {url:new URL('/service/write/mcp?x=1',SERVICE.audience).href})).response.status,403);
 assert.equal(h.db.all('SELECT * FROM service_writes').length,0);
});

test('strict transport, envelope, args reject legacy names, admin operations and reply/quote/account extras',async t=>{
 const h=await writeHarness(t);await h.seed({scopes:writeScopes});
 for(const name of ['x_create_post','x_reply_to_post','x_delete_post','x_send_dm','x_follow','x_read_posts','admin_poll'])
  assert.equal((await h.call(name,args)).response.status,401);
 for(const extra of [{account_id:'9'},{url:'https://wrong.invalid'},{reply:{in_reply_to_tweet_id:'900'}},{quote_tweet_id:'900'},{media:{media_ids:['900']}},{access_token:'never'}])
  assert.equal((await h.call('x_create_original_post',{...args,...extra})).response.status,400);
 const raw=h.f.body('x_create_original_post',args);
 assert.equal((await h.call('x_create_original_post',args,{}, {raw:raw.replace('"text":','"text":"first","text":')})).response.status,400);
 assert.equal((await h.call('x_create_original_post',args,{}, {headers:{accept:'application/json'}})).response.status,406);
 assert.equal((await h.call('x_create_original_post',args,{}, {headers:{'content-type':'text/plain'}})).response.status,415);
 assert.equal((await h.call('x_create_original_post',args,{}, {headers:{'mcp-protocol-version':'1900'}})).response.status,400);
 assert.equal(h.sends().length,0);
});
