import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {discoverQueueTools,validateQueueArguments,QUEUE_NAMES,QUEUE_SCOPES,QUEUE_ENDPOINT} from '../lib/queue-contract.mjs';
import {fixedQueueRequest} from '../lib/queue-service-key.mjs';
import {createQueueAdapter} from '../lib/queue-service-adapter.mjs';
import {normalizeQueueResponse} from '../lib/queue-response.mjs';
import {initializeFromOwnerClick,digest,SITE_ORIGIN} from '../lib/service-key.mjs';
import {handleMcp,tools} from '../lib/x-mcp.mjs';
const id='01234567-89ab-4cde-8fab-0123456789ab';
const enabled={X_REPLY_QUEUE_ENABLED:'true',X_REPLY_QUEUE_MUTATIONS_ENABLED:'true',X_REPLY_QUEUE_SEND_ENABLED:'true'};
const owner=new Headers({'oai-authenticated-user-id':'queue-owner','oai-authenticated-user-email':'owner@example.invalid'});
async function fixture(){let row;const db={get row(){return row},prepare(){let v;return {bind(...a){v=a;return this},async run(){const [owner_id,public_jwk,private_jwk,fingerprint,created_at]=v;row={owner_id,public_jwk,private_jwk,fingerprint,created_at}},async first(){return row}}}};await initializeFromOwnerClick(db,{id:'queue-owner'});return db;}
const now=1790971200,iso=n=>new Date(n*1000).toISOString();
const safety={version:1,approval_required:true,send_authorized:false};
const row={target_id:'1002',author_id:'5050',root_id:'1000',state:'pending',intent_key:id,intent_ref:`reply-queue-intent:${id}`,receipt_ref:`service-write:${id}`,reason:null,due_at:iso(now),source_created_at:now,expires_at:iso(now+86400),revision:0};
const listValue={request_id:id,request_state:'completed',...safety,account_id:'4242',observed_at:iso(now),items:[row],next_after:null,has_more:false};
const response=value=>Response.json({jsonrpc:'2.0',id:1,result:{structuredContent:value}});
const req=(method,params={},headers=owner)=>new Request(SITE_ORIGIN+'/mcp',{method:'POST',headers:{'content-type':'application/json',...Object.fromEntries(headers)},body:JSON.stringify({jsonrpc:'2.0',id:7,method,params})});
const record={target_id:'1002',author_id:'5050',root_id:'1000',source_created_at:now,context_ref:'synthetic:untrusted browser context'};
const held={request_id:id,target_id:row.target_id,intent_key:id,claim_token:id,expected_revision:0};
const approval={...held,text:'A useful reply.',context_ref:'synthetic:fresh browser',rechecked_at:now,conversation_checked:true,value_checked:true,stop_checked:true};

