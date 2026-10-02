import {OFFLINE_RUNTIME_OPTIONS} from '../offline-runtime.mjs';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {migrationStatements} from './migration-statements.mjs';
import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {initializeFromOwnerClick,b64url} from '../../lib/service-key.mjs';
export const BASE_NOW=Date.parse('2035-01-02T12:00:00Z')/1000;
const enabled={X_REPLY_QUEUE_ENABLED:'true',X_REPLY_QUEUE_MUTATIONS_ENABLED:'true',X_REPLY_QUEUE_SEND_ENABLED:'true'};
export async function setupQueueRuntime(backend,{onProvider}={}) {
 const {seal}=await import(pathToFileURL(path.join(backend,'src/security.mjs')).href);
 const {ownerContext}=await import(pathToFileURL(path.join(backend,'src/reads.mjs')).href);
 let now=BASE_NOW,row;
 const frontDb={prepare(){let values;return {bind(...v){values=v;return this},async run(){const [owner_id,public_jwk,private_jwk,fingerprint,created_at]=values;row={owner_id,public_jwk,private_jwk,fingerprint,created_at}},async first(){return row}}}};
 await initializeFromOwnerClick(frontDb,{id:'queue-runtime-owner'});
 const frontScript=`import {handleMcp} from './lib/x-mcp.mjs';const row=${JSON.stringify(row)};const db={prepare(){return {async first(){return row}}}};export default {async fetch(request){const {name,args,now}=await request.json();Date.now=()=>now*1000;const headers={'content-type':'application/json','oai-authenticated-user-id':'queue-runtime-owner','oai-authenticated-user-email':'owner@example.invalid'};const body=JSON.stringify({jsonrpc:'2.0',id:57,method:'tools/call',params:{name,arguments:args,_meta:{progressToken:'must-not-forward',authority:'untrusted'}}});return handleMcp(new Request('https://frontend.example.invalid/mcp',{method:'POST',headers,body}),db,${JSON.stringify(enabled)});}}`;
 const frontBundle=await build({stdin:{contents:frontScript,resolveDir:process.cwd(),sourcefile:'queue-front.mjs'},bundle:true,format:'esm',platform:'browser',write:false});
 const backBundle=await build({stdin:{contents:`import {createWorker} from ${JSON.stringify(path.join(backend,'src/worker.mjs'))};export default {fetch(request,env){const now=Number(request.headers.get('synthetic-test-time'));return createWorker({clock:()=>now}).fetch(request,env);}}`,resolveDir:process.cwd(),sourcefile:'queue-back.mjs'},bundle:true,format:'esm',platform:'browser',write:false});
 const env={PUBLIC_BASE_URL:'https://backend.example.invalid',SERVICE_ENABLED:'true',SERVICE_WRITE_ENABLED:'true',SERVICE_QUEUE_ENABLED:'true',SERVICE_PUBLIC_JWK:row.public_jwk,SERVICE_X_ACCOUNT_ID:'4242',X_EXPECTED_USER_ID:'4242',MCP_ISSUER:'https://identity.example.invalid',MCP_DISCOVERY_URL:'https://identity.example.invalid/.well-known/oauth-authorization-server',MCP_INTROSPECTION_URL:'https://identity.example.invalid/introspect',MCP_INTROSPECTION_CLIENT_ID:'mock-only-client',MCP_INTROSPECTION_CLIENT_SECRET:'mock-only-secret',MCP_ALLOWED_SUBJECT:'runtime-owner',X_CLIENT_ID:'mock-only-x-client',X_CLIENT_SECRET:'mock-only-x-secret',X_CALLBACK_URL:'https://backend.example.invalid/x/callback',TOKEN_ENCRYPTION_KEY:b64url(new Uint8Array(32).fill(6)),LIVE_X_ENABLED:'true',LIVE_IDP_ENABLED:'false',POST_ENABLED:'true',REPLY_ENABLED:'true',X_OWN_THREAD_REPLIES_ENABLED:'true',X_ONGOING_OPERATIONS_ENABLED:'true',X_WRITE_STATUS_ENABLED:'true',MAX_WRITES_DAY:'11',MAX_REPLIES_DAY:'10',MAX_X_REQUESTS_HOUR:'20',MAX_X_REQUESTS_DAY:'100',X_CREDIT_BUDGET_ID:'synthetic-queue-budget',X_CREDIT_CAP_MICROUSD:'5000000',X_CREDIT_INITIAL_MICROUSD:'0',X_CREDIT_EXPIRES_AT:String(Date.parse('2035-01-03T12:00:00Z')/1000)};
 let mf,providerCalls=0,frontCalls=0,lastBackend=null;const requests=[];
 mf=new Miniflare({...OFFLINE_RUNTIME_OPTIONS,workers:[{name:'frontend',modules:true,script:frontBundle.outputFiles[0].text,compatibilityDate:'2026-05-15',outboundService:async request=>{try{frontCalls++;assert.equal(request.url,env.PUBLIC_BASE_URL+'/service/queue/mcp');const body=await request.clone().text();assert.ok(!body.includes('must-not-forward'));assert.equal(request.headers.get('accept'),'application/json, text/event-stream');const forwarded=new Request(request.url,{method:request.method,headers:request.headers,body:await request.arrayBuffer()});forwarded.headers.set('synthetic-test-time',String(now));const response=await(await mf.getWorker('backend')).fetch(forwarded.url,{method:forwarded.method,headers:Object.fromEntries(forwarded.headers),body:await forwarded.arrayBuffer()});lastBackend={status:response.status,body:await response.clone().text()};return response;}catch(error){lastBackend={error:error.stack};throw error;}}},{name:'backend',modules:true,script:backBundle.outputFiles[0].text,compatibilityDate:'2026-05-15',bindings:env,d1Databases:{DB:'queue-interop'},outboundService:async request=>{providerCalls++;requests.push({url:request.url,method:request.method,body:await request.clone().text()});if(onProvider)return onProvider(request);throw Error('Provider egress prohibited in queue storage test');}}]});
 try {
  const db=await mf.getD1Database('DB','backend'),parser=new DatabaseSync(':memory:');
  try {for(const file of(await readdir(path.join(backend,'migrations'))).filter(f=>f.endsWith('.sql')).sort())for(const statement of migrationStatements(parser,await readFile(path.join(backend,'migrations',file),'utf8')))await db.prepare(statement).run();}finally{parser.close();}
  const sealed=await seal(env.TOKEN_ENCRYPTION_KEY,{access_token:'synthetic-unused-token',refresh_token:'synthetic-unused-refresh',scopes:['tweet.read','users.read','offline.access','tweet.write']},ownerContext(env));
  await db.prepare('INSERT INTO accounts(id,issuer,subject,x_user_id,encrypted_tokens,expires_at,updated_at) VALUES(?,?,?,?,?,?,?)').bind('primary',env.MCP_ISSUER,env.MCP_ALLOWED_SUBJECT,'4242',sealed,now+86400,now).run();
  await db.prepare('INSERT INTO x_credit_budgets VALUES(?,?,?,?,?,?,?)').bind(env.X_CREDIT_BUDGET_ID,'4242',5000000,0,0,Number(env.X_CREDIT_EXPIRES_AT),now).run();
  await db.prepare('INSERT INTO ongoing_credit_state VALUES(?,?,?,?)').bind('4242',19970000,0,'a'.repeat(64)).run();
  await db.prepare('INSERT INTO ongoing_cycles VALUES(?,?,?,?,?,?,?)').bind('4242',Date.UTC(2035,0,1)/1000,Date.UTC(2035,1,1)/1000,30000,0,'a'.repeat(64),'2035-01').run();
  await db.prepare("INSERT INTO ongoing_legacy_carry VALUES('4242',0,0,0,0,0,0,'2035-01-01','2035-01',1,?)").bind(now).run();
  const call=async(name,args={},expectSuccess=true)=>{const r=await mf.dispatchFetch('https://frontend.invalid',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'x_reply_queue_'+name,args:{request_id:crypto.randomUUID(),...args},now})});const e=await r.json();if(expectSuccess)assert.equal(e.result?.isError,false,JSON.stringify({e,lastBackend}));return expectSuccess?e.result.structuredContent:{envelope:e,backend:lastBackend};};
  return {db,call,requests,get now(){return now},setNow(value){now=value},get providerCalls(){return providerCalls},get frontCalls(){return frontCalls},close:()=>mf.dispose()};
 }catch(error){await mf.dispose();throw error;}
}
