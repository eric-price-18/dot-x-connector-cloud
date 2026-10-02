import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {setupQueueRuntime,BASE_NOW} from '../fixtures/queue-runtime.mjs';
if(!process.env.BACKEND_CANDIDATE_PATH)throw Error('Set BACKEND_CANDIDATE_PATH to the final reviewed send backend');
const backend=path.resolve(process.env.BACKEND_CANDIDATE_PATH);
const {QUEUE_TOOLS}=await import(pathToFileURL(path.join(backend,'src/reply-queue-policy.mjs')).href);
for(const name of ['x_reply_queue_approve','x_reply_queue_publish','x_reply_queue_cancel'])if(!QUEUE_TOOLS.some(tool=>tool.name===name))throw Error(`Final send backend required: ${name} is absent`);
const record=(target,author='5050',root='1000')=>({target_id:target,author_id:author,root_id:root,source_created_at:BASE_NOW,context_ref:'synthetic:browser:'+target});
const held=claim=>({target_id:claim.target_id,intent_key:claim.intent_key,claim_token:claim.claim_token,expected_revision:claim.revision});
const review=(claim,now,text='A fresh useful browser-reviewed reply.')=>({...held(claim),text,context_ref:'synthetic:fresh:'+claim.target_id,rechecked_at:now,conversation_checked:true,value_checked:true,stop_checked:true});

test('actual paired send path approves stored text, publishes one exact POST and replays without duplicate dispatch',async()=>{
 const sent=[];const h=await setupQueueRuntime(backend,{onProvider:async request=>{assert.equal(request.url,'https://api.x.com/2/tweets');assert.equal(request.method,'POST');const body=await request.json();sent.push(body);return Response.json({data:{id:String(9000+sent.length)}},{status:201});}});
 try {
  await h.call('ingest',{records:[record('1002'),record('1003','6060','1001')]});const claim=(await h.call('claim')).claim;
  const approved=await h.call('approve',review(claim,h.now));assert.equal(approved.approval_valid,true);assert.equal(approved.published,false);assert.equal(h.providerCalls,0);
  const args={request_id:crypto.randomUUID(),...approved.publish_binding};const result=await h.call('publish',args);assert.equal(result.outcome,'sent');assert.equal(result.published,true);assert.equal(result.receipt.idempotency_key,claim.intent_key);assert.equal(h.providerCalls,1);
  assert.deepEqual(sent,[{text:'A fresh useful browser-reviewed reply.',reply:{in_reply_to_tweet_id:'1002'}}]);
  const replay=await h.call('publish',args);assert.equal(replay.replayed,true);assert.deepEqual(replay.receipt,result.receipt);assert.equal(h.providerCalls,1);
  const heldForReview=(await h.call('claim')).claim;if(heldForReview)assert.equal(heldForReview.review_only,true);h.setNow(h.now+900);const second=(await h.call('claim')).claim;assert.equal(second.target_id,'1003');
  const a2=await h.call('approve',review(second,h.now,'A separate useful response.'));assert.equal((await h.call('publish',a2.publish_binding)).outcome,'sent');assert.equal(h.providerCalls,2);
  assert.equal((await h.call('readiness')).processor_handoff.action,'pause');
 }finally{await h.close();}
});
test('replacement claims cannot inherit send authority and explicit STOP cancels unsent same-author work',async()=>{
 const h=await setupQueueRuntime(backend);
 try {
  await h.call('ingest',{records:[record('1102'),record('1103')]});const claim=(await h.call('claim')).claim;h.setNow(h.now+119);
  const approved=await h.call('approve',review(claim,h.now));h.setNow(h.now+1);const replacement=(await h.call('claim')).claim;assert.ok(replacement);assert.notEqual(replacement.claim_token,claim.claim_token);
  const stale=await h.call('publish',approved.publish_binding,false);assert.equal(stale.envelope.result.isError,true);assert.equal(h.providerCalls,0);
  const unreviewed=await h.call('publish',held(replacement),false);assert.equal(unreviewed.envelope.result.isError,true);assert.equal(h.providerCalls,0);
  const cancelled=await h.call('cancel',{...held(replacement),reason:'explicit_stop'});assert.equal(cancelled.author_opt_out_recorded,true);assert.equal(cancelled.item.state,'cancelled');
  const items=(await h.call('list')).items;assert.ok(items.every(item=>item.state==='cancelled'));assert.equal((await h.call('readiness')).processor_handoff.action,'pause');assert.equal(h.providerCalls,0);
 }finally{await h.close();}
});
test('ambiguous queue send is held for local receipt reconciliation and cannot revive through discovery',async()=>{
 const h=await setupQueueRuntime(backend,{onProvider:async request=>{assert.equal(request.method,'POST');return new Response('synthetic ambiguous upstream',{status:503});}});
 try {
  const input=record('1202');await h.call('ingest',{records:[input]});const claim=(await h.call('claim')).claim;const approved=await h.call('approve',review(claim,h.now));const args={request_id:crypto.randomUUID(),...approved.publish_binding};
  const result=await h.call('publish',args);assert.equal(result.outcome,'unknown');assert.equal(result.published,false);assert.equal(result.next_operation,'x_reply_queue_reconcile');assert.equal(h.providerCalls,1);
  assert.equal((await h.call('publish',args)).replayed,true);assert.equal(h.providerCalls,1);
  const reconciled=await h.call('reconcile',{intent_key:claim.intent_key});assert.equal(reconciled.item.state,'unknown');assert.equal(reconciled.readiness.processor_handoff.action,'pause');
  const rescan=await h.call('ingest',{records:[input]});assert.equal(rescan.items[0].intent_key,claim.intent_key);assert.equal(rescan.items[0].state,'unknown');assert.equal((await h.call('claim')).claim,null);assert.equal(h.providerCalls,1);
 }finally{await h.close();}
});
test('fresh local cooldown after approval defers before transport without consuming a replacement intent',async()=>{
 const h=await setupQueueRuntime(backend);
 try {
  await h.call('ingest',{records:[record('1302')]});const claim=(await h.call('claim')).claim;const approved=await h.call('approve',review(claim,h.now));
  await h.db.prepare("INSERT INTO cooldowns(name,until_at) VALUES('x',?) ON CONFLICT(name) DO UPDATE SET until_at=excluded.until_at").bind(h.now+900).run();
  const result=await h.call('publish',approved.publish_binding);assert.equal(result.outcome,'deferred');assert.equal(result.receipt,null);assert.equal(result.item.intent_key,claim.intent_key);assert.equal(h.providerCalls,0);
  const due=await h.call('readiness');assert.equal(due.processor_handoff.action,'enable');assert.equal(due.next_wake_at,new Date((h.now+900)*1000).toISOString());
 }finally{await h.close();}
});

