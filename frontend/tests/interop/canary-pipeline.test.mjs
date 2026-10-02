import {OFFLINE_RUNTIME_OPTIONS} from '../offline-runtime.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {initializeFromOwnerClick,b64url} from '../../lib/service-key.mjs';
import {validateConfiguredWriteArguments,CANARY_DEADLINE} from '../../lib/write-contract.mjs';
const backend=fileURLToPath(new URL('../../../backend/',import.meta.url));
const {validateConfiguredWriteArguments:backendValidate}=await import(pathToFileURL(path.join(backend,'src/write-validation.mjs')).href);
const {seal,configuration}=await import(pathToFileURL(path.join(backend,'src/security.mjs')).href);
const {XConnector}=await import(pathToFileURL(path.join(backend,'src/x.mjs')).href);
const {Store}=await import(pathToFileURL(path.join(backend,'src/storage.mjs')).href);
const NOW=Date.parse('2000-01-02T03:00:00Z')/1000;
const INPUT={text:'@test_recipient A single offline cross-runtime canary. 🦋',idempotency_key:'01234567-89ab-4cde-8fab-0123456789ab'};
const hash=async text=>Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))).toString('hex');
const config=async(input=INPUT)=>({X_CANARY_MENTION_HANDLE:'@test_recipient',X_CANARY_MENTION_IDEMPOTENCY_KEY:input.idempotency_key,X_CANARY_MENTION_TEXT_SHA256:await hash(input.text),X_CANARY_MENTION_EXPIRES_AT:String(CANARY_DEADLINE)});

test('independent configured validators agree on exact recipient, intent, text, expiry and denial boundaries',async()=>{
 const env=await config();
 const cases=[[INPUT,env,true],[INPUT,{},false],[INPUT,{...env,X_CANARY_MENTION_HANDLE:'@other'},false],[INPUT,{...env,X_CANARY_MENTION_TEXT_SHA256:'0'.repeat(64)},false],[INPUT,{...env,X_CANARY_MENTION_IDEMPOTENCY_KEY:crypto.randomUUID()},false],[INPUT,{...env,X_CANARY_MENTION_EXPIRES_AT:String(NOW)},false],[INPUT,{...env,X_CANARY_MENTION_EXPIRES_AT:String(CANARY_DEADLINE+1)},false]];
 for(const text of ['@test_recipient2 hello','prefix@test_recipient hello','prefix-@test_recipient hello','https://example.com/@test_recipient','@test_recipient @other','@test_recipient ＠other','@test_recipient e\u0301','@test_recipient \ud800','@test_recipient https://x.com/user/status/123']){const args={...INPUT,text};cases.push([args,await config(args),false]);}
 for(const [args,settings,expected] of cases){const front=await validateConfiguredWriteArguments('x_create_original_post',args,settings,NOW);let back;try{back=await backendValidate('x_create_original_post',args,settings,NOW)}catch{back=null;}assert.equal(front.ok,expected,JSON.stringify(args));assert.equal(!!back,expected,JSON.stringify(args));if(expected)assert.deepEqual(front.args,back);}
});