test('queue discovery is independently gated, default-off and uses native Sites authentication',async()=>{
 assert.equal(QUEUE_NAMES.size,8);assert.deepEqual(discoverQueueTools(),[]);
 assert.equal(discoverQueueTools({X_REPLY_QUEUE_ENABLED:'true'}).length,2);
 assert.equal(discoverQueueTools({...enabled,X_REPLY_QUEUE_SEND_ENABLED:'false'}).length,5);
 assert.equal(discoverQueueTools(enabled).length,8);
 for(const tool of discoverQueueTools(enabled)){assert.equal(tool.securitySchemes,undefined);assert.equal(tool._meta,undefined);assert.equal(tool.inputSchema.additionalProperties,false);assert.equal(tool.annotations.idempotentHint,true);}
 for(const value of ['TRUE',true,1])assert.equal(discoverQueueTools({...enabled,X_REPLY_QUEUE_ENABLED:value}).length,0);
 const init=(await(await handleMcp(req('initialize'),null,enabled)).json()).result.instructions;
 assert.match(init,/freshly check the browser/);assert.match(init,/24-hour expiry/);assert.match(init,/scheduled:false/);assert.doesNotMatch(init,/Private, read-only/);
 const listed=(await(await handleMcp(req('tools/list'),null,enabled)).json()).result.tools;assert.equal(listed.length,tools.length+QUEUE_NAMES.size);
});
test('strict queue schema protects identity, claims, decisions and immutable publish input',()=>{
 for(const [name,args] of [['x_reply_queue_ingest',{request_id:id,records:[record]}],['x_reply_queue_list',{request_id:id}],['x_reply_queue_claim',{request_id:id}],['x_reply_queue_readiness',{request_id:id}],['x_reply_queue_reconcile',{request_id:id,intent_key:id}],['x_reply_queue_approve',approval],['x_reply_queue_publish',held],['x_reply_queue_cancel',{...held,reason:'explicit_stop'}]])assert.equal(validateQueueArguments(name,args).ok,true,name);
 for(const records of [[{...record,state:'approved'}],Array(3).fill(record),[{...record,target_id:'01'}],[{...record,source_created_at:1.5}]])assert.equal(validateQueueArguments('x_reply_queue_ingest',{request_id:id,records}).ok,false);
 for(const extra of [{text:'changed'},{author_id:'1'},{receipt:{state:'sent'}},{account_id:'1'},{generation:1}])assert.equal(validateQueueArguments('x_reply_queue_publish',{...held,...extra}).ok,false);
 for(const changed of [{conversation_checked:false},{value_checked:'true'},{stop_checked:1},{text:'@someone reply'},{text:'x'.repeat(281)},{text:'e\u0301'},{text:'\ud800'},{expected_revision:-1},{claim_token:'untrusted'}])assert.equal(validateQueueArguments('x_reply_queue_approve',{...approval,...changed}).ok,false,JSON.stringify(changed));
 assert.equal(validateQueueArguments('x_reply_queue_cancel',{...held,reason:'resend'}).ok,false);
});
test('queue proof binds exact canonical body, operation and request ID with the existing key',async()=>{
 const db=await fixture(),before=db.row.private_jwk;
 for(const [name,args] of [['x_reply_queue_list',{request_id:id}],['x_reply_queue_ingest',{records:[record],request_id:id}],['x_reply_queue_publish',held],['x_reply_queue_approve',approval]]){
  const proof=await fixedQueueRequest(owner,db,name,args,enabled),[h,p,s]=proof.authorization.slice(7).split('.');const claims=JSON.parse(Buffer.from(p,'base64url'));
  assert.deepEqual(Object.keys(claims),['iss','sub','aud','scope','iat','exp','jti','method','path','body_sha256','operation','request_id']);
  assert.equal(claims.scope,QUEUE_SCOPES[name]);assert.equal(claims.jti,id);assert.equal(claims.request_id,id);assert.equal(claims.operation,name);assert.equal(claims.exp-claims.iat,45);assert.equal(claims.path,'/service/queue/mcp');assert.equal(claims.aud,QUEUE_ENDPOINT);assert.equal(claims.body_sha256,await digest(proof.body));
  assert.deepEqual(JSON.parse(proof.body).params.arguments,validateQueueArguments(name,args).args);
  const key=await crypto.subtle.importKey('jwk',JSON.parse(db.row.public_jwk),{name:'ECDSA',namedCurve:'P-256'},false,['verify']);assert.equal(await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},key,Buffer.from(s,'base64url'),Buffer.from(h+'.'+p)),true);
 }
 assert.equal(db.row.private_jwk,before);const wrong=new Headers(owner);wrong.set('oai-authenticated-user-id','other');await assert.rejects(()=>fixedQueueRequest(wrong,db,'x_reply_queue_list',{request_id:id},enabled));
});
test('full MCP ingress checks owner/origin, strips metadata and never forwards incoming secrets',async t=>{
 const db=await fixture();let calls=0;
 t.mock.method(globalThis,'fetch',async(url,init)=>{calls++;assert.equal(url,QUEUE_ENDPOINT);assert.equal(init.redirect,'manual');assert.deepEqual(Object.keys(init.headers).sort(),['Accept','Authorization','Content-Type','MCP-Protocol-Version'].sort());assert.ok(!JSON.stringify(init).includes('PRIVATE_METADATA'));assert.deepEqual(JSON.parse(init.body).params,{name:'x_reply_queue_list',arguments:{request_id:id}});return response(listValue)});
 const params={name:'x_reply_queue_list',arguments:{request_id:id},_meta:{progressToken:'PRIVATE_METADATA',authorization:'PRIVATE_METADATA'}};
 const h=new Headers(owner);h.set('Authorization','PRIVATE_METADATA');h.set('OAI-Sites-Authorization','PRIVATE_METADATA');
 const ok=await(await handleMcp(req('tools/call',params,h),db,enabled)).json();assert.equal(ok.result.isError,false);assert.equal(ok.result.structuredContent.safe_to_retry,false);assert.equal(calls,1);
 for(const headers of [new Headers(),new Headers({'oai-authenticated-user-id':'bad','oai-authenticated-user-email':'bad@example.invalid'})])assert.ok([401,403].includes((await handleMcp(req('tools/call',params,headers),db,enabled)).status));
 const cross=new Headers(owner);cross.set('origin','https://untrusted.invalid');assert.equal((await handleMcp(req('tools/call',params,cross),db,enabled)).status,403);
 for(const change of [{_meta:[]},{_meta:{progressToken:true}},{url:'https://untrusted.invalid'},{task:{ttl:1000}}])assert.equal((await(await handleMcp(req('tools/call',{...params,...change}),db,enabled)).json()).error.code,-32602);
 assert.equal((await(await handleMcp(req('tools/call',params),db,{})).json()).result.structuredContent.reason,'reply_queue_disabled');assert.equal(calls,1);
});
test('strict response validation rejects leaked fields, mixed request identities and contradictory pagination',()=>{
 assert.ok(normalizeQueueResponse('x_reply_queue_list',{request_id:id},listValue));
 for(const changed of [{private_jwk:'SECRET'},{request_id:crypto.randomUUID()},{approval_required:false},{send_authorized:true},{has_more:true},{items:[{...row,receipt_ref:'service-write:wrong'}]},{items:[{...row,context_ref:'SECRET'}]}])assert.equal(normalizeQueueResponse('x_reply_queue_list',{request_id:id},{...listValue,...changed}),null);
 const expired={request_id:id,request_state:'completed',replayed:true,result_at:iso(now),...safety,account_id:'4242',claim:{...row,claim_token:id,claim_until:iso(now+120),context_ref:'untrusted:ignored',context_is_untrusted:true,draft_present:false,approval_required:true,send_authorized:false,review_only:false,eligibility:{eligible_at:iso(now),reason:'ready'}},reason:'model_review_required',scan_complete:true,next_after:null,queue_generation:1};
 assert.equal(normalizeQueueResponse('x_reply_queue_claim',{request_id:id},expired,now).review_lease_valid,true);
 assert.equal(normalizeQueueResponse('x_reply_queue_claim',{request_id:id},expired,now+120).review_lease_valid,false);
});
test('transport ambiguity never retries, follows redirects, returns provider secrets or invents success',async()=>{
 const db=await fixture();for(const behavior of [()=>{throw Error('SECRET')},()=>new Response('SECRET',{status:302,headers:{location:'https://untrusted.invalid'}}),()=>new Response('SECRET',{status:500}),()=>response({...listValue,secret:'SECRET'}),()=>response({...listValue,request_id:crypto.randomUUID()}),()=>new Response('x'.repeat(196609),{headers:{'content-type':'application/json'}}),()=>new Promise(()=>{})]){
  let calls=0;const out=await createQueueAdapter({db,env:enabled,timeoutMs:20,fetchImpl:async()=>{calls++;return behavior()}}).call(owner,'x_reply_queue_ingest',{request_id:id,records:[]});
  assert.equal(out.ok,false);assert.equal(out.value.send_authorized,false);assert.equal(out.safe_to_retry,false);assert.equal(out.value.request_state,'indeterminate');assert.ok(!JSON.stringify(out).includes('SECRET'));await new Promise(r=>setTimeout(r,25));assert.equal(calls,1);
 }
});
test('frozen send input contract retains exact sanitized public bytes',async()=>{
 const {createHash}=await import('node:crypto');const bytes=await readFile(new URL('../lib/reply-queue-send-policy.json',import.meta.url));assert.equal(createHash('sha256').update(bytes).digest('hex'),'d4353b947d8d0030ff198aee914fad841ba1f8426c6337904334d3f93acaa3dd');
});

