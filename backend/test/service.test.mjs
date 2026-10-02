import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createWorker } from '../src/worker.mjs';
import { createServiceVerifier, SERVICE } from '../src/service.mjs';
import { cachedRead, readTool } from '../src/reads.mjs';
import { seal, b64url } from '../src/security.mjs';
import { harness, accidentalNetwork, rejectsCode } from './helpers.mjs';
import { serviceFixture } from './service-fixtures.mjs';

const fixture=await serviceFixture();
const logs=[];
const worker=createWorker({clock:()=>fixture.now,logger:line=>logs.push(line)});
const run=async(raw=fixture.body(),proof={},options={},env=fixture.env)=>worker.fetch(await fixture.request(raw,proof,options),env);

test('shared public interoperability fixture verifies at its recorded test clock only',async()=>{
  const vector=JSON.parse(readFileSync(new URL('./service-interoperability.json',import.meta.url),'utf8'));
  const env={...fixture.env,SERVICE_PUBLIC_JWK:JSON.stringify(vector.public_jwk)};
  const request=()=>new Request(vector.url,{method:vector.method,headers:{...vector.headers,Authorization:`Bearer ${vector.proof}`},body:vector.body});
  const local=createWorker({clock:()=>vector.validation_time,logger:()=>{}});
  const response=await local.fetch(request(),env);assert.equal(response.status,vector.expected_status);
  assert.deepEqual(await response.json(),vector.expected_body);
  assert.equal((await worker.fetch(request(),env)).status,401);
});

test('second synthetic interoperability fixture verifies generic trust pins and no-DB status',async()=>{
  const vector=JSON.parse(readFileSync(new URL('./service-frontend-fixture.json',import.meta.url),'utf8'));
  const env={...fixture.env,SERVICE_PUBLIC_JWK:JSON.stringify(vector.public_jwk)};
  const local=createWorker({clock:()=>vector.now,logger:()=>{}});
  const request=()=>new Request(SERVICE.audience,{method:'POST',headers:{'content-type':'application/json',
    accept:'application/json, text/event-stream',authorization:`Bearer ${vector.token}`},body:vector.body});
  const response=await local.fetch(request(),env);assert.equal(response.status,200);
  assert.deepEqual((await response.json()).result.structuredContent,{linked:false,reconnect_required:false,polling_enabled:false,post_enabled:false,reply_enabled:false});
  assert.equal((await worker.fetch(request(),env)).status,401);
});

test('service ES256 proof returns unlinked status without DB, X credentials, owner identity or IdP calls',async()=>{
  const res=await run();assert.equal(res.status,200);
  const body=await res.json();assert.deepEqual(body.result.structuredContent,{linked:false,reconnect_required:false,polling_enabled:false,post_enabled:false,reply_enabled:false});
  assert.deepEqual(JSON.parse(body.result.content[0].text),body.result.structuredContent);
  assert.deepEqual(accidentalNetwork,[]);
});
test('service missing flag and missing public key fail closed',async()=>{
  for(const changes of [{SERVICE_ENABLED:'false'},{SERVICE_ENABLED:undefined},{SERVICE_PUBLIC_JWK:undefined}])
    assert.equal((await run(undefined,{}, {},{...fixture.env,...changes})).status,503);
});
for(const [name,claims] of [
  ['issuer',{iss:'https://other.invalid'}],['subject',{sub:'another-service'}],['audience',{aud:'https://api.x.com'}],
  ['array audience',{aud:[SERVICE.audience]}],['scope escalation',{scope:'x:read x:post'}],['scope array',{scope:['x:read']}],
  ['expired',{exp:fixture.now}],['future iat',{iat:fixture.now+6}],['fractional iat',{iat:fixture.now+.5}],
  ['oversized lifetime',{exp:fixture.now+61}],['zero lifetime',{exp:fixture.now}],['unknown claim',{extra:true}],
  ['HTTP method',{method:'GET'}],['HTTP path',{path:'/mcp'}],['body hash',{body_sha256:b64url(new Uint8Array(32))}],
  ['invalid UUID',{jti:'not-a-uuid'}]
])test(`service rejects signed proof with wrong ${name}`,async()=>assert.equal((await run(undefined,{claims})).status,401));
for(const [name,header] of [['algorithm',{alg:'HS256'}],['type',{typ:'at+jwt'}],['key ID',{kid:'other'}],
  ['remote key',{jku:'https://attacker.invalid/jwks'}],['embedded key',{jwk:fixture.jwk}],['critical header',{crit:[]}],['extra header',{extra:true}]])
  test(`service rejects ${name} header`,async()=>assert.equal((await run(undefined,{header})).status,401));