async function runtime(t){
 let row;const frontDb={prepare(){let values;return {bind(...v){values=v;return this},async run(){const [owner_id,public_jwk,private_jwk,fingerprint,created_at]=values;row={owner_id,public_jwk,private_jwk,fingerprint,created_at}},async first(){return row}}}};
 await initializeFromOwnerClick(frontDb,{id:'canary-runtime-owner'});
 const front=await build({stdin:{contents:`Date.now=()=>${NOW}*1000;import {createWriteAdapter} from './lib/write-service-adapter.mjs';const row=${JSON.stringify(row)};const db={prepare(){return {async first(){return row}}}};export default {async fetch(request,env){const {name,args}=await request.json();const headers=new Headers({'oai-authenticated-user-id':'canary-runtime-owner','oai-authenticated-user-email':'owner@example.invalid'});return Response.json(await createWriteAdapter({db,env}).call(headers,name,args))}}`,resolveDir:process.cwd(),sourcefile:'canary-front.mjs'},bundle:true,format:'esm',platform:'browser',write:false});
 const back=await build({stdin:{contents:`import {createWorker} from ${JSON.stringify(path.join(backend,'src/worker.mjs'))};export default createWorker({clock:()=>${NOW}});`,resolveDir:process.cwd(),sourcefile:'canary-back.mjs'},bundle:true,format:'esm',platform:'browser',write:false});
 const directory=await mkdtemp(path.join(tmpdir(),'canary-interop-'));let mf;let initialized=false;const state={xCalls:0,frontCalls:0,ambiguous:false};
 t.after(async()=>{await mf?.dispose();await rm(directory,{recursive:true,force:true})});
 const base={PUBLIC_BASE_URL:'https://backend.example.invalid',SERVICE_ENABLED:'true',SERVICE_WRITE_ENABLED:'true',SERVICE_PUBLIC_JWK:row.public_jwk,SERVICE_X_ACCOUNT_ID:'4242',X_EXPECTED_USER_ID:'4242',MCP_ISSUER:'https://identity.example.invalid',MCP_DISCOVERY_URL:'https://identity.example.invalid/.well-known/oauth-authorization-server',MCP_INTROSPECTION_URL:'https://identity.example.invalid/introspect',MCP_INTROSPECTION_CLIENT_ID:'mock-only-client',MCP_INTROSPECTION_CLIENT_SECRET:'mock-only-secret',MCP_ALLOWED_SUBJECT:'mock-only-owner',X_CLIENT_ID:'mock-only-x-client',X_CLIENT_SECRET:'mock-only-x-secret',X_CALLBACK_URL:'https://backend.example.invalid/x/callback',TOKEN_ENCRYPTION_KEY:b64url(new Uint8Array(32).fill(6)),LIVE_X_ENABLED:'true',LIVE_IDP_ENABLED:'false',POST_ENABLED:'true',X_ORIGINAL_POSTS_ENABLED:'true',X_WRITE_STATUS_ENABLED:'true',MAX_WRITES_DAY:'10',MAX_X_REQUESTS_HOUR:'20',MAX_X_REQUESTS_DAY:'100',X_CREDIT_BUDGET_ID:'example-disabled-budget',X_CREDIT_CAP_MICROUSD:'5000000',X_CREDIT_INITIAL_MICROUSD:'0',X_CREDIT_EXPIRES_AT:String(CANARY_DEADLINE)};
 const start=async(frontConfig,backConfig=frontConfig)=>{
  await mf?.dispose();
  const env={...base,...backConfig};
  mf=new Miniflare({...OFFLINE_RUNTIME_OPTIONS,d1Persist:directory,workers:[{name:'frontend',modules:true,script:front.outputFiles[0].text,compatibilityDate:'2026-05-15',bindings:{X_ORIGINAL_POSTS_ENABLED:'true',X_WRITE_STATUS_ENABLED:'true',...frontConfig},outboundService:async request=>{state.frontCalls++;assert.equal(request.url,base.PUBLIC_BASE_URL+'/service/write/mcp');assert.equal(request.headers.get('accept'),'application/json, text/event-stream');return (await mf.getWorker('backend')).fetch(request)}},{name:'backend',modules:true,script:back.outputFiles[0].text,compatibilityDate:'2026-05-15',bindings:env,d1Databases:{DB:'canary-interop-database'},outboundService:async request=>{state.xCalls++;assert.equal(request.url,'https://api.x.com/2/tweets');assert.equal(request.method,'POST');assert.deepEqual(await request.json(),{text:INPUT.text});if(state.ambiguous)return new Response('Mock ambiguous X result',{status:503});return Response.json({data:{id:'9007199254740993'}},{status:201})}}]});
  if(!initialized){
   const db=await mf.getD1Database('DB','backend');for(const file of(await readdir(path.join(backend,'migrations'))).filter(f=>f.endsWith('.sql')).sort()){const sql=await readFile(path.join(backend,'migrations',file),'utf8');for(const statement of sql.replace(/--[^\n]*/g,'').split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(statement).run();}
   const store=new Store(db,()=>NOW);const x=new XConnector(env,configuration(env),store,()=>{throw Error('No egress during seed')},()=>NOW);
   await store.saveAccount(env.MCP_ISSUER,env.MCP_ALLOWED_SUBJECT,'4242',await seal(env.TOKEN_ENCRYPTION_KEY,{access_token:'mock-only-access',refresh_token:'mock-only-refresh',scopes:['tweet.read','users.read','offline.access','tweet.write']},x.context()),NOW+7200);initialized=true;
  }
 };
 const call=async(name,args)=>{const response=await mf.dispatchFetch('https://frontend.invalid',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name,args})});return response.json()};
 return {state,start,call};
}

for(const ambiguous of [false,true])test(`actual dual-workerd canary ${ambiguous?'unknown':'success'} is durable across restart and cannot obtain a second allowance by operator reconfiguration`,async t=>{
 const h=await runtime(t);const settings=await config();await h.start(settings);h.state.ambiguous=ambiguous;
 const sent=await h.call('x_create_original_post',INPUT);assert.equal(sent.value.state,ambiguous?'unknown':'succeeded',JSON.stringify(sent));assert.equal(sent.safe_to_retry,false);assert.equal(h.state.xCalls,1);
 await h.start(settings);const again=await h.call('x_create_original_post',INPUT);assert.equal(again.value.state,sent.value.state);assert.equal(h.state.xCalls,1);
 const status=await h.call('x_get_write_status',{idempotency_key:INPUT.idempotency_key});assert.equal(status.value.state,sent.value.state);assert.equal(h.state.xCalls,1);
 // Even an operator changing the signed intent cannot make the one-time backend singleton reusable.
 const second={text:'@other_recipient An entirely different mocked canary intent.',idempotency_key:crypto.randomUUID()};await h.start({...await config(second),X_CANARY_MENTION_HANDLE:'@other_recipient'});const blocked=await h.call('x_create_original_post',second);assert.equal(blocked.ok,false);assert.equal(blocked.value.state,'unknown',JSON.stringify(blocked));assert.equal(blocked.safe_to_retry,false);assert.equal(h.state.xCalls,1);
 // The second key has no durable intent receipt because rejection precedes insertion.
 assert.equal((await h.call('x_get_write_status',{idempotency_key:second.idempotency_key})).value.state,'not_found');assert.equal(h.state.xCalls,1);
 await h.start(settings);assert.equal((await h.call('x_get_write_status',{idempotency_key:INPUT.idempotency_key})).value.state,sent.value.state);assert.equal(h.state.xCalls,1);
});

test('actual backend independently rejects a configured frontend when its own canary binding differs or is missing',async t=>{
 const h=await runtime(t);const settings=await config();
 for(const changes of [null,{X_CANARY_MENTION_HANDLE:'@other'},{X_CANARY_MENTION_IDEMPOTENCY_KEY:crypto.randomUUID()},{X_CANARY_MENTION_TEXT_SHA256:'0'.repeat(64)},{X_CANARY_MENTION_EXPIRES_AT:String(NOW)}]){await h.start(settings,changes===null?{}:{...settings,...changes});const result=await h.call('x_create_original_post',INPUT);assert.equal(result.ok,false,JSON.stringify(changes));assert.equal(result.safe_to_retry,false);assert.equal(h.state.xCalls,0);}
 assert.equal(h.state.frontCalls,5);
});
