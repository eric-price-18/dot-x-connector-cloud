import test from 'node:test';
import assert from 'node:assert/strict';
import {replyQueueProcessorHandoff,reconcileReplyQueueProcessor} from '../src/reply-queue-processor.mjs';

const at='2035-01-01T00:15:00.000Z';
const status=(changes={})=>({version:1,account_id:'4242',wake_key:'reply-queue:4242',queue_generation:7,
  readiness_complete:true,scan_complete:true,restart_required:false,next_after:null,next_wake_at:at,...changes});
const desired=(changes={})=>replyQueueProcessorHandoff(status(changes));
const actual=(changes={})=>({state:'present',task_key:'reply-queue-processor:4242',task_id:'synthetic-task-1',
  is_enabled:true,interval_seconds:900,timing_mode:'exact_schedule',...changes});

test('processor handshake requests enable or pause deterministically without claiming registration',()=>{
  const enabled=desired();
  assert.deepEqual(enabled,desired());
  assert.equal(enabled.action,'enable');assert.equal(enabled.schedule_needed,true);
  assert.equal(enabled.interval_seconds,900);assert.equal(enabled.next_wake_at,at);
  assert.equal(enabled.task_key,'reply-queue-processor:4242');assert.equal(enabled.queue_generation,7);
  assert.equal(enabled.desired_state_id,'reply-queue-processor:4242:generation:7:enable:interval:900');
  assert.equal(enabled.scheduled,false);assert.equal(enabled.registration_acknowledgement_required,true);
  const paused=desired({next_wake_at:null});
  assert.equal(paused.action,'pause');assert.equal(paused.schedule_needed,false);assert.equal(paused.scheduled,false);
  assert.notEqual(paused.desired_state_id,enabled.desired_state_id); // policy can change without a queue mutation
  assert.notEqual(desired({queue_generation:8}).desired_state_id,enabled.desired_state_id);
  assert.equal(desired({scheduled:true}).scheduled,false);
});
test('partial pages and generation restarts cannot enable, pause, or acknowledge a processor',()=>{
  for(const source of [status({readiness_complete:false,scan_complete:false,next_wake_at:null,next_after:{created_at:1,target_id:'1',generation:7}}),
    status({readiness_complete:false,scan_complete:true,next_wake_at:null}),
    status({readiness_complete:false,scan_complete:false,restart_required:true,next_wake_at:null})]) {
    const handoff=replyQueueProcessorHandoff(source);
    assert.equal(handoff.action,'continue_scan');assert.equal(handoff.schedule_needed,null);assert.equal(handoff.desired_state_id,null);
    assert.equal(handoff.scheduled,false);assert.equal(handoff.restart_required,source.restart_required);
    assert.equal(reconcileReplyQueueProcessor(handoff,null).action,'continue_scan');
  }
  assert.throws(()=>desired({scan_complete:false}),/COMPLETENESS/);
  assert.throws(()=>desired({restart_required:true}),/COMPLETENESS/);
  assert.throws(()=>desired({next_after:{created_at:1,target_id:'1',generation:7}}),/COMPLETENESS/);
  assert.throws(()=>desired({next_wake_at:'tomorrow'}),/TIME/);
  assert.throws(()=>desired({queue_generation:-1}),/STATUS/);
  assert.throws(()=>desired({account_id:'other:4242'}),/STATUS/);
});
test('verified task identity and exact cadence produce a generation-bound acknowledgement',()=>{
  const handoff=desired(),plan=reconcileReplyQueueProcessor(handoff,actual());
  assert.equal(plan.action,'acknowledge_current');assert.equal(plan.scheduled,false);
  assert.deepEqual(plan.acknowledgement,{version:1,task_key:handoff.task_key,task_id:'synthetic-task-1',
    desired_state_id:handoff.desired_state_id,queue_generation:7,is_enabled:true,interval_seconds:900,timing_mode:'exact_schedule'});
  const unchanged=reconcileReplyQueueProcessor(handoff,actual(),plan.acknowledgement);
  assert.equal(unchanged.action,'none');assert.equal(unchanged.prior_acknowledgement_valid,true);
  const changed=reconcileReplyQueueProcessor(desired({queue_generation:8}),actual(),plan.acknowledgement);
  assert.equal(changed.action,'acknowledge_current');assert.equal(changed.prior_acknowledgement_valid,false);
  assert.equal(changed.acknowledgement.queue_generation,8);
});
test('unknown scheduler outcome cannot create a duplicate and a lost task overrides a prior acknowledgement',()=>{
  const handoff=desired(),ack=reconcileReplyQueueProcessor(handoff,actual()).acknowledgement;
  const unknown=reconcileReplyQueueProcessor(handoff,{state:'unknown',task_key:handoff.task_key},ack);
  assert.equal(unknown.action,'inspect_scheduler');assert.equal(unknown.acknowledgement,null);assert.equal(unknown.prior_acknowledgement_valid,false);
  const lost=reconcileReplyQueueProcessor(handoff,{state:'missing',task_key:handoff.task_key},ack);
  assert.equal(lost.action,'enable');assert.equal(lost.task_id,null);assert.equal(lost.acknowledgement,null);
  const paused=reconcileReplyQueueProcessor(desired({next_wake_at:null}),{state:'missing',task_key:handoff.task_key},ack);
  assert.equal(paused.action,'none');assert.equal(paused.prior_acknowledgement_valid,false);assert.equal(paused.acknowledgement,null);
});
test('disabled, wrong cadence and wrong timing mode cannot reuse an enable acknowledgement',()=>{
  const handoff=desired(),ack=reconcileReplyQueueProcessor(handoff,actual()).acknowledgement;
  for(const change of [{is_enabled:false},{interval_seconds:3600},{timing_mode:'condition_watch'}]) {
    const repair=reconcileReplyQueueProcessor(handoff,actual(change),ack);
    assert.equal(repair.action,'enable');assert.equal(repair.task_id,'synthetic-task-1');
    assert.equal(repair.prior_acknowledgement_valid,false);assert.equal(repair.acknowledgement,null);
  }
});
test('fresh observation repairs a delayed old pause after resume and a delayed old enable after pause',()=>{
  const oldPause=desired({queue_generation:7,next_wake_at:null}),resume=desired({queue_generation:8});
  assert.equal(reconcileReplyQueueProcessor(oldPause,actual()).action,'pause');
  const resumeAck=reconcileReplyQueueProcessor(resume,actual()).acknowledgement;
  // The old platform pause arrives after the new state was acknowledged.
  const repair=reconcileReplyQueueProcessor(resume,actual({is_enabled:false}),resumeAck);
  assert.equal(repair.action,'enable');assert.equal(repair.prior_acknowledgement_valid,false);
  assert.equal(repair.desired_state_id,resume.desired_state_id);
  const latestPause=desired({queue_generation:9,next_wake_at:null});
  assert.equal(reconcileReplyQueueProcessor(latestPause,actual(),resumeAck).action,'pause');
  const paused=reconcileReplyQueueProcessor(latestPause,actual({is_enabled:false}),resumeAck);
  assert.equal(paused.action,'acknowledge_current');assert.equal(paused.acknowledgement.is_enabled,false);
  assert.equal(paused.acknowledgement.desired_state_id,latestPause.desired_state_id);
});
test('foreign tasks, malformed observations and altered desired-state identities fail closed',()=>{
  const handoff=desired();
  assert.throws(()=>reconcileReplyQueueProcessor(handoff,actual({task_key:'reply-queue-processor:999'})),/OBSERVATION/);
  assert.throws(()=>reconcileReplyQueueProcessor(handoff,actual({task_id:''})),/OBSERVATION/);
  assert.throws(()=>reconcileReplyQueueProcessor(handoff,undefined),/OBSERVATION/);
  assert.throws(()=>reconcileReplyQueueProcessor({...handoff,desired_state_id:'old'},actual()),/DESIRED_STATE/);
  assert.throws(()=>reconcileReplyQueueProcessor({...handoff,scheduled:true},actual()),/DESIRED_STATE/);
  assert.throws(()=>reconcileReplyQueueProcessor({...handoff,next_wake_at:null},actual()),/DESIRED_STATE/);
  assert.throws(()=>reconcileReplyQueueProcessor({...desired({next_wake_at:null}),next_wake_at:at},actual()),/DESIRED_STATE/);
});
