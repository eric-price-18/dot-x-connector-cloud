import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateWriteArguments,discoverWriteTools,normalizeWriteReceipt,WRITE_ENDPOINT,REPLY_OPT_OUT_NOTICE} from '../lib/write-contract.mjs';
import {fixedWriteRequest} from '../lib/write-service-key.mjs';
import {createWriteAdapter,DEFAULT_WRITE_TIMEOUT_MS,DEFAULT_REPLY_TIMEOUT_MS} from '../lib/write-service-adapter.mjs';
import {initializeFromOwnerClick,digest,SITE_ORIGIN} from '../lib/service-key.mjs';
import {handleMcp} from '../lib/x-mcp.mjs';
const id='01234567-89ab-4cde-8fab-0123456789ab';
const args={text:'A small discovery worth sharing.',idempotency_key:id};
const replyArgs={...args,text:args.text+'\n\n'+REPLY_OPT_OUT_NOTICE,in_reply_to_post_id:'987'};
const owner=new Headers({'oai-authenticated-user-id':'fixture-owner','oai-authenticated-user-email':'owner@example.invalid'});
const enabled={X_ORIGINAL_POSTS_ENABLED:'true',X_REPOSTS_ENABLED:'true',X_WRITE_STATUS_ENABLED:'true',X_REPLIES_ENABLED:'true'};
const good={version:1,operation:'x_create_original_post',idempotency_key:id,state:'succeeded',code:'published',post_id:'1234567890'};
const response=value=>Response.json({jsonrpc:'2.0',id:1,result:{structuredContent:value}});
function memoryDb(){let row=null;return {get row(){return row},prepare(sql){let v;return {bind(...a){v=a;return this},async run(){if(!row){const [owner_id,public_jwk,private_jwk,fingerprint,created_at]=v;row={owner_id,public_jwk,private_jwk,fingerprint,created_at}}},async first(){if(!row)return null;if(sql.includes('SELECT private_jwk'))return {private_jwk:row.private_jwk,fingerprint:row.fingerprint};const {private_jwk,...pub}=row;return pub}}}}}
async function fixture(){const db=memoryDb();await initializeFromOwnerClick(db,{id:'fixture-owner'});return db;}
const req=(method,params={},headers=owner)=>new Request(SITE_ORIGIN+'/mcp',{method:'POST',headers:{'content-type':'application/json',...Object.fromEntries(headers)},body:JSON.stringify({jsonrpc:'2.0',id:3,method,params})});

