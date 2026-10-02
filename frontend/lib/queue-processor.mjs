// Pure desired-state handshake for the owner's separate queue processor.
// No scheduling API, timer, callback, credential, discovery or publishing here.
export const REPLY_QUEUE_PROCESSOR_INTERVAL_SECONDS=900;
const stateId=(key,generation,action)=>`${key}:generation:${generation}:${action}:interval:${REPLY_QUEUE_PROCESSOR_INTERVAL_SECONDS}`;
const validGeneration=value=>Number.isSafeInteger(value)&&value>=0;
const validTime=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(Date.parse(value)).toISOString()===value;

export function replyQueueProcessorHandoff(status) {
  if(status?.version!==1||typeof status.account_id!=='string'||!/^[1-9][0-9]{0,18}$/.test(status.account_id)
    ||status.wake_key!==`reply-queue:${status.account_id}`||typeof status.readiness_complete!=='boolean'
    ||typeof status.scan_complete!=='boolean'||typeof status.restart_required!=='boolean'||!validGeneration(status.queue_generation))
    throw Error('INVALID_QUEUE_PROCESSOR_STATUS');
  const at=status.next_wake_at;
  if(at!==null&&!validTime(at))
    throw Error('INVALID_QUEUE_PROCESSOR_TIME');
  const complete=status.readiness_complete;
  if(complete&&(!status.scan_complete||status.restart_required||status.next_after!==null))
    throw Error('INVALID_QUEUE_PROCESSOR_COMPLETENESS');
  const needed=complete?at!==null:null;
  const key=`reply-queue-processor:${status.account_id}`,action=needed===null?'continue_scan':needed?'enable':'pause';
  return {version:1,task_key:key,queue_generation:status.queue_generation,
    desired_state_id:complete?stateId(key,status.queue_generation,action):null,
    schedule_needed:needed,action,
    interval_seconds:REPLY_QUEUE_PROCESSOR_INTERVAL_SECONDS,next_wake_at:complete?at:null,
    scheduled:false,registration_acknowledgement_required:true,
    requires:'authenticated_owner_client_15_minute_scheduler',
    on_tick:'refresh_eligibility_expiry_caps_and_claim_then_fresh_model_review',
    publish_requires:'separate_trusted_model_approval_bridge',
    ...(!complete?{next_after:status.next_after,restart_required:status.restart_required}:{})};
}

// A trusted owner client supplies fresh backend readiness and a fresh, uniquely
// identified scheduler observation. This function cannot verify their freshness
// or perform the returned action. Re-read both after every platform mutation.
export function reconcileReplyQueueProcessor(desired,actual,priorAcknowledgement=null) {
  const needed=desired?.schedule_needed;
  if(desired?.version!==1||typeof desired.task_key!=='string'||!/^reply-queue-processor:[1-9][0-9]{0,18}$/.test(desired.task_key)
    ||!validGeneration(desired.queue_generation)||desired.interval_seconds!==REPLY_QUEUE_PROCESSOR_INTERVAL_SECONDS
    ||desired.scheduled!==false||desired.registration_acknowledgement_required!==true
    ||![true,false,null].includes(needed)
    ||(needed===true?!validTime(desired.next_wake_at):desired.next_wake_at!==null)
    ||desired.action!==(needed===null?'continue_scan':needed?'enable':'pause')
    ||desired.desired_state_id!==(needed===null?null:stateId(desired.task_key,desired.queue_generation,desired.action)))
    throw Error('INVALID_QUEUE_PROCESSOR_DESIRED_STATE');
  const plan=(action,task_id=null,acknowledgement=null,priorValid=false)=>({version:1,action,
    task_key:desired.task_key,queue_generation:desired.queue_generation,desired_state_id:desired.desired_state_id,
    task_id,scheduled:false,acknowledgement,prior_acknowledgement_valid:priorValid});
  if(needed===null)return plan('continue_scan');
  if(!actual||actual.task_key!==desired.task_key||!['present','missing','unknown'].includes(actual.state))
    throw Error('INVALID_QUEUE_PROCESSOR_OBSERVATION');
  // A timeout/ambiguous lookup is not proof of absence and cannot authorize
  // creating another processor or reusing an old acknowledgement.
  if(actual.state==='unknown')return plan('inspect_scheduler');
  if(actual.state==='missing')return plan(needed?'enable':'none');
  if(typeof actual.task_id!=='string'||!actual.task_id.length||actual.task_id.length>512
    ||typeof actual.is_enabled!=='boolean'||!Number.isSafeInteger(actual.interval_seconds)||actual.interval_seconds<=0
    ||!['exact_schedule','flexible_schedule','condition_watch'].includes(actual.timing_mode))
    throw Error('INVALID_QUEUE_PROCESSOR_OBSERVATION');
  if(needed&&(!actual.is_enabled||actual.interval_seconds!==REPLY_QUEUE_PROCESSOR_INTERVAL_SECONDS||actual.timing_mode!=='exact_schedule'))
    return plan('enable',actual.task_id);
  if(!needed&&actual.is_enabled)return plan('pause',actual.task_id);
  // A paused task's historical cadence does not authorize future processing.
  // The next enable still requires the exact 900-second schedule above.
  const acknowledgement={version:1,task_key:desired.task_key,task_id:actual.task_id,
    desired_state_id:desired.desired_state_id,queue_generation:desired.queue_generation,
    is_enabled:actual.is_enabled,interval_seconds:actual.interval_seconds,timing_mode:actual.timing_mode};
  const valid=!!priorAcknowledgement&&Object.keys(acknowledgement).every(key=>priorAcknowledgement[key]===acknowledgement[key]);
  return plan(valid?'none':'acknowledge_current',actual.task_id,acknowledgement,valid);
}