test('service rejects duplicate JWT members and noncompact ambiguous JSON',async()=>{
  const raw=fixture.body(),good=await fixture.token(raw),parts=good.split('.');
  const header=Buffer.from(parts[0],'base64url').toString(),claims=Buffer.from(parts[1],'base64url').toString();
  for(const proof of [{rawHeader:header.replace('{','{"alg":"none",')},{rawClaims:claims.replace('{','{"scope":"x:post",')},{rawHeader:' '+header}])
    assert.equal((await run(raw,proof)).status,401);
});
test('service rejects wrong signing key, malformed bearer, altered and DER-sized signatures',async()=>{
  const other=await serviceFixture(fixture.now),raw=fixture.body();
  assert.equal((await run(raw,{}, {proof:await other.token(raw,{header:{kid:fixture.kid}})})).status,401);
  const token=await fixture.token(raw),parts=token.split('.');
  for(const proof of ['not-a-token',`${parts[0]}.${parts[1]}.${b64url(new Uint8Array(64))}`,`${parts[0]}.${parts[1]}.${b64url(new Uint8Array(70))}`])
    assert.equal((await run(raw,{}, {proof})).status,401);
});
test('service rejects unsafe, private or mismatched trusted JWK configuration',async()=>{
  for(const jwk of [{...fixture.jwk,d:'forbidden-private-field'},{...fixture.jwk,crv:'P-384'},{...fixture.jwk,kid:'incorrect'},
    {...fixture.jwk,alg:'HS256'},{...fixture.jwk,key_ops:['sign']},{...fixture.jwk,x:'AA'},{...fixture.jwk,use:'enc'}])
    assert.equal((await run(undefined,{}, {},{...fixture.env,SERVICE_PUBLIC_JWK:JSON.stringify(jwk)})).status,503);
});
test('service binds exact UTF8 body bytes including whitespace and rejects invalid UTF8',async()=>{
  const raw=fixture.body(),proof=await fixture.token(raw);
  assert.equal((await run(raw,{}, {proof,sendBody:raw+' '})).status,401);
  const invalid=new Uint8Array([255]);
  const hash=b64url(await crypto.subtle.digest('SHA-256',invalid));
  const token=await fixture.token('',{claims:{body_sha256:hash}});
  assert.equal((await run('',{}, {proof:token,sendBody:invalid})).status,400);
});
test('service enforces canonical URL, no query, POST and server-only origin',async()=>{
  for(const options of [{url:SERVICE.audience+'?query=1'},{url:SERVICE.audience.replace('backend.example.invalid','other.example.invalid')},
    {headers:{origin:SERVICE.issuer}}])assert.equal((await run(undefined,{},options)).status,403);
  assert.equal((await run(undefined,{}, {method:'GET'})).status,405);
});
test('service read allowlist cannot expand even with write flags on; empty args are mandatory',async()=>{
  const env={...fixture.env,POST_ENABLED:'true',REPLY_ENABLED:'true'};
  for(const name of ['x_create_post','x_reply_to_post','poll','x_connect','fetch']){
    const res=await run(fixture.body(name),{}, {},env);assert.equal((await res.json()).error.message,'UNKNOWN_OR_DISABLED_TOOL');
  }
  for(const args of [{account:'other'},[],null,{url:'https://attacker.invalid'}])
    assert.equal((await run(fixture.body('x_connection_status',args))).status,400);
  for(const method of ['initialize','tools/list','admin/poll']){
    const raw=JSON.stringify({jsonrpc:'2.0',id:1,method,params:{}});
    assert.equal((await(await run(raw)).json()).error.message,'METHOD_NOT_FOUND');
  }
});
test('service missing cache storage is explicit and does not return invented empty data',async()=>{
  for(const name of ['x_read_mentions','x_read_posts']){
    const body=await(await run(fixture.body(name))).json();assert.equal(body.result.isError,true);
    assert.equal(body.result.content[0].text,'D1_BINDING_REQUIRED');assert.equal(body.result.structuredContent,undefined);
  }
  const bad={...fixture.env,DB:{}};assert.equal((await(await run(undefined,{}, {},bad)).json()).result.isError,true);
});
test('service exact-request replay is allowed only within expiry; verifier rechecks time after signature',async()=>{
  let now=fixture.now;
  const fresh=createWorker({clock:()=>now,logger:()=>{}}),raw=fixture.body(),proof=await fixture.token(raw);
  for(let i=0;i<2;i++)assert.equal((await fresh.fetch(await fixture.request(raw,{}, {proof}),fixture.env)).status,200);
  now+=45;assert.equal((await fresh.fetch(await fixture.request(raw,{}, {proof}),fixture.env)).status,401);
  let reads=0;const verify=createServiceVerifier(()=>++reads>2?fixture.now+46:fixture.now);
  await rejectsCode(verify(await fixture.request(raw,{}, {proof}),fixture.env,new TextEncoder().encode(raw)),'SERVICE_PROOF_INVALID');
});
test('service clock permits at most five seconds future iat and max sixty second lifetime',async()=>{
  assert.equal((await run(undefined,{claims:{iat:fixture.now+5,exp:fixture.now+50}})).status,200);
  assert.equal((await run(undefined,{claims:{exp:fixture.now+60}})).status,200);
});
test('read-only cache preserves encrypted context and validates every stored account binding',async t=>{
  const h=harness(t);await h.seed({expires:h.state.now-100});
  await h.store.run('INSERT INTO snapshots(kind,encrypted_payload,fetched_at) VALUES(?,?,?)','mentions',
    await seal(h.env.TOKEN_ENCRYPTION_KEY,{records:[{id:'12',text:'cached only',seen_at:h.state.now}]},h.x.context('snapshot:mentions')),h.state.now);
  const env={...h.env,...fixture.env,DB:h.db};
  delete env.X_CLIENT_SECRET;delete env.X_CLIENT_ID;delete env.X_CALLBACK_URL;
  const custom=createWorker({clock:h.clock,logger:()=>{}}),f=await serviceFixture(h.state.now);
  env.SERVICE_PUBLIC_JWK=JSON.stringify(f.jwk);
  const res=await custom.fetch(await f.request(f.body('x_read_mentions')),env);
  assert.deepEqual((await res.json()).result.structuredContent.records,[{id:'12',text:'cached only'}]);
  for(const changes of [{MCP_ALLOWED_SUBJECT:'wrong'},{X_EXPECTED_USER_ID:'555'},{MCP_ISSUER:'https://other.invalid'},{MCP_ALLOWED_SUBJECT:undefined}]){
    await assert.rejects(readTool('x_connection_status',{...env,...changes},h.clock));
    await assert.rejects(readTool('x_read_mentions',{...env,...changes},h.clock));
  }
  assert.equal(h.state.xCalls.length+h.state.idpCalls.length,0);
  await assert.rejects(cachedRead(env,h.store,h.clock,'account'));
});
test('service proofs do not authenticate human MCP, X linking, owner or admin routes',async t=>{
  const h=harness(t);const env={...h.env,...fixture.env};const raw=fixture.body();
  for(const path of ['/mcp','/x/connect','/admin/poll','/owner/login','/x/callback']){
    const request=await fixture.request(raw,{}, {url:new URL(path,SERVICE.audience).href});
    const res=await h.worker.fetch(request,env);assert(res.status>=400);
  }
  assert.equal(h.state.xCalls.length,0);
});
test('service request limits and errors never disclose credentials or request contents',async()=>{
  assert.equal((await run('x'.repeat(17000))).status,413);
  const raw=fixture.body(),proof=await fixture.token(raw);
  await run(raw,{}, {proof,sendBody:raw+' '});
  assert(!logs.join('').includes(proof));assert(!logs.join('').includes(raw));
  assert.deepEqual(accidentalNetwork,[]);
});