test('write discovery defaults off; generic reply flag cannot enable narrow replies',async()=>{
 assert.deepEqual(discoverWriteTools(),[]);
 assert.deepEqual(discoverWriteTools({...enabled,X_OWN_THREAD_REPLIES_ENABLED:'true'}).map(t=>t.name),['x_create_original_post','x_repost','x_reply','x_get_write_status']);
 assert.deepEqual(discoverWriteTools(enabled).map(t=>t.name),['x_create_original_post','x_repost','x_get_write_status']);
 for(const name of ['x_create_original_post','x_repost','x_get_write_status'])assert.deepEqual(discoverWriteTools({...enabled,[{x_create_original_post:'X_ORIGINAL_POSTS_ENABLED',x_repost:'X_REPOSTS_ENABLED',x_get_write_status:'X_WRITE_STATUS_ENABLED'}[name]]:'TRUE'}).filter(t=>t.name===name),[]);
 let calls=0;const a=createWriteAdapter({db:await fixture(),fetchImpl:async()=>{calls++;return response(good)}});
 assert.equal((await a.call(owner,'x_create_original_post',args)).reason,'write_disabled');
 assert.equal((await createWriteAdapter({db:await fixture(),env:enabled,fetchImpl:async()=>{calls++;return response(good)}}).call(owner,'x_reply',{...replyArgs,in_reply_to_post_id:'1'})).reason,'own_thread_replies_disabled');
 assert.equal(calls,0);
});
test('strict argument shape, UUID, IDs, NFC and weighted text validation',()=>{
 for(const input of [null,[],{}, {...args,url:'https://evil.invalid'}, {...args,reply:{}}, {...args,quote_tweet_id:'1'},{...args,account_id:'1'},{...args,idempotency_key:id.toUpperCase()},{...args,idempotency_key:'1'},{...args,text:' '},{...args,text:'e\u0301'},{...args,text:'x'.repeat(281)},{...args,text:'🦋'.repeat(141)},{...args,text:'@recipient hello'},{...args,text:'＠recipient hello'},{...args,text:'x\u202ehidden'},{...args,text:'\ud800'},{...args,text:'\udc00'},{...args,text:'Good \ud800 text'},{...args,text:'https://x.com/person/status/123'},{...args,text:'https://mobile.twitter.com/person/status/123?x=1'},{...args,text:'https://t.co/abc'},{...args,text:'https://x.com/person/status/%31%32%33'}])assert.equal(validateWriteArguments('x_create_original_post',input).ok,false,JSON.stringify(input));
 for(const text of ['x'.repeat(280),'🦋'.repeat(140),'森林'.repeat(70),'A useful link https://example.com/'+'x'.repeat(500),'é'])assert.equal(validateWriteArguments('x_create_original_post',{...args,text}).ok,true,text.slice(0,20));
 for(const post_id of ['0','01','-1','1.2','1e6',123,'18446744073709551615','18446744073709551616','1'.repeat(21),'https://x.com/i/status/1'])assert.equal(validateWriteArguments('x_repost',{post_id,idempotency_key:id}).ok,false);
 for(const post_id of ['123','9007199254740993','9999999999999999999'])assert.equal(validateWriteArguments('x_repost',{post_id,idempotency_key:id}).ok,true);
 assert.equal(normalizeWriteReceipt('x_create_original_post',args,{...good,post_id:'9999999999999999999'}).post_id,'9999999999999999999');
 assert.equal(normalizeWriteReceipt('x_create_original_post',args,{...good,post_id:'18446744073709551616'}),null);
 assert.equal(validateWriteArguments('x_reply',{...replyArgs,in_reply_to_post_id:'123'}).ok,true);
 assert.equal(validateWriteArguments('x_reply',{...replyArgs,in_reply_to_post_id:'123',recipient_id:'5'}).ok,false);
});
test('write proof verifies and binds exact endpoint/body/operation/key, while using existing owner key',async()=>{
 const db=await fixture();const before=db.row.private_jwk;const proof=await fixedWriteRequest(owner,db,'x_create_original_post',args,enabled);
 const [h,p,s]=proof.authorization.slice(7).split('.');const header=JSON.parse(Buffer.from(h,'base64url'));const claims=JSON.parse(Buffer.from(p,'base64url'));
 assert.deepEqual(header,{alg:'ES256',typ:'JWT',kid:db.row.fingerprint});
 assert.deepEqual(Object.keys(claims).sort(),['iss','sub','aud','scope','iat','exp','jti','method','path','body_sha256','operation','idempotency_key'].sort());
 assert.equal(claims.aud,WRITE_ENDPOINT);assert.equal(claims.path,'/service/write/mcp');assert.equal(claims.scope,'x:write');assert.equal(claims.method,'POST');assert.equal(claims.operation,'x_create_original_post');assert.equal(claims.idempotency_key,id);assert.equal(claims.exp-claims.iat,45);assert.equal(claims.body_sha256,await digest(proof.body));assert.deepEqual(JSON.parse(proof.body),{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'x_create_original_post',arguments:args}});
 const key=await crypto.subtle.importKey('jwk',JSON.parse(db.row.public_jwk),{name:'ECDSA',namedCurve:'P-256'},false,['verify']);assert.equal(await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},key,Buffer.from(s,'base64url'),Buffer.from(h+'.'+p)),true);assert.equal(db.row.private_jwk,before);
 const status=await fixedWriteRequest(owner,db,'x_get_write_status',{idempotency_key:id},enabled);assert.equal(JSON.parse(Buffer.from(status.authorization.split('.')[1],'base64url')).scope,'x:write:status');
 const wrong=new Headers(owner);wrong.set('oai-authenticated-user-id','other');await assert.rejects(()=>fixedWriteRequest(wrong,db,'x_create_original_post',args,enabled));await assert.rejects(()=>fixedWriteRequest(owner,db,'x_create_original_post',args,{}));
});
test('fixed transport forwards no incoming credentials or caller-selected target; every outcome forbids retry',async()=>{
 let calls=0;const db=await fixture();const headers=new Headers(owner);headers.set('Authorization','Bearer must-not-forward');headers.set('OAI-Sites-Authorization','Bearer also-private');
 const a=createWriteAdapter({db,env:enabled,fetchImpl:async(url,init)=>{calls++;assert.equal(url,WRITE_ENDPOINT);assert.equal(init.redirect,'manual');assert.deepEqual(Object.keys(init.headers).sort(),['Accept','Authorization','Content-Type','MCP-Protocol-Version'].sort());assert.ok(!JSON.stringify(init.headers).includes('must-not-forward'));return response(good)}});
 assert.deepEqual((await a.call(headers,'x_create_original_post',args)).value,{...good,safe_to_retry:false});
 for(const [h,n,input] of [[new Headers(),'x_create_original_post',args],[owner,'x_delete',args],[owner,'x_create_original_post',{...args,url:'https://evil.invalid'}]])assert.equal((await a.call(h,n,input)).ok,false);
 assert.equal(calls,1);
});
test('network/timeout/redirect/malformed/large response yields unknown, no retry and no detail leakage',async()=>{
 const db=await fixture();
 const behaviors=[()=>{throw Error('SECRET')},()=>new Response('SECRET',{status:500}),()=>new Response('SECRET',{status:302,headers:{location:'https://never-follow.invalid'}}),()=>response({...good,private:'SECRET'}),()=>response({...good,idempotency_key:crypto.randomUUID()}),()=>response({...good,operation:'x_repost'}),()=>Response.json({jsonrpc:'2.0',id:1,result:{isError:true,structuredContent:good}}),()=>Response.json({jsonrpc:'2.0',id:1,result:{isError:true,content:[{type:'text',text:'SECRET'}]}}),()=>new Response('x'.repeat(16385),{headers:{'content-type':'application/json'}}),()=>new Promise(()=>{})];
 for(const behavior of behaviors){let calls=0;const a=createWriteAdapter({db,env:enabled,timeoutMs:20,fetchImpl:async()=>{calls++;return behavior()}});const out=await a.call(owner,'x_create_original_post',args);assert.equal(out.ok,false);assert.equal(out.value.state,'unknown');assert.equal(out.safe_to_retry,false);assert.equal(out.value.idempotency_key,id);assert.ok(!JSON.stringify(out).includes('SECRET'));await new Promise(r=>setTimeout(r,25));assert.equal(calls,1);}
});
test('status receipts are ledger-only and not-found never licenses retry',()=>{
 assert.deepEqual(normalizeWriteReceipt('x_get_write_status',{idempotency_key:id},{version:1,operation:null,idempotency_key:id,state:'not_found',code:'not_found'}),{version:1,operation:null,idempotency_key:id,state:'not_found',code:'not_found',safe_to_retry:false});
 assert.equal(normalizeWriteReceipt('x_create_original_post',args,{...good,state:'not_found',operation:null}),null);
 for(const state of ['pending','unknown','rejected']){const {post_id,...rest}=good;assert.equal(normalizeWriteReceipt('x_create_original_post',args,{...rest,state}).safe_to_retry,false);}
});
test('MCP boundary hides writes by default, denies other owners/cross-origin and keeps read discovery',async()=>{
 const list=await(await handleMcp(req('tools/list'))).json();assert.equal(list.result.tools.length,3);
 const visible=await(await handleMcp(req('tools/list'),null,enabled)).json();assert.equal(visible.result.tools.length,6);
 for(const h of [new Headers(),new Headers({...Object.fromEntries(owner),'oai-authenticated-user-email':'other@example.invalid'})])assert.ok([401,403].includes((await handleMcp(req('tools/call',{name:'x_create_original_post',arguments:args},h),null,enabled)).status));
 const cross=new Headers(owner);cross.set('Origin','https://evil.invalid');assert.equal((await handleMcp(req('tools/call',{name:'x_create_original_post',arguments:args},cross),null,enabled)).status,403);
 const status=await(await handleMcp(req('tools/call',{name:'x_connection_status'}),null,enabled)).json();assert.equal(status.result.structuredContent.read_tools_contact_x,false);assert.equal(status.result.structuredContent.write_frontend.original_posts_enabled,true);assert.equal(status.result.structuredContent.write_frontend.backend_write_readiness,'not_checked');
 const disabled=await(await handleMcp(req('tools/call',{name:'x_create_original_post',arguments:args}))).json();assert.equal(disabled.result.structuredContent.reason,'write_disabled');
});
test('own-thread reply proof uses exact target and separate scope, only with the dedicated server gate',async()=>{
 const db=await fixture();
 await assert.rejects(()=>fixedWriteRequest(owner,db,'x_reply',replyArgs,enabled));
 const proof=await fixedWriteRequest(owner,db,'x_reply',replyArgs,{...enabled,X_OWN_THREAD_REPLIES_ENABLED:'true'});const claims=JSON.parse(Buffer.from(proof.authorization.split('.')[1],'base64url'));assert.equal(claims.scope,'x:reply');assert.equal(claims.in_reply_to_post_id,'987');assert.equal(JSON.parse(proof.body).params.arguments.in_reply_to_post_id,'987');
 for(const value of ['false','TRUE',true,undefined])assert.equal(discoverWriteTools({...enabled,X_OWN_THREAD_REPLIES_ENABLED:value}).some(t=>t.name==='x_reply'),false);
});
test('invalid UTF-8 JSON is rejected before mutation text can be silently replaced',async()=>{
 const before=new TextEncoder().encode('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"x_create_original_post","arguments":{"text":"');const after=new TextEncoder().encode('","idempotency_key":"'+id+'"}}}');const bytes=new Uint8Array(before.length+1+after.length);bytes.set(before);bytes[before.length]=255;bytes.set(after,before.length+1);
 const response=await handleMcp(new Request(SITE_ORIGIN+'/mcp',{method:'POST',headers:{...Object.fromEntries(owner),'content-type':'application/json'},body:bytes}),null,enabled);assert.equal(response.status,400);
});

