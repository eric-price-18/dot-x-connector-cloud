// Offline cross-check against the sibling backend package.
// Not in the default tests/*.test.mjs glob: missing backend source must not silently count as an integration pass.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {handleMcp} from '../../lib/x-mcp.mjs';
import {createWriteAdapter} from '../../lib/write-service-adapter.mjs';
import {fixedWriteRequest} from '../../lib/write-service-key.mjs';
import {fixedServiceRequest,initializeFromOwnerClick,b64url,digest,ENDPOINT} from '../../lib/service-key.mjs';
import {validateWriteArguments,WRITE_ENDPOINT} from '../../lib/write-contract.mjs';
const backend=fileURLToPath(new URL('../../../backend/',import.meta.url));
const {createServiceVerifier}=await import(pathToFileURL(path.join(backend,'src/service.mjs')).href);
const {validateWriteArguments:backendValidate}=await import(pathToFileURL(path.join(backend,'src/write-validation.mjs')).href);
const encoder=new TextEncoder();
const id='01234567-89ab-4cde-8fab-0123456789ab';
const headers=new Headers({'oai-authenticated-user-id':'interop-owner','oai-authenticated-user-email':'owner@example.invalid'});
const frontEnv={X_ORIGINAL_POSTS_ENABLED:'true',X_REPOSTS_ENABLED:'true',X_WRITE_STATUS_ENABLED:'true',X_OWN_THREAD_REPLIES_ENABLED:'true'};
function memoryDb(){let row=null;return {get row(){return row},prepare(sql){let values;return {bind(...v){values=v;return this},async run(){const [owner_id,public_jwk,private_jwk,fingerprint,created_at]=values;row={owner_id,public_jwk,private_jwk,fingerprint,created_at}},async first(){return row}}}}}
async function fixture(){const db=memoryDb();await initializeFromOwnerClick(db,{id:'interop-owner'});return {db,env:{SERVICE_ENABLED:'true',SERVICE_WRITE_ENABLED:'true',PUBLIC_BASE_URL:new URL(WRITE_ENDPOINT).origin,SERVICE_PUBLIC_JWK:db.row.public_jwk}};}
const request=(proof,url=WRITE_ENDPOINT,extra={})=>new Request(url,{method:'POST',headers:{authorization:proof.authorization,'content-type':'application/json',...extra},body:proof.body});
async function resign(proof,db,change){const [h,p]=proof.authorization.slice(7).split('.');const header=JSON.parse(Buffer.from(h,'base64url')),claims=JSON.parse(Buffer.from(p,'base64url'));change(header,claims);const data=b64url(encoder.encode(JSON.stringify(header)))+'.'+b64url(encoder.encode(JSON.stringify(claims)));const key=await crypto.subtle.importKey('jwk',JSON.parse(db.row.private_jwk),{name:'ECDSA',namedCurve:'P-256'},false,['sign']);const signature=await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key,encoder.encode(data));return {...proof,authorization:'Bearer '+data+'.'+b64url(signature)};}

