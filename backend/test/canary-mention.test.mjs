import test from 'node:test';
import assert from 'node:assert/strict';
import { writeHarness,key,writeScopes } from './write-fixtures.mjs';
import { canaryArgs,canaryConfig,canaryText } from './canary-fixtures.mjs';
import { validateConfiguredWriteArguments,validateWriteArguments } from '../src/write-validation.mjs';
import { response } from './helpers.mjs';
import { CREDIT_RUN_DEADLINE } from '../src/credit-policy.mjs';
const now=CREDIT_RUN_DEADLINE-28000;
const validate=(args=canaryArgs(),env=canaryConfig(),operation='x_create_original_post',time=now)=>
 validateConfiguredWriteArguments(operation,args,env,time);

test('canary exact operator intent is accepted but generic validator and missing config stay closed',async()=>{
 assert.deepEqual(await validate(),canaryArgs());
 assert.throws(()=>validateWriteArguments('x_create_original_post',canaryArgs()),{code:'MENTIONS_NOT_SUPPORTED'});
 await assert.rejects(validate(canaryArgs(),{}),{code:'CANARY_MENTION_NOT_CONFIGURED'});
 assert.deepEqual(await validate({text:'No mention',idempotency_key:key(1)},{X_CANARY_MENTION_HANDLE:'bad'}),{text:'No mention',idempotency_key:key(1)});
});
for(const [field,value] of [
 ['X_CANARY_MENTION_HANDLE','fixture_friend'],['X_CANARY_MENTION_HANDLE','@Fixture_friend'],['X_CANARY_MENTION_HANDLE','@a @b'],
 ['X_CANARY_MENTION_IDEMPOTENCY_KEY','not-a-uuid'],['X_CANARY_MENTION_IDEMPOTENCY_KEY',key(81)],
 ['X_CANARY_MENTION_TEXT_SHA256','A'.repeat(64)],['X_CANARY_MENTION_TEXT_SHA256','0'.repeat(64)],
 ['X_CANARY_MENTION_EXPIRES_AT',String(CREDIT_RUN_DEADLINE+1)],['X_CANARY_MENTION_EXPIRES_AT','0'+String(CREDIT_RUN_DEADLINE)],
 ['X_CANARY_MENTION_EXPIRES_AT',CREDIT_RUN_DEADLINE],['X_CANARY_MENTION_EXPIRES_AT',String(now)],['X_CANARY_MENTION_EXPIRES_AT','']
])test(`canary rejects malformed, mismatched or expired ${field} ${value}`,async()=>{
 await assert.rejects(validate(canaryArgs(),{...canaryConfig(),[field]:value}));
});
for(const text of [
 '@fixture_friend2 wrong target','@fixture_friend_other wrong target','mail@fixture_friend test',
 'https://example.invalid/@fixture_friend','@fixture_friend @someone_else','＠fixture_friend fullwidth',
 '@fixture_friend @fixture_friend','@Fixture_friend wrong case','@fixture_friend2 @fixture_friend',
 '@fixture_friend '+ '字'.repeat(141),'@fixture_friend e\u0301','@fixture_friend \ud800',
 '@fixture_friend https://x.com/a/status/123','@fixture_friend https://t.co/abcd'
])test('canary cannot bypass exact mention or general text guard: '+JSON.stringify(text.slice(0,70)),async()=>{
 await assert.rejects(validate(canaryArgs(text),canaryConfig(text)));
});
test('canary does not authorize replies, extra fields or proof/key substitution',async t=>{
 await assert.rejects(validate({...canaryArgs(),in_reply_to_post_id:'100'},canaryConfig(),'x_reply'));
 await assert.rejects(validate({...canaryArgs(),account_id:'4242'}));
 const h=await writeHarness(t,canaryConfig());await h.seed({scopes:writeScopes});
 assert.equal((await h.call('x_create_original_post',canaryArgs(),{idempotency_key:key(81)})).response.status,403);
 await assert.rejects(h.x.send('post',canaryArgs()),{code:'MENTIONS_NOT_SUPPORTED'});
 assert.equal(h.sends().length,0);assert.equal(h.db.all('SELECT * FROM canary_mention').length,0);
});
test('one canary succeeds once with durable receipt; configuration rotation cannot authorize another',async t=>{
 const h=await writeHarness(t,canaryConfig());await h.seed({scopes:writeScopes});
 const r=await h.call('x_create_original_post',canaryArgs());assert.equal(r.receipt.state,'succeeded');
 assert.deepEqual((await h.call('x_create_original_post',canaryArgs())).receipt,r.receipt);
 assert.deepEqual(JSON.parse(h.sends()[0].options.body),{text:canaryText});
 for(const [text,n,handle] of [[canaryText,81,'@fixture_friend'],['@new_person Different',82,'@new_person']]) {
  Object.assign(h.env,canaryConfig(text,n,handle));
  assert.equal((await h.call('x_create_original_post',canaryArgs(text,n))).body.result.content[0].text,'CANARY_MENTION_ALREADY_RESERVED');
 }
 assert.equal(h.sends().length,1);assert.equal(h.db.all('SELECT * FROM canary_mention').length,1);
 assert(!JSON.stringify(h.db.all('SELECT * FROM canary_mention')).includes(canaryText));
 h.state.now=CREDIT_RUN_DEADLINE;
 assert.equal((await h.status(key(80),{iat:h.clock(),exp:h.clock()+45})).receipt.state,'succeeded');
 assert.equal(h.sends().length,1);
});
test('canary concurrent same key and alternate configured keys can dispatch at most once',async t=>{
 const h=await writeHarness(t,canaryConfig());await h.seed({scopes:writeScopes});
 const replies=await Promise.all(Array.from({length:16},()=>h.call('x_create_original_post',canaryArgs())));
 assert(replies.some(v=>v.receipt?.state==='succeeded'));assert.equal(h.sends().length,1);
});
test('canary refuses a UUID already used for a normal intent, before refresh or paid egress',async t=>{
 const h=await writeHarness(t,canaryConfig());await h.seed({scopes:writeScopes});
 await h.call('x_create_original_post',{text:'Prior ordinary post',idempotency_key:key(80)});
 assert.equal((await h.call('x_create_original_post',canaryArgs())).body.result.content[0].text,'CANARY_MENTION_ALREADY_RESERVED');
 assert.equal(h.sends().length,1);assert.equal(h.db.all('SELECT * FROM canary_mention').length,0);
});
test('canary timeout remains unknown and cannot be reset through changed operator key',async t=>{
 const h=await writeHarness(t,canaryConfig());await h.seed({scopes:writeScopes});h.state.onX=()=>{throw Error('timeout');};
 assert.equal((await h.call('x_create_original_post',canaryArgs())).receipt.state,'unknown');h.state.onX=null;
 assert.equal((await h.call('x_create_original_post',canaryArgs())).receipt.state,'unknown');
 Object.assign(h.env,canaryConfig(canaryText,81));
 assert((await h.call('x_create_original_post',canaryArgs(canaryText,81))).body.result.isError);assert.equal(h.sends().length,1);
});
test('slot acknowledgment loss and pre-intent crash preserve immutable slot without initial egress',async t=>{
 const h=await writeHarness(t,canaryConfig());await h.seed({scopes:writeScopes});
 const prepare=h.db.prepare.bind(h.db);let lose=true;
 h.db.prepare=sql=>{const statement=prepare(sql),first=statement.first;statement.first=async function(){const result=await first.call(this);
  if(lose&&sql.startsWith('INSERT INTO canary_mention')){lose=false;throw Error('lost slot acknowledgment');}return result;};return statement;};
 assert((await h.call('x_create_original_post',canaryArgs())).body.result.isError);assert.equal(h.sends().length,0);
 assert.equal(h.db.all('SELECT * FROM canary_mention').length,1);assert.equal(h.db.all('SELECT * FROM service_writes').length,0);
 Object.assign(h.env,canaryConfig(canaryText,81));
 assert((await h.call('x_create_original_post',canaryArgs(canaryText,81))).body.result.isError);assert.equal(h.sends().length,0);
 Object.assign(h.env,canaryConfig());
 assert.equal((await h.call('x_create_original_post',canaryArgs())).receipt.state,'succeeded');assert.equal(h.sends().length,1);
});
test('expiry between reservation and dispatch rejects without sending, and never frees slot',async t=>{
 const h=await writeHarness(t,canaryConfig());await h.seed({scopes:writeScopes});
 const prepare=h.db.prepare.bind(h.db);
 h.db.prepare=sql=>{const statement=prepare(sql),first=statement.first;statement.first=async function(){const result=await first.call(this);
  if(sql.includes('INSERT INTO budgets')&&sql.includes('RETURNING'))h.state.now=CREDIT_RUN_DEADLINE;return result;};return statement;};
 const result=await h.call('x_create_original_post',canaryArgs());assert.equal(result.receipt.state,'rejected');assert.equal(h.sends().length,0);
 assert.equal(h.db.all('SELECT * FROM canary_mention').length,1);
});
test('concurrent distinct operator configurations cannot claim two slots',async t=>{
 const h=await writeHarness(t,canaryConfig());await h.seed({scopes:writeScopes});
 const first=h.call('x_create_original_post',canaryArgs());
 const second=h.worker.fetch(await h.f.request('x_create_original_post',canaryArgs(canaryText,81)),
  {...h.env,...canaryConfig(canaryText,81)}).then(r=>r.json());
 const result=await Promise.all([first,second]);assert.equal(h.sends().length,1);
 assert.equal(h.db.all('SELECT * FROM canary_mention').length,1);
});
test('global canary slot cannot be reused under a changed account or owner binding',async t=>{
 const h=await writeHarness(t,canaryConfig());await h.seed({scopes:writeScopes});await h.call('x_create_original_post',canaryArgs());
 for(const changes of [{SERVICE_X_ACCOUNT_ID:'7777',X_EXPECTED_USER_ID:'7777'},
  {MCP_ALLOWED_SUBJECT:'another-owner'},{MCP_ISSUER:'https://another-owner.invalid'}]) {
  const r=await h.worker.fetch(await h.f.request('x_create_original_post',canaryArgs()),{...h.env,...changes});
  assert.equal((await r.json()).result.content[0].text,'CANARY_MENTION_ALREADY_RESERVED');
 }
 assert.equal(h.sends().length,1);
});
test('canary denied budget consumes singleton and does not grant a second mention under a new key',async t=>{
 const h=await writeHarness(t,{...canaryConfig(),MAX_WRITES_DAY:'0'});await h.seed({scopes:writeScopes});
 assert.equal((await h.call('x_create_original_post',canaryArgs())).receipt.state,'rejected');assert.equal(h.sends().length,0);
 Object.assign(h.env,canaryConfig(canaryText,81),{MAX_WRITES_DAY:'10'});
 assert((await h.call('x_create_original_post',canaryArgs(canaryText,81))).body.result.isError);assert.equal(h.sends().length,0);
});


test('public canary policy rejects complete synthetic configuration at the real clock',async()=>{
 await assert.rejects(validate(canaryArgs(),canaryConfig(),'x_create_original_post',Math.floor(Date.now()/1000)),{code:'CANARY_MENTION_EXPIRED'});
});