test('reply notice is mandatory, unchanged and included in weighted length',()=>{
 assert.equal(validateWriteArguments('x_reply',replyArgs).ok,true);
 for(const text of [args.text,args.text+' Reply stop to opt out.',replyArgs.text+' trailing','x'.repeat(280)+' '+REPLY_OPT_OUT_NOTICE])assert.equal(validateWriteArguments('x_reply',{...replyArgs,text}).ok,false);
 assert.equal(validateWriteArguments('x_reply',{...replyArgs,text:'x'.repeat(279-REPLY_OPT_OUT_NOTICE.length)+' '+REPLY_OPT_OUT_NOTICE}).ok,true);
});
test('own-thread reply adapter forwards only exact target/text/key and rejects caller-supplied eligibility',async()=>{
 const db=await fixture();let calls=0;
 const a=createWriteAdapter({db,env:{...enabled,X_OWN_THREAD_REPLIES_ENABLED:'true'},fetchImpl:async(url,init)=>{calls++;assert.equal(url,WRITE_ENDPOINT);assert.deepEqual(JSON.parse(init.body).params.arguments,replyArgs);const claims=JSON.parse(Buffer.from(init.headers.Authorization.split('.')[1],'base64url'));assert.equal(claims.scope,'x:reply');assert.equal(claims.in_reply_to_post_id,replyArgs.in_reply_to_post_id);return response({...good,operation:'x_reply'});}});
 assert.equal((await a.call(owner,'x_reply',replyArgs)).ok,true);
 for(const extra of [{root_owned:true},{opted_in:true},{opted_out:false},{author_id:'4242'},{root_post_id:'5'},{allow_reply:true}])assert.equal((await a.call(owner,'x_reply',{...replyArgs,...extra})).ok,false);
 assert.equal(calls,1);
});