test('actual frontend proof is accepted by backend for original, repost, own-thread reply and ledger status; read contract still interoperates',async()=>{
 const {db,env}=await fixture();const clock=()=>Math.floor(Date.now()/1000);const verify=createServiceVerifier(clock,{write:true});
 for(const [name,args] of [['x_create_original_post',{text:'A mocked interoperability check 🦋',idempotency_key:id}],['x_repost',{post_id:'1234567890123456789',idempotency_key:id}],['x_get_write_status',{idempotency_key:id}],['x_reply',{text:'Narrow reply fixture. Reply STOP to opt out.',in_reply_to_post_id:'123',idempotency_key:id}]]){
  const proof=await fixedWriteRequest(headers,db,name,args,frontEnv);const accepted=await verify(request(proof),env,encoder.encode(proof.body));assert.equal(accepted.kind,'service_write');assert.equal(accepted.operation,name);assert.equal(accepted.idempotency_key,id);assert.deepEqual(backendValidate(name,JSON.parse(proof.body).params.arguments),validateWriteArguments(name,args).args);
 }
 const read=await fixedServiceRequest(headers,db,'x_connection_status');assert.equal((await createServiceVerifier(clock)(request(read,ENDPOINT),env,encoder.encode(read.body))).kind,'service');
});
test('backend rejects actual proof when route, body, scope, expiry, key, or claim shape is changed',async()=>{
 const {db,env}=await fixture();const verify=createServiceVerifier(()=>Math.floor(Date.now()/1000),{write:true});const proof=await fixedWriteRequest(headers,db,'x_create_original_post',{text:'Offline tamper test',idempotency_key:id},frontEnv);
 const rejects=async(p,bytes=p.body,url=WRITE_ENDPOINT,e=env,extra={})=>assert.rejects(()=>verify(request(p,url,extra),e,encoder.encode(bytes)));
 await rejects(proof,proof.body+' ');await rejects(proof,proof.body,ENDPOINT);await rejects(proof,proof.body,WRITE_ENDPOINT,env,{origin:'https://evil.invalid'});await rejects(proof,proof.body,WRITE_ENDPOINT,{...env,SERVICE_WRITE_ENABLED:'false'});
 for(const change of [(h,c)=>{c.scope='x:read'},(h,c)=>{c.aud=ENDPOINT;c.path='/service/mcp'},(h,c)=>{c.iat-=120;c.exp-=120},(h,c)=>{c.exp=c.iat+46},(h,c)=>{c.extra='forbidden'},(h,c)=>{h.kid='wrong'},(h,c)=>{c.operation='x_get_write_status'},(h,c)=>{c.in_reply_to_post_id='1'}])await rejects(await resign(proof,db,change));
 const other=await fixture();await rejects(proof,proof.body,WRITE_ENDPOINT,{...env,SERVICE_PUBLIC_JWK:other.db.row.public_jwk});
 const read=await fixedServiceRequest(headers,db,'x_connection_status');await rejects(read);
 const readVerifier=createServiceVerifier(()=>Math.floor(Date.now()/1000));await assert.rejects(()=>readVerifier(request(proof,ENDPOINT),env,encoder.encode(proof.body)));
});
test('frontend/backend validators agree on Unicode, mentions, quote links and lossless documented ID boundaries',()=>{
 const valid=['A tiny observation','x'.repeat(280),'🦋'.repeat(140),'森林'.repeat(70),'Useful https://example.com/'+'a'.repeat(300),'é'];
 const invalid=['',' ','e\u0301','x'.repeat(281),'🦋'.repeat(141),'@anyone hello','＠anyone hello','x\u202ehello','\ud800','\udc00','Good \ud800 text','https://x.com/i/web/status/123','https://mobile.twitter.com/name/status/123','https://x.com/name/status/%31%32%33','https://t.co/example'];
 for(const text of [...valid,...invalid]){const args={text,idempotency_key:id};const front=validateWriteArguments('x_create_original_post',args).ok;let back=true;try{backendValidate('x_create_original_post',args)}catch{back=false}assert.equal(back,front,JSON.stringify(text));assert.equal(front,valid.includes(text));}
 for(const post_id of ['1','9007199254740993','9999999999999999999','18446744073709551615','18446744073709551616','0','01',123]){const args={post_id,idempotency_key:id};const front=validateWriteArguments('x_repost',args).ok;let back=true;try{backendValidate('x_repost',args)}catch{back=false}assert.equal(back,front,String(post_id));}
});