test('approval response binds exact claim, target, intent and stored revision; replay cannot extend authority',()=>{
 const approved={request_id:id,request_state:'completed',replayed:false,result_at:iso(now),version:1,account_id:'4242',item:{...row,state:'approved',revision:1},approved_revision:1,claim_token:id,claim_until:iso(now+120),approval_expires_at:iso(now+60),publish_binding:{target_id:row.target_id,intent_key:id,claim_token:id,expected_revision:1},next_operation:'x_reply_queue_publish',published:false};
 assert.equal(normalizeQueueResponse('x_reply_queue_approve',approval,approved,now).approval_valid,true);
 assert.equal(normalizeQueueResponse('x_reply_queue_approve',approval,{...approved,replayed:true},now+60).approval_valid,false);
 for(const change of [{published:true},{approval_required:true},{claim_token:crypto.randomUUID()},{approved_revision:2},{approval_expires_at:iso(now+61)},{publish_binding:{...approved.publish_binding,expected_revision:0}},{item:{...approved.item,target_id:'999'}},{item:{...approved.item,state:'sent'}}])assert.equal(normalizeQueueResponse('x_reply_queue_approve',approval,{...approved,...change},now),null,JSON.stringify(change));
});
test('all frozen publication receipt variants remain bound and published:false never implies no dispatch',()=>{
 const base={request_id:id,request_state:'completed',replayed:false,result_at:iso(now),version:1,account_id:'4242',item:{...row,revision:2},next_operation:'x_reply_queue_readiness',published:false};
 const rb={idempotency_key:id,receipt_ref:row.receipt_ref};
 for(const [outcome,receipt,state,published,next_operation] of [
  ['deferred',null,'blocked',false,'x_reply_queue_readiness'],['cancelled',null,'cancelled',false,'x_reply_queue_readiness'],
  ['sent',{...rb,state:'sent',post_id:'9001'},'sent',true,'x_reply_queue_readiness'],
  ['unknown',{...rb,state:'unknown'},'unknown',false,'x_reply_queue_reconcile'],
  ['cancelled',{...rb,state:'rejected',dispatched:true,code:'x_rejected'},'cancelled',false,'x_reply_queue_readiness'],
  ['blocked',{...rb,state:'rejected',dispatched:false,code:'local_quota'},'blocked',false,'x_reply_queue_readiness']]){
  const value={...base,outcome,receipt,item:{...base.item,state},published,next_operation};
  const parsed=normalizeQueueResponse('x_reply_queue_publish',held,value,now);assert.ok(parsed,JSON.stringify(value));assert.equal(parsed.safe_to_retry,false);assert.equal(parsed.published,published);
  for(const change of [{published:!published},{receipt:{...receipt,idempotency_key:crypto.randomUUID()}},{item:{...value.item,intent_key:crypto.randomUUID()}},{approval_required:true},{state:'sent'},{provider_token:'SECRET'}])assert.equal(normalizeQueueResponse('x_reply_queue_publish',held,{...value,...change},now),null);
 }
 const uncertain={version:1,request_id:id,request_state:'indeterminate',replayed:true,approval_required:true,send_authorized:false,recovery:'reconcile_original_intent_do_not_resend',intent_key:id};
 assert.ok(normalizeQueueResponse('x_reply_queue_publish',held,uncertain));assert.equal(normalizeQueueResponse('x_reply_queue_publish',held,{...uncertain,intent_key:crypto.randomUUID()}),null);
 assert.equal(normalizeQueueResponse('x_reply_queue_approve',approval,uncertain),null);
});
test('cancellation exact scope and frozen output bytes are verified',async()=>{
 const value={request_id:id,request_state:'completed',replayed:false,result_at:iso(now),version:1,account_id:'4242',item:{...row,state:'cancelled',revision:1},outcome:'cancelled',author_opt_out_recorded:true,published:false,next_operation:'x_reply_queue_readiness'};
 assert.ok(normalizeQueueResponse('x_reply_queue_cancel',{...held,reason:'explicit_stop'},value));
 assert.equal(normalizeQueueResponse('x_reply_queue_cancel',{...held,reason:'no_value'},value),null);
 const {createHash}=await import('node:crypto');const bytes=await readFile(new URL('../lib/reply-queue-send-output-policy.json',import.meta.url));assert.equal(createHash('sha256').update(bytes).digest('hex'),'850977ffd8e2b776a0cf07e7fba2a61ad40db085f9a192e152dd134b148b7dd0');
 for(const [name,expected] of [['reply-queue-policy.json','f9d88422a5e502db391c68771670d8a8500a99ef0125bd515f991a26d1823788'],['reply-queue-claim-output-policy.json','1ab59e8e8c92aef0861940912c801b9beeabf42cdf40c891030b5fbda4ff64be']])assert.equal(createHash('sha256').update(await readFile(new URL('../lib/'+name,import.meta.url))).digest('hex'),expected);
});
test('queue publication transport uses only the frozen held claim and reconciles after ambiguous dispatch',async()=>{
 const db=await fixture();let calls=0;const out=await createQueueAdapter({db,env:enabled,timeoutMs:20,fetchImpl:async(url,init)=>{calls++;assert.deepEqual(JSON.parse(init.body).params,{name:'x_reply_queue_publish',arguments:held});return new Promise(()=>{});}}).call(owner,'x_reply_queue_publish',held);
 assert.equal(out.ok,false);assert.equal(out.value.intent_key,id);assert.equal(out.value.recovery,'reconcile_original_intent_do_not_resend');assert.equal(out.value.send_authorized,false);assert.equal(out.value.safe_to_retry,false);assert.equal(calls,1);
});

