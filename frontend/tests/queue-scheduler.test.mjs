import {test} from 'node:test';
import assert from 'node:assert/strict';
import {aggregateQueueReadiness} from '../lib/queue-readiness.mjs';
import {replyQueueProcessorHandoff,reconcileReplyQueueProcessor} from '../lib/queue-processor.mjs';
const at='2026-10-02T20:00:00.000Z',key='reply-queue-processor:4242';
function page({after,scanComplete=true,restart=false,next=null,candidate=at,generation=4}={}){
 const complete=!after&&scanComplete&&!restart;
 const value={request_id:crypto.randomUUID(),request_state:'completed',version:1,approval_required:true,send_authorized:false,account_id:'4242',observed_at:at,next_wake_at:complete?candidate:null,wake_key:'reply-queue:4242',readiness_complete:complete,scan_complete:scanComplete,restart_required:restart,queue_generation:generation,next_after:next,page_candidate_wake_at:candidate,scan_limit:2,counts:{pending:3},receipt_required:false,claim_until:null,candidates:[]};
 value.wake_handoff=complete?{version:1,action:candidate?'replace_once':'cancel',replace_key:value.wake_key,wake_at:candidate,scheduled:false,requires:'authenticated_owner_client_one_shot_scheduler',on_wake:'refresh_queue_and_revalidate_one_item'}:{version:1,action:'continue_scan',replace_key:value.wake_key,wake_at:null,scheduled:false,requires:'complete_queue_readiness_scan',next_after:next,restart_required:restart};
 value.processor_handoff=replyQueueProcessorHandoff(value);value.safe_to_retry=false;
 return {arguments:{request_id:value.request_id,...(after?{after}:{})},value};
}
test('complete scan aggregation never schedules and partial results cannot enable or pause',()=>{
 const cursor={created_at:1790971200,target_id:'1002',generation:4};
 const first=page({scanComplete:false,next:cursor,candidate:null});
 assert.deepEqual(aggregateQueueReadiness([first]),{complete:false,queue_generation:4,next_after:cursor,processor_handoff:null,scheduled:false});
 const next=page({after:cursor,candidate:at});const scan=aggregateQueueReadiness([first,next]);assert.equal(scan.complete,true);assert.equal(scan.scheduled,false);assert.equal(scan.processor_handoff.action,'enable');assert.equal(scan.processor_handoff.scheduled,false);
 assert.equal(aggregateQueueReadiness([page({candidate:null})]).processor_handoff.action,'pause');
 for(const bad of [[next],[first,{...next,arguments:{...next.arguments,after:{...cursor,target_id:'999'}}}],[first,page({after:cursor,generation:5})],[page(),page()],[page({restart:true,scanComplete:false,candidate:null})]])assert.throws(()=>aggregateQueueReadiness(bad));
});
test('actual platform acknowledgment requires exact ID, state, cadence and current desired binding',()=>{
 const desired=aggregateQueueReadiness([page()]).processor_handoff;
 const actual={task_key:key,state:'present',task_id:'real-synthetic-platform-id',is_enabled:true,interval_seconds:900,timing_mode:'exact_schedule'};
 const found=reconcileReplyQueueProcessor(desired,actual);assert.equal(found.action,'acknowledge_current');assert.equal(found.scheduled,false);assert.equal(found.acknowledgement.task_id,actual.task_id);
 assert.equal(reconcileReplyQueueProcessor(desired,actual,found.acknowledgement).action,'none');
 for(const changed of [{is_enabled:false},{interval_seconds:3600},{timing_mode:'flexible_schedule'}])assert.equal(reconcileReplyQueueProcessor(desired,{...actual,...changed},found.acknowledgement).action,'enable');
 assert.equal(reconcileReplyQueueProcessor(desired,{task_key:key,state:'unknown'},found.acknowledgement).action,'inspect_scheduler');
 assert.equal(reconcileReplyQueueProcessor(desired,{task_key:key,state:'missing'},found.acknowledgement).action,'enable');
 const newer=aggregateQueueReadiness([page({generation:5})]).processor_handoff;assert.equal(reconcileReplyQueueProcessor(newer,actual,found.acknowledgement).prior_acknowledgement_valid,false);
 const empty=aggregateQueueReadiness([page({candidate:null})]).processor_handoff;assert.equal(reconcileReplyQueueProcessor(empty,actual).action,'pause');assert.equal(reconcileReplyQueueProcessor(empty,{task_key:key,state:'missing'}).action,'none');
});