test('actual frontend adapter → backend handler → SQLite ledger → mocked X works and never repeats dispatch',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2000-01-02T02:00:00Z')});
 const {harness,response}=await import(pathToFileURL(path.join(backend,'test/helpers.mjs')).href);
 const {db:frontendDb,env:serviceEnv}=await fixture();
 const h=harness(t,{...serviceEnv,X_CALLBACK_URL:serviceEnv.PUBLIC_BASE_URL+'/x/callback',SERVICE_X_ACCOUNT_ID:'4242',X_ORIGINAL_POSTS_ENABLED:'true',X_REPOSTS_ENABLED:'true',X_WRITE_STATUS_ENABLED:'true',POST_ENABLED:'true',LIVE_X_ENABLED:'true',MAX_WRITES_DAY:'10',X_CREDIT_BUDGET_ID:'example-disabled-budget',X_CREDIT_CAP_MICROUSD:'5000000',X_CREDIT_INITIAL_MICROUSD:'0',X_CREDIT_EXPIRES_AT:String(Date.parse('2000-01-02T08:00:00Z')/1000)});
 h.state.now=Math.floor(Date.now()/1000);await h.seed({scopes:['tweet.read','users.read','offline.access','tweet.write']});
 h.state.onX=async(url)=>new URL(url).pathname.endsWith('/retweets')?response({data:{retweeted:true}}):undefined;
 const a=createWriteAdapter({db:frontendDb,env:frontEnv,fetchImpl:async(url,init)=>h.worker.fetch(new Request(url,init),h.env)});
 const input={text:'A full offline route check',idempotency_key:id};
 const first=await a.call(headers,'x_create_original_post',input);assert.equal(first.ok,true,JSON.stringify(first));assert.equal(first.value.state,'succeeded');assert.equal(h.state.xCalls.length,1);
 const again=await a.call(headers,'x_create_original_post',input);assert.equal(again.value.post_id,first.value.post_id);assert.equal(h.state.xCalls.length,1);
 const status=await a.call(headers,'x_get_write_status',{idempotency_key:id});assert.equal(status.value.state,'succeeded');assert.equal(h.state.xCalls.length,1);
 const sameTextNewKey=await a.call(headers,'x_create_original_post',{...input,idempotency_key:crypto.randomUUID()});assert.equal(sameTextNewKey.ok,false);assert.equal(h.state.xCalls.length,1);
 const repost=await a.call(headers,'x_repost',{post_id:'1234567890123456789',idempotency_key:crypto.randomUUID()});assert.equal(repost.ok,true,JSON.stringify(repost));assert.equal(repost.value.post_id,'1234567890123456789');assert.equal(h.state.xCalls.length,2);
 h.state.onX=async()=>{throw Error('Mock ambiguous transport after dispatch')};const uncertainArgs={text:'A distinct uncertain local test',idempotency_key:crypto.randomUUID()};const uncertain=await a.call(headers,'x_create_original_post',uncertainArgs);assert.equal(uncertain.value.state,'unknown');assert.equal(h.state.xCalls.length,3);
 const unknownAgain=await a.call(headers,'x_create_original_post',uncertainArgs);assert.equal(unknownAgain.value.state,'unknown');assert.equal(h.state.xCalls.length,3);assert.equal((await a.call(headers,'x_get_write_status',{idempotency_key:uncertainArgs.idempotency_key})).value.state,'unknown');assert.equal(h.state.xCalls.length,3);
});
test('backend handler rejects validly signed operation/key/reply-target mismatches before dispatch',async()=>{
 const {createWorker}=await import(pathToFileURL(path.join(backend,'src/worker.mjs')).href);
 const {db,env}=await fixture();let calls=0;const worker=createWorker({clock:()=>Math.floor(Date.now()/1000),logger:()=>{},xFetch:async()=>{calls++;throw Error('No dispatch permitted')}});
 const proof=await fixedWriteRequest(headers,db,'x_create_original_post',{text:'Binding test',idempotency_key:id},frontEnv);
 const send=p=>worker.fetch(request(p,WRITE_ENDPOINT,{accept:'application/json, text/event-stream'}),env);
 for(const change of [(h,c)=>{c.operation='x_repost'},(h,c)=>{c.idempotency_key=crypto.randomUUID()}])assert.equal((await send(await resign(proof,db,change))).status,403);
 const body=JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'x_reply',arguments:{text:'Test-only reply. Reply STOP to opt out.',in_reply_to_post_id:'123',idempotency_key:id}}});const hash=await digest(body);
 const wrongTarget=await resign({...proof,body},db,(h,c)=>{c.operation='x_reply';c.scope='x:reply';c.in_reply_to_post_id='456';c.body_sha256=hash});assert.equal((await send(wrongTarget)).status,403);assert.equal(calls,0);
});

// Exercise the public MCP ingress, not only the internal adapter API. Host metadata
// belongs to that outer request and must never reach the fixed signed backend body.
test('full metadata-bearing MCP status ingress reaches actual backend with every mutation gate off and no X access',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2000-01-02T04:00:00Z')});
 const {harness}=await import(pathToFileURL(path.join(backend,'test/helpers.mjs')).href);
 const {db:frontendDb,env:serviceEnv}=await fixture();
 const h=harness(t,{...serviceEnv,X_CALLBACK_URL:serviceEnv.PUBLIC_BASE_URL+'/x/callback',SERVICE_X_ACCOUNT_ID:'4242',X_WRITE_STATUS_ENABLED:'true',POST_ENABLED:'false',REPLY_ENABLED:'false',LIVE_X_ENABLED:'false'});h.state.now=Math.floor(Date.now()/1000);
 let calls=0;
 t.mock.method(globalThis,'fetch',async(url,init)=>{calls++;assert.deepEqual(JSON.parse(init.body),{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'x_get_write_status',arguments:{idempotency_key:id}}});return h.worker.fetch(new Request(url,init),h.env)});
 const request=new Request('https://frontend.example.invalid/mcp',{method:'POST',headers:{...Object.fromEntries(headers),'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:99,method:'tools/call',params:{name:'x_get_write_status',arguments:{idempotency_key:id},_meta:{progressToken:'host-token','example.com/request':{owner:'other',account:'other',arguments:{text:'must not be used'},proof:'must not be used',url:'https://untrusted.invalid'}}}})});
 const envelope=await(await handleMcp(request,frontendDb,{X_WRITE_STATUS_ENABLED:'true'})).json();assert.equal(envelope.id,99);assert.equal(envelope.result.isError,false,JSON.stringify(envelope));assert.equal(envelope.result.structuredContent.state,'not_found');assert.equal(envelope.result.structuredContent.safe_to_retry,false);assert.equal(calls,1);assert.equal(h.state.xCalls.length,0);assert.equal(h.state.idpCalls.length,0);
});
