import { runtimeModules } from './helpers.mjs';
import { RUNTIME_NOW } from './clock-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';
import { serviceFixture } from '../test/service-fixtures.mjs';
import { seal } from '../src/security.mjs';
import { ownerContext } from '../src/reads.mjs';
import { runtime } from './helpers.mjs';

async function send(mf,fixture,raw=fixture.body(),proof={},options={}) {
  const request=await fixture.request(raw,proof,options);
  return mf.dispatchFetch(request.url,{method:request.method,headers:request.headers,redirect:'manual',body:await request.arrayBuffer()});
}

test('workerd service: ES256 proof works without DB or secrets, repeated reads allowed, tampering and cache reads fail closed',async t=>{
  const f=await serviceFixture(RUNTIME_NOW);let outbound=0;
  const options=convertV4MiniflareOptions({name:'local-service-check',
    modules:runtimeModules({productionCreditPolicy:true}),
    compatibilityDate:'2026-10-01',host:'127.0.0.1',port:0,cf:false,log:new Log(LogLevel.ERROR),bindings:f.env,
    outboundService:()=>{outbound++;throw new Error('Provider egress prohibited');}});
  options.telemetry={enabled:false};const mf=new Miniflare(options);
  t.after(async()=>{await mf.dispose();assert.equal(outbound,0);});await mf.ready;
  const raw=f.body(),token=await f.token(raw);
  for(let i=0;i<2;i++){
    const res=await send(mf,f,raw,{}, {proof:token});assert.equal(res.status,200);
    assert.deepEqual((await res.json()).result.structuredContent,{linked:false,reconnect_required:false,polling_enabled:false,post_enabled:false,reply_enabled:false});
  }
  assert.equal((await send(mf,f,raw,{}, {proof:token,sendBody:raw+' '})).status,401);
  assert.equal((await send(mf,f,raw,{claims:{exp:f.now-1}})).status,401);
  assert.equal((await send(mf,f,raw,{claims:{sub:'another-site'}})).status,401);
  for(const name of ['x_read_mentions','x_read_posts']){
    const body=await(await send(mf,f,f.body(name))).json();assert.equal(body.result.isError,true);
    assert.equal(body.result.content[0].text,'D1_BINDING_REQUIRED');
  }
  assert.equal((await(await send(mf,f,f.body('x_create_post'))).json()).error.message,'UNKNOWN_OR_DISABLED_TOOL');
});

test('workerd service: local D1 encrypted cache needs exact owner binding and never refreshes expired X tokens',async t=>{
  const f=await serviceFixture(RUNTIME_NOW);
  const h=await runtime(t,{...f.env,X_CLIENT_ID:'',X_CLIENT_SECRET:'',X_CALLBACK_URL:'',LIVE_X_ENABLED:'true',POST_ENABLED:'true',REPLY_ENABLED:'true'});
  const now=RUNTIME_NOW;
  await h.db.prepare('INSERT INTO accounts(id,issuer,subject,x_user_id,encrypted_tokens,expires_at,updated_at) VALUES(?,?,?,?,?,?,?)')
    .bind('primary',h.bindings.MCP_ISSUER,h.bindings.MCP_ALLOWED_SUBJECT,h.bindings.X_EXPECTED_USER_ID,'never-read-or-decrypted',now-100,now).run();
  const payload=await seal(h.bindings.TOKEN_ENCRYPTION_KEY,{records:[{id:'32',text:'cached runtime',seen_at:now}]},ownerContext(h.bindings,'snapshot:posts'));
  await h.db.prepare('INSERT INTO snapshots(kind,encrypted_payload,fetched_at) VALUES(?,?,?)').bind('posts',payload,now).run();
  const body=await(await send(h.mf,f,f.body('x_read_posts'))).json();assert.deepEqual(body.result.structuredContent.records,[{id:'32',text:'cached runtime'}]);
  assert.equal((await(await send(h.mf,f,f.body('x_reply_to_post'))).json()).error.message,'UNKNOWN_OR_DISABLED_TOOL');
  await h.db.prepare("UPDATE accounts SET subject='different-owner' WHERE id='primary'").run();
  for(const name of ['x_connection_status','x_read_posts']){
    const denied=await(await send(h.mf,f,f.body(name))).json();assert.equal(denied.result.isError,true);
    assert.equal(denied.result.content[0].text,'ACCOUNT_NOT_LINKED_OR_BINDING_MISMATCH');
  }
  assert.equal(h.state.calls.length,0);
});

test('workerd service: the configured public key does not bypass the default-off service gate',async t=>{
  const f=await serviceFixture(RUNTIME_NOW);const h=await runtime(t,{...f.env,SERVICE_ENABLED:'false'});
  const res=await send(h.mf,f);assert.equal(res.status,503);assert.equal((await res.json()).error.message,'SERVICE_DISABLED');
  assert.equal(h.state.calls.length,0);
});