test('operational budget hold remains review-only and permits cancellation through the exact final claim extension',async()=>{
 const h=await setupQueueRuntime(backend);
 try {
  await h.call('ingest',{records:[record('1402')]});const claim=(await h.call('claim')).claim;
  assert.equal(claim.review_only,false);assert.equal(claim.eligibility.reason,'ready');
  const approved=await h.call('approve',review(claim,h.now));
  await h.db.prepare('UPDATE ongoing_cycles SET confirmed_used_micro_usd=4999999').run();
  const deferred=await h.call('publish',approved.publish_binding);assert.equal(deferred.outcome,'deferred');assert.equal(deferred.item.due_at,null);
  const heldResult=await h.call('claim');assert.equal(heldResult.reason,'operational_hold_review_only');
  assert.equal(heldResult.claim.review_only,true);assert.equal(heldResult.claim.eligibility.eligible_at,null);assert.equal(heldResult.claim.send_authorized,false);
  assert.equal(heldResult.claim.intent_key,claim.intent_key);assert.equal(heldResult.review_lease_valid,true);
  const cancelled=await h.call('cancel',{...held(heldResult.claim),reason:'no_value'});
  assert.equal(cancelled.item.state,'cancelled');assert.equal(cancelled.author_opt_out_recorded,false);assert.equal(cancelled.item.intent_key,claim.intent_key);
  assert.equal((await h.call('readiness')).processor_handoff.action,'pause');assert.equal(h.providerCalls,0);
  assert.deepEqual((await h.db.prepare('SELECT * FROM reply_queue_intents').all()).results,[]);
 }finally{await h.close();}
});