test('review-only held claim metadata permits review but never creates publication authority',()=>{
 const value={request_id:id,request_state:'completed',replayed:false,result_at:iso(now),version:1,approval_required:true,send_authorized:false,account_id:'4242',claim:{...row,claim_token:id,claim_until:iso(now+120),context_ref:'untrusted:ignored',context_is_untrusted:true,draft_present:false,approval_required:true,send_authorized:false,review_only:true,eligibility:{eligible_at:null,reason:'daily_spend_cap'}},reason:'operational_hold_review_only',scan_complete:true,next_after:null,queue_generation:1};
 const parsed=normalizeQueueResponse('x_reply_queue_claim',{request_id:id},value,now);assert.equal(parsed.review_lease_valid,true);assert.equal(parsed.claim.review_only,true);assert.equal(parsed.claim.send_authorized,false);
 for(const reason of ['model_review_required','no_due_item'])assert.equal(normalizeQueueResponse('x_reply_queue_claim',{request_id:id},{...value,reason},now),null);
 assert.equal(normalizeQueueResponse('x_reply_queue_claim',{request_id:id},{...value,claim:{...value.claim,review_only:false}},now),null);
 assert.equal(normalizeQueueResponse('x_reply_queue_claim',{request_id:id},{...value,claim:{...value.claim,review_only:undefined}},now),null);
 assert.equal(normalizeQueueResponse('x_reply_queue_claim',{request_id:id},{...value,claim:{...value.claim,eligibility:undefined}},now),null);
 assert.equal(normalizeQueueResponse('x_reply_queue_claim',{request_id:id},{...value,claim:{...value.claim,eligibility:{...value.claim.eligibility,send_authorized:true}}},now),null);
});
