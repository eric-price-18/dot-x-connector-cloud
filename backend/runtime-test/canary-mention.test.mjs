import { RUNTIME_NOW } from './clock-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime,json } from './helpers.mjs';
import { writeFixture,key,writeScopes } from '../test/write-fixtures.mjs';
import { seal } from '../src/security.mjs';
import { canaryArgs,canaryConfig as historicalCanaryConfig,canaryText } from '../test/canary-fixtures.mjs';
import { ownerContext } from '../src/reads.mjs';
import { CREDIT_RUN_DEADLINE } from './credit-fixture.mjs';
// Synthetic canary deadline matches only the intercepted test runtime policy.
const canaryConfig=(...args)=>({...historicalCanaryConfig(...args),X_CANARY_MENTION_EXPIRES_AT:String(CREDIT_RUN_DEADLINE)});

async function setup(t,changes={},faults={}) {
 const f=await writeFixture(RUNTIME_NOW);
 const h=await runtime(t,{...f.env,X_CALLBACK_URL:new URL(f.env.PUBLIC_BASE_URL).origin+'/x/callback',...canaryConfig(),...changes},faults);
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

test('workerd canary: exact approved intent uses one durable slot and survives restart',async t=>{
 const h=await setup(t);const first=await h.call('x_create_original_post',canaryArgs());
 assert.equal(first.receipt.state,'succeeded',JSON.stringify(first.body));assert.equal(h.sends().length,1);
 assert.deepEqual(JSON.parse(h.sends()[0].body),{text:canaryText});
 await h.restart();assert.deepEqual((await h.call('x_create_original_post',canaryArgs())).receipt,first.receipt);
 Object.assign(h.bindings,canaryConfig(canaryText,81));await h.restart();
 assert.equal((await h.call('x_create_original_post',canaryArgs(canaryText,81))).body.result.content[0].text,'CANARY_MENTION_ALREADY_RESERVED');
 assert.equal(h.sends().length,1);assert.equal((await h.db.prepare('SELECT * FROM canary_mention').all()).results.length,1);
});
test('workerd canary: concurrent claims and restart keep at most one mutation',async t=>{
 const h=await setup(t);
 const result=await Promise.all(Array.from({length:12},()=>h.call('x_create_original_post',canaryArgs())));
 assert(result.some(v=>v.receipt?.state==='succeeded'));assert.equal(h.sends().length,1);
 await h.restart();assert.equal((await h.status(key(80))).receipt.state,'succeeded');assert.equal(h.sends().length,1);
});
test('workerd canary: unknown dispatch cannot be retried or changed after restart',async t=>{
 const h=await setup(t);h.state.onX=call=>call.url.pathname==='/2/tweets'?json({},201):undefined;
 assert.equal((await h.call('x_create_original_post',canaryArgs())).receipt.state,'unknown');await h.restart();h.state.onX=null;
 assert.equal((await h.call('x_create_original_post',canaryArgs())).receipt.state,'unknown');
 Object.assign(h.bindings,canaryConfig('@new_person Another message',82,'@new_person'));await h.restart();
 assert((await h.call('x_create_original_post',canaryArgs('@new_person Another message',82))).body.result.isError);
 assert.equal(h.sends().length,1);
});
test('workerd canary: failed intent insertion leaves singleton after restart and no new key',async t=>{
 const h=await setup(t);
 await h.db.prepare("CREATE TRIGGER fail_intent BEFORE INSERT ON service_writes BEGIN SELECT RAISE(ABORT,'mock intent failure'); END").run();
 assert((await h.call('x_create_original_post',canaryArgs())).body.result.isError);assert.equal(h.sends().length,0);
 assert.equal((await h.db.prepare('SELECT * FROM canary_mention').all()).results.length,1);
 await h.db.prepare('DROP TRIGGER fail_intent').run();await h.restart();
 Object.assign(h.bindings,canaryConfig(canaryText,81));await h.restart();
 assert((await h.call('x_create_original_post',canaryArgs(canaryText,81))).body.result.isError);assert.equal(h.sends().length,0);
 Object.assign(h.bindings,canaryConfig());await h.restart();
 assert.equal((await h.call('x_create_original_post',canaryArgs())).receipt.state,'succeeded');assert.equal(h.sends().length,1);
});
test('workerd canary: expired exception denies mutations but status remains zero-egress',async t=>{
 const h=await setup(t);await h.call('x_create_original_post',canaryArgs());
 h.bindings.X_CANARY_MENTION_EXPIRES_AT=String(RUNTIME_NOW-1);await h.restart();
 assert.equal((await h.call('x_create_original_post',canaryArgs())).response.status,403);
 assert.equal((await h.status(key(80))).receipt.state,'succeeded');assert.equal(h.sends().length,1);
});
test('workerd canary: missing migration or denied first slot insert fails before all X egress',async t=>{
 const h=await setup(t);
 await h.db.prepare("CREATE TRIGGER fail_canary BEFORE INSERT ON canary_mention BEGIN SELECT RAISE(ABORT,'mock slot failure'); END").run();
 assert((await h.call('x_create_original_post',canaryArgs())).body.result.isError);
 assert.equal((await h.db.prepare('SELECT * FROM service_writes').all()).results.length,0);assert.equal(h.xCalls().length,0);
 await h.db.prepare('DROP TABLE canary_mention').run();
 assert((await h.call('x_create_original_post',canaryArgs())).body.result.isError);assert.equal(h.xCalls().length,0);
});

test('workerd canary: committed slot acknowledgment loss blocks egress and survives restart',async t=>{
 const h=await setup(t,{}, {canarySlotAckLoss:true});
 assert((await h.call('x_create_original_post',canaryArgs())).body.result.isError);assert.equal(h.xCalls().length,0);
 assert.equal((await h.db.prepare('SELECT * FROM canary_mention').all()).results.length,1);
 assert.equal((await h.db.prepare('SELECT * FROM service_writes').all()).results.length,0);
 Object.assign(h.bindings,canaryConfig(canaryText,81));await h.restart();
 assert((await h.call('x_create_original_post',canaryArgs(canaryText,81))).body.result.isError);assert.equal(h.xCalls().length,0);
 Object.assign(h.bindings,canaryConfig());await h.restart();
 assert.equal((await h.call('x_create_original_post',canaryArgs())).receipt.state,'succeeded');assert.equal(h.sends().length,1);
});

test('workerd canary: two concurrently valid operator configurations share the fixed singleton',async t=>{
 const h=await setup(t,{}, {canaryConfigurationRace:true});
 const result=await Promise.all([
  h.call('x_create_original_post',canaryArgs()),
  h.call('x_create_original_post',canaryArgs(canaryText,81),{}, {headers:{'x-test-canary-key':key(81)}})
 ]);
 assert.equal(result.filter(v=>v.receipt?.state==='succeeded').length,1);assert.equal(h.sends().length,1);
 assert.equal((await h.db.prepare('SELECT * FROM canary_mention').all()).results.length,1);
});


test('workerd canary: unmodified production policy refuses runtime fixture authorization with zero X egress',async t=>{
 const h=await setup(t,{}, {productionCreditPolicy:true});
 const result=await h.call('x_create_original_post',canaryArgs());
 assert.equal(result.response.status,403);
 assert.equal(result.body.error.message,'CANARY_MENTION_NOT_CONFIGURED');
 assert.equal(h.xCalls().length,0);
 assert.equal((await h.db.prepare('SELECT * FROM canary_mention').all()).results.length,0);
});
