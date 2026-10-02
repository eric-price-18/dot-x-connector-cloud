import {OFFLINE_RUNTIME_OPTIONS} from '../offline-runtime.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {initializeFromOwnerClick,b64url} from '../../lib/service-key.mjs';
const TEST_NOW=Date.parse('2000-01-02T02:00:00Z')/1000;
const backend=fileURLToPath(new URL('../../../backend/',import.meta.url));
const {migrationStatements}=await import(pathToFileURL(path.join(backend,'test/sql-fixtures.mjs')).href);
const {seal}=await import(pathToFileURL(path.join(backend,'src/security.mjs')).href);

test('actual frontend and backend workerd pipeline enforces own-thread replies, durable STOP opt-outs, one interaction, and uncertain-send suppression',async()=>{
 let row;const frontDb={prepare(){let values;return {bind(...v){values=v;return this},async run(){const [owner_id,public_jwk,private_jwk,fingerprint,created_at]=values;row={owner_id,public_jwk,private_jwk,fingerprint,created_at}},async first(){return row}}}};
 await initializeFromOwnerClick(frontDb,{id:'runtime-interop-owner'});
 const frontendScript=`Date.now=()=>${TEST_NOW}*1000;import {handleMcp} from './lib/x-mcp.mjs';const row=${JSON.stringify(row)};const db={prepare(){return {async first(){return row}}}};export default {async fetch(request){const {name,args}=await request.json();const headers=new Headers({'content-type':'application/json','oai-authenticated-user-id':'runtime-interop-owner','oai-authenticated-user-email':'owner@example.invalid'});const body=JSON.stringify({jsonrpc:'2.0',id:57,method:'tools/call',params:{name,arguments:args,_meta:{progressToken:'runtime-progress','example.com/ignored':{owner:'not-an-owner',url:'https://untrusted-metadata.invalid',operation:'x_delete'}}}});const result=await handleMcp(new Request('https://frontend.example.invalid/mcp',{method:'POST',headers,body}),db,{X_ORIGINAL_POSTS_ENABLED:'true',X_REPOSTS_ENABLED:'true',X_WRITE_STATUS_ENABLED:'true',X_OWN_THREAD_REPLIES_ENABLED:'true'});const envelope=await result.json();return Response.json({ok:envelope.result?.isError===false,value:envelope.result?.structuredContent,error:envelope.error})}}`;
 const frontendBundle=await build({stdin:{contents:frontendScript,resolveDir:process.cwd(),sourcefile:'interop-front.mjs'},bundle:true,format:'esm',platform:'browser',write:false});
 const backendBundle=await build({stdin:{contents:`import {createWorker} from ${JSON.stringify(path.join(backend,'src/worker.mjs'))};export default createWorker({clock:()=>${TEST_NOW}});`,resolveDir:process.cwd(),sourcefile:'interop-back.mjs'},bundle:true,format:'esm',platform:'browser',write:false});
 const env={PUBLIC_BASE_URL:'https://backend.example.invalid',SERVICE_ENABLED:'true',SERVICE_WRITE_ENABLED:'true',SERVICE_PUBLIC_JWK:row.public_jwk,SERVICE_X_ACCOUNT_ID:'4242',X_EXPECTED_USER_ID:'4242',MCP_ISSUER:'https://identity.example.invalid',MCP_DISCOVERY_URL:'https://identity.example.invalid/.well-known/oauth-authorization-server',MCP_INTROSPECTION_URL:'https://identity.example.invalid/introspect',MCP_INTROSPECTION_CLIENT_ID:'mock-only-client',MCP_INTROSPECTION_CLIENT_SECRET:'mock-only-secret',MCP_ALLOWED_SUBJECT:'runtime-owner',X_CLIENT_ID:'mock-only-x-client',X_CLIENT_SECRET:'mock-only-x-secret',X_CALLBACK_URL:'https://backend.example.invalid/x/callback',TOKEN_ENCRYPTION_KEY:b64url(new Uint8Array(32).fill(6)),LIVE_X_ENABLED:'true',LIVE_IDP_ENABLED:'false',POST_ENABLED:'true',X_ORIGINAL_POSTS_ENABLED:'true',X_REPOSTS_ENABLED:'true',X_WRITE_STATUS_ENABLED:'true',MAX_WRITES_DAY:'10',MAX_REPLIES_DAY:'2',MAX_X_REQUESTS_HOUR:'20',MAX_X_REQUESTS_DAY:'100',X_OWN_THREAD_REPLIES_ENABLED:'true',REPLY_ENABLED:'true',X_CREDIT_BUDGET_ID:'example-disabled-budget',X_CREDIT_CAP_MICROUSD:'5000000',X_CREDIT_INITIAL_MICROUSD:'0',X_CREDIT_EXPIRES_AT:String(Date.parse('2000-01-02T08:00:00Z')/1000)};
 const rootPost={id:'10001',author_id:'4242',conversation_id:'10001',text:'An account-owned original',created_at:new Date((TEST_NOW-3600)*1000).toISOString(),referenced_posts:[],edit_history_post_ids:['10001'],entities:{mentions:[]}};
 const targetPost=id=>({id,author_id:id==='20004'?'6060':'5050',conversation_id:'10001',text:id==='20002'?'STOP':'A direct response to the original',created_at:new Date((TEST_NOW-60)*1000).toISOString(),referenced_posts:[{type:'replied_to',id:'10001'}],edit_history_post_ids:[id],entities:{mentions:[]}});
 const postResponse=post=>Response.json({data:post,includes:{users:[{id:post.author_id,protected:false}]}});
 let mf;let xCalls=0,frontCalls=0,mutationCalls=0,ambiguous=false;
 mf=new Miniflare({...OFFLINE_RUNTIME_OPTIONS,workers:[{name:'frontend',modules:true,script:frontendBundle.outputFiles[0].text,compatibilityDate:'2026-05-15',outboundService:async request=>{frontCalls++;assert.equal(request.url,env.PUBLIC_BASE_URL+'/service/write/mcp');assert.equal(request.headers.get('accept'),'application/json, text/event-stream');const body=await request.clone().json();assert.deepEqual(Object.keys(body.params),['name','arguments']);assert.ok(!JSON.stringify(body).includes('untrusted-metadata'));return (await mf.getWorker('backend')).fetch(request)}},{name:'backend',modules:true,script:backendBundle.outputFiles[0].text,compatibilityDate:'2026-05-15',bindings:env,d1Databases:{DB:'interop-database'},outboundService:async request=>{xCalls++;const url=new URL(request.url);assert.equal(url.origin,'https://api.x.com');
 if(request.method==='GET'){
  assert.equal(url.searchParams.has('tweet.fields'),false);
  if(url.pathname==='/2/users/4242/mentions')return Response.json({data:[],meta:{result_count:0}});
  if(url.pathname==='/2/tweets/10001')return postResponse(rootPost);
  const match=url.pathname.match(/^\/2\/tweets\/(2000[1-4])$/);if(match)return postResponse(targetPost(match[1]));
  throw Error('Unexpected mocked lookup '+url.pathname);
 }
 assert.equal(request.method,'POST');mutationCalls++;const payload=await request.json();
 if(ambiguous)return new Response('mock uncertain upstream',{status:503});
 if(request.url.endsWith('/retweets')){assert.equal(payload.tweet_id,'1234567890123456789');return Response.json({data:{retweeted:true}});}
 assert.equal(request.url,'https://api.x.com/2/tweets');
 if(payload.reply){assert.deepEqual(Object.keys(payload).sort(),['reply','text']);assert.deepEqual(Object.keys(payload.reply),['in_reply_to_tweet_id']);assert.equal(payload.reply.in_reply_to_tweet_id,'20001');assert.equal(payload.text,'A helpful narrow reply. Reply STOP to opt out.');}
 return Response.json({data:{id:(9000000000000000000n+BigInt(mutationCalls)).toString()}},{status:201});}}]});
 try{
  const db=await mf.getD1Database('DB','backend');for(const file of (await readdir(path.join(backend,'migrations'))).filter(f=>f.endsWith('.sql')).sort()){const sql=await readFile(path.join(backend,'migrations',file),'utf8');for(const statement of migrationStatements(sql))await db.prepare(statement).run();}
  const now=TEST_NOW;
  // Match the backend's documented encrypted-token binding using the actual connector context.
  const {XConnector}=await import(pathToFileURL(path.join(backend,'src/x.mjs')).href);const {Store}=await import(pathToFileURL(path.join(backend,'src/storage.mjs')).href);const {configuration}=await import(pathToFileURL(path.join(backend,'src/security.mjs')).href);
  const store=new Store(db,()=>now);const x=new XConnector(env,configuration(env),store,()=>{throw Error('Egress prohibited during seeding')},()=>now);
  await store.saveAccount(env.MCP_ISSUER,env.MCP_ALLOWED_SUBJECT,'4242',await seal(env.TOKEN_ENCRYPTION_KEY,{access_token:'mock-only-access',refresh_token:'mock-only-refresh',scopes:['tweet.read','users.read','offline.access','tweet.write']},x.context()),now+7200);
  const call=async(name,args)=>{const r=await mf.dispatchFetch('https://frontend.invalid',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name,args})});return r.json()};
  const absent=await call('x_get_write_status',{idempotency_key:crypto.randomUUID()});assert.equal(absent.ok,true,JSON.stringify(absent));assert.equal(absent.value.state,'not_found');assert.equal(xCalls,0);
  const args={text:'A full workerd pipeline fixture 🦋',idempotency_key:crypto.randomUUID()};const first=await call('x_create_original_post',args);assert.equal(first.ok,true,JSON.stringify(first));assert.equal(xCalls,1);
  assert.equal((await call('x_create_original_post',args)).value.post_id,first.value.post_id);assert.equal(xCalls,1);
  assert.equal((await call('x_get_write_status',{idempotency_key:args.idempotency_key})).value.state,'succeeded');assert.equal(xCalls,1);
  const repost=await call('x_repost',{post_id:'1234567890123456789',idempotency_key:crypto.randomUUID()});assert.equal(repost.ok,true,JSON.stringify(repost));assert.equal(xCalls,2);
  ambiguous=true;const unknownArgs={text:'A different mocked uncertain workerd intent',idempotency_key:crypto.randomUUID()};assert.equal((await call('x_create_original_post',unknownArgs)).value.state,'unknown');assert.equal(xCalls,3);assert.equal((await call('x_create_original_post',unknownArgs)).value.state,'unknown');assert.equal(xCalls,3);assert.equal((await call('x_get_write_status',{idempotency_key:unknownArgs.idempotency_key})).value.state,'unknown');assert.equal(xCalls,3);assert.equal(frontCalls,8);
  ambiguous=false;const reply={text:'A helpful narrow reply. Reply STOP to opt out.',in_reply_to_post_id:'20001',in_reply_to_author_id:'5050',idempotency_key:crypto.randomUUID()};
  const sent=await call('x_reply',reply);assert.equal(sent.ok,true,JSON.stringify(sent));assert.equal(sent.value.operation,'x_reply');assert.equal(mutationCalls,4);assert.equal(xCalls,4);
  assert.equal((await call('x_reply',reply)).value.post_id,sent.value.post_id);assert.equal(xCalls,4);
  const duplicate=await call('x_reply',{...reply,text:'Changed wording. Reply STOP to opt out.',idempotency_key:crypto.randomUUID()});assert.equal(duplicate.value.state,'rejected');assert.equal(xCalls,4);
  await db.prepare('INSERT INTO reply_opt_outs VALUES(?,?,?,?)').bind('4242','5050','20002',now).run();
  const stop=await call('x_reply',{...reply,in_reply_to_post_id:'20002',idempotency_key:crypto.randomUUID()});assert.equal(stop.value.code,'reply_author_opted_out');assert.equal(mutationCalls,4);assert.equal(xCalls,4);
  const optedOutAgain=await call('x_reply',{...reply,in_reply_to_post_id:'20003',idempotency_key:crypto.randomUUID()});assert.equal(optedOutAgain.value.code,'reply_author_opted_out');assert.equal(mutationCalls,4);assert.equal(xCalls,4);
  ambiguous=true;const uncertainReply={...reply,in_reply_to_post_id:'20004',in_reply_to_author_id:'6060',idempotency_key:crypto.randomUUID()};assert.equal((await call('x_reply',uncertainReply)).value.state,'unknown');assert.equal(mutationCalls,5);assert.equal(xCalls,5);
  assert.equal((await call('x_reply',uncertainReply)).value.state,'unknown');assert.equal(xCalls,5);assert.equal((await call('x_get_write_status',{idempotency_key:uncertainReply.idempotency_key})).value.state,'unknown');assert.equal(xCalls,5);
  const secondKey=await call('x_reply',{...uncertainReply,text:'Do not repeat. Reply STOP to opt out.',idempotency_key:crypto.randomUUID()});assert.equal(secondKey.value.state,'rejected');assert.equal(xCalls,5);

 }finally{await mf.dispose()}
});