test('bounded reply timeout can later resolve through status without resending the mutation',async()=>{
 assert.equal(DEFAULT_WRITE_TIMEOUT_MS,8000);assert.equal(DEFAULT_REPLY_TIMEOUT_MS,55000);
 const db=await fixture();let sends=0,statusReads=0,committed=false;
 const fetchImpl=async(url,init)=>{const name=JSON.parse(init.body).params.name;if(name==='x_reply'){sends++;await new Promise(resolve=>setTimeout(resolve,200));committed=true;return response({...good,operation:'x_reply'});}statusReads++;return response({...good,operation:'x_reply',...(committed?{}:{state:'pending',post_id:undefined})});};
 const env={...enabled,X_OWN_THREAD_REPLIES_ENABLED:'true'};
 const uncertain=await createWriteAdapter({db,env,fetchImpl,timeoutMs:50}).call(owner,'x_reply',replyArgs);assert.equal(uncertain.value.state,'unknown');assert.equal(sends,1);
 await new Promise(resolve=>setTimeout(resolve,250));const receipt=await createWriteAdapter({db,env,fetchImpl}).call(owner,'x_get_write_status',{idempotency_key:id});assert.equal(receipt.value.state,'succeeded');assert.equal(sends,1);assert.equal(statusReads,1);assert.equal(receipt.safe_to_retry,false);
});

