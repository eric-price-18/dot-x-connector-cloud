import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {setupQueueRuntime,BASE_NOW} from '../fixtures/queue-runtime.mjs';
import {discoverQueueTools,validateQueueArguments} from '../../lib/queue-contract.mjs';
if(!process.env.BACKEND_CANDIDATE_PATH)throw Error('Set BACKEND_CANDIDATE_PATH to reviewed backend source');
const backend=path.resolve(process.env.BACKEND_CANDIDATE_PATH);
const {QUEUE_TOOLS,validateQueueArguments:backendValidate}=await import(pathToFileURL(path.join(backend,'src/reply-queue-policy.mjs')).href);
const enabled={X_REPLY_QUEUE_ENABLED:'true',X_REPLY_QUEUE_MUTATIONS_ENABLED:'true',X_REPLY_QUEUE_SEND_ENABLED:'true'};
test('queue frontend input schemas match actual backend operations without new native OAuth scopes',()=>{
 for(const tool of QUEUE_TOOLS){const front=discoverQueueTools(enabled).find(t=>t.name===tool.name);assert.ok(front,tool.name);assert.deepEqual(front.inputSchema,tool.inputSchema);assert.deepEqual(front.annotations,tool.annotations);}
 const args={request_id:crypto.randomUUID(),records:[{target_id:'1002',author_id:'5050',root_id:'1000',source_created_at:BASE_NOW,context_ref:'synthetic:browser'}]};
 assert.deepEqual(backendValidate('x_reply_queue_ingest',args),validateQueueArguments('x_reply_queue_ingest',args).args);
});

test('actual queue frontend/backend workerd preserve dedup, 24h expiry, claims, pagination and honest scheduling',async()=>{
 const h=await setupQueueRuntime(backend);const {call}=h;try{
  const record=(target,author,root)=>({target_id:target,author_id:author,root_id:root,source_created_at:BASE_NOW,context_ref:'synthetic:browser:'+target});
  const records=[record('1002','5050','1000'),record('1003','6060','1001')];
  const first=await call('ingest',{records});assert.equal(first.items.length,2);assert.equal(first.readiness.processor_handoff.schedule_needed,true);assert.equal(first.readiness.processor_handoff.scheduled,false);
  const replayRequest=crypto.randomUUID();const second=await call('ingest',{request_id:replayRequest,records});h.setNow(h.now+1);const replay=await call('ingest',{request_id:replayRequest,records});assert.equal(replay.replayed,true);assert.equal(replay.result_at,second.result_at);assert.deepEqual(replay.items,second.items);
  await call('ingest',{records:[record('1004','7070','1000')]});
  const status=await call('readiness');assert.equal(status.readiness_complete,false);assert.equal(status.processor_handoff.action,'continue_scan');assert.equal(status.processor_handoff.schedule_needed,null);assert.ok(status.next_after);
  const end=await call('readiness',{after:status.next_after});assert.equal(end.scan_complete,true);assert.equal(end.readiness_complete,false);assert.equal(end.processor_handoff.schedule_needed,null);
  const claimed=await call('claim');assert.equal(claimed.claim.target_id,'1002');assert.equal(claimed.review_lease_valid,true);assert.equal(claimed.claim.send_authorized,false);const key=claimed.claim.intent_key;
  assert.equal((await call('claim')).claim,null);
  h.setNow(BASE_NOW+86400);const expired=await call('ingest',{records:[]});assert.equal(expired.readiness.processor_handoff.action,'pause');assert.equal(expired.readiness.processor_handoff.scheduled,false);
  const list=await call('list');assert.equal(list.items.length,3);assert.ok(list.items.every(i=>i.state==='cancelled'&&i.reason==='planned_reply_expired'));assert.equal(list.items.find(i=>i.target_id==='1002').intent_key,key);
  const rescan=await call('ingest',{records});assert.equal(rescan.items[0].intent_key,key);assert.equal(rescan.items[0].expires_at,first.items[0].expires_at);assert.equal(rescan.items[0].state,'cancelled');assert.equal(h.providerCalls,0);assert.ok(h.frontCalls>10);
 }finally{await h.close();}
});