test('status keeps configured gates, stored link state and live readiness distinct across combinations',async()=>{
 const db=await fixture();const previous=globalThis.fetch;
 try{
  for(const frontEnabled of [false,true])for(const linked of [false,true])for(const reconnect of [false,true])for(const backendPost of [false,true]){
   globalThis.fetch=async(url)=>{assert.equal(url,'https://backend.example.invalid/service/mcp');return response({linked,reconnect_required:reconnect,polling_enabled:false,post_enabled:backendPost,reply_enabled:backendPost});};
   const data=(await(await handleMcp(req('tools/call',{name:'x_connection_status'}),db,frontEnabled?{...enabled,X_OWN_THREAD_REPLIES_ENABLED:'true'}:{})).json()).result.structuredContent;
   assert.equal(data.backend_connected,true);assert.equal(data.x_connected,null);assert.equal(data.live_x_enabled,null);assert.equal(data.read_tools_contact_x,false);assert.equal(data.x_linked,linked);assert.equal(data.x_reconnect_required,reconnect);assert.equal(data.backend_status_scope,'stored_link_and_configured_gates_only');assert.equal(data.write_frontend.original_posts_enabled,frontEnabled);assert.equal(data.write_frontend.replies_enabled,frontEnabled);assert.equal(data.write_frontend.backend_write_readiness,'not_checked');assert.equal(data.backend_status.post_enabled,backendPost);
  }
  globalThis.fetch=async()=>{throw Error('Mock service transport failure')};const failed=(await(await handleMcp(req('tools/call',{name:'x_connection_status'}),db,enabled)).json()).result.structuredContent;
  assert.equal(failed.backend_connected,false);assert.equal(failed.x_connected,null);assert.equal(failed.x_linked,null);assert.equal(failed.live_x_enabled,null);assert.equal(failed.read_tools_contact_x,false);
 }finally{globalThis.fetch=previous;}
});
test('write descriptors state exact boundaries and truthful MCP annotations',()=>{
 const tools=discoverWriteTools({...enabled,X_OWN_THREAD_REPLIES_ENABLED:'true'});
 for(const t of tools){assert.equal(t.inputSchema.additionalProperties,false);assert.equal(t.annotations.readOnlyHint,t.name==='x_get_write_status');assert.equal(t.annotations.openWorldHint,t.name!=='x_get_write_status');assert.equal(t.annotations.destructiveHint,t.name!=='x_get_write_status');assert.equal(t.annotations.idempotentHint,true);assert.ok(t.inputSchema.required.includes('idempotency_key'));}
 const reply=tools.find(t=>t.name==='x_reply');assert.match(reply.description,/directly replying/);assert.match(reply.description,/Reply STOP to opt out/);assert.match(reply.description,/one automated reply per interaction/);assert.ok(reply.inputSchema.required.includes('in_reply_to_post_id'));assert.doesNotMatch(reply.description,/X approval|written approval/);
});

test('bridge-disabled build reports unknown live state and makes no backend request',async()=>{
 const keySource=(await readFile(new URL('../lib/service-key.mjs',import.meta.url),'utf8')).replace('SERVICE_BRIDGE_ENABLED=true','SERVICE_BRIDGE_ENABLED=false');
 const keyUrl='data:text/javascript;base64,'+Buffer.from(keySource).toString('base64');
 let source=await readFile(new URL('../lib/x-mcp.mjs',import.meta.url),'utf8');source=source.replace("'./service-key.mjs'",JSON.stringify(keyUrl)).replace(/'\.\/([^']+)'/g,(_,name)=>JSON.stringify(new URL('../lib/'+name,import.meta.url).href));
 const disabled=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));const previous=globalThis.fetch;let calls=0;globalThis.fetch=()=>{calls++;throw Error('Backend request prohibited')};
 try{const value=(await(await disabled.handleMcp(req('tools/call',{name:'x_connection_status'}))).json()).result.structuredContent;assert.equal(value.upstream_configured,false);assert.equal(value.backend_contacted,false);assert.equal(value.x_connected,null);assert.equal(value.x_linked,null);assert.equal(value.x_reconnect_required,null);assert.equal(value.live_x_enabled,null);assert.equal(value.read_tools_contact_x,false);assert.equal(calls,0);}finally{globalThis.fetch=previous;}
});
