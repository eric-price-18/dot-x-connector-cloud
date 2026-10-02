import {z} from 'zod';
import {UUID_V4, POST_ID} from './write-contract.mjs';
import {QUEUE_LIMITS, QUEUE_MUTATIONS} from './queue-contract.mjs';

const uuid = z.string().regex(UUID_V4), post = z.string().regex(POST_ID);
const generation = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const epoch = generation.max(253402300799);
const time = z.string().max(24).refine(value => Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value);
const nullableTime = time.nullable();
const reason = z.string().max(128).refine(value => [...value].length <= 64).nullable();
const safety = {version:z.literal(1),approval_required:z.literal(true),send_authorized:z.literal(false)};
const states = ['pending','blocked','approved','dispatching','sent','unknown','cancelled'];
const cursor = z.object({created_at:epoch,target_id:post}).strict();
const readinessCursor = cursor.extend({generation}).strict();
const claimCursor = z.object({fair_at:epoch,source_created_at:epoch,target_id:post,generation}).strict();
const item = z.object({target_id:post,author_id:post,root_id:post,state:z.enum(states),intent_key:uuid,
 intent_ref:z.string().max(55),receipt_ref:z.string().max(50),reason,due_at:nullableTime,
 source_created_at:epoch,expires_at:time,revision:generation}).strict();
const claim = item.extend({context_ref:z.string().max(512),context_is_untrusted:z.literal(true),draft_present:z.boolean(),
 claim_token:uuid,claim_until:time,approval_required:z.literal(true),send_authorized:z.literal(false),
 review_only:z.boolean(),eligibility:z.object({eligible_at:nullableTime,reason:z.string().max(128)}).strict()}).strict();
const candidate = z.object({target_id:post,eligible_at:nullableTime,reason}).strict();
const wake = z.union([
 z.object({version:z.literal(1),action:z.enum(['cancel','replace_once']),replace_key:z.string().max(31),wake_at:nullableTime,
  scheduled:z.literal(false),requires:z.literal('authenticated_owner_client_one_shot_scheduler'),on_wake:z.literal('refresh_queue_and_revalidate_one_item')}).strict(),
 z.object({version:z.literal(1),action:z.literal('continue_scan'),replace_key:z.string().max(31),wake_at:z.null(),scheduled:z.literal(false),
  requires:z.literal('complete_queue_readiness_scan'),next_after:readinessCursor.nullable(),restart_required:z.boolean()}).strict()
]);
const processor = z.object({version:z.literal(1),task_key:z.string().max(41),queue_generation:generation,desired_state_id:z.string().max(128).nullable(),
 schedule_needed:z.boolean().nullable(),action:z.enum(['enable','pause','continue_scan']),interval_seconds:z.literal(900),next_wake_at:nullableTime,
 scheduled:z.literal(false),registration_acknowledgement_required:z.literal(true),requires:z.literal('authenticated_owner_client_15_minute_scheduler'),
 on_tick:z.literal('refresh_eligibility_expiry_caps_and_claim_then_fresh_model_review'),publish_requires:z.literal('separate_trusted_model_approval_bridge'),
 next_after:readinessCursor.nullable().optional(),restart_required:z.boolean().optional()}).strict();
const readinessShape = {...safety,account_id:post,observed_at:time,next_wake_at:nullableTime,wake_key:z.string().max(31),
 readiness_complete:z.boolean(),scan_complete:z.boolean(),restart_required:z.boolean(),queue_generation:generation,
 next_after:readinessCursor.nullable(),page_candidate_wake_at:nullableTime,scan_limit:z.literal(2),
 counts:z.object(Object.fromEntries(states.map(state => [state,generation.optional()]))).strict(),receipt_required:z.boolean(),
 claim_until:nullableTime,candidates:z.array(candidate).max(2),wake_handoff:wake,processor_handoff:processor};
const readiness = z.object(readinessShape).strict();
const common = {request_id:uuid,request_state:z.literal('completed'),...safety,account_id:post};
const mutation = {...common,replayed:z.boolean(),result_at:time};
const decision = {request_id:uuid,request_state:z.literal('completed'),replayed:z.boolean(),result_at:time,version:z.literal(1),account_id:post,item};
const publishBinding = z.object({target_id:post,intent_key:uuid,claim_token:uuid,expected_revision:generation}).strict();
const receiptBase = {idempotency_key:uuid,receipt_ref:z.string().max(50)};
const sentReceipt = z.object({...receiptBase,state:z.literal('sent'),post_id:post}).strict();
const unknownReceipt = z.object({...receiptBase,state:z.literal('unknown')}).strict();
const rejectedReceipt = z.object({...receiptBase,state:z.literal('rejected'),dispatched:z.boolean(),code:z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)}).strict();
const publish = (outcome,published,receipt,next_operation='x_reply_queue_readiness') => z.object({...decision,
 outcome:z.literal(outcome),published:z.literal(published),receipt,next_operation:z.literal(next_operation)}).strict();
const schemas = {
 x_reply_queue_ingest:z.object({...mutation,items:z.array(item).max(2),readiness}).strict(),
 x_reply_queue_list:z.object({...common,observed_at:time,items:z.array(item).max(50),next_after:cursor.nullable(),has_more:z.boolean()}).strict(),
 x_reply_queue_claim:z.object({...mutation,claim:claim.nullable(),reason:z.enum(['account_not_claimable','restart_scan','model_review_required','operational_hold_review_only','no_due_item','continue_scan']),
  scan_complete:z.boolean(),next_after:claimCursor.nullable(),restart_required:z.literal(true).optional(),queue_generation:generation.optional()}).strict(),
 x_reply_queue_reconcile:z.object({...mutation,item,readiness}).strict(),
 x_reply_queue_readiness:z.object({...common,...readinessShape}).strict(),
 x_reply_queue_approve:z.object({...decision,approved_revision:generation,claim_token:uuid,claim_until:time,approval_expires_at:time,
  publish_binding:publishBinding,next_operation:z.literal('x_reply_queue_publish'),published:z.literal(false)}).strict(),
 x_reply_queue_cancel:z.object({...decision,outcome:z.literal('cancelled'),author_opt_out_recorded:z.boolean(),published:z.literal(false),
  next_operation:z.literal('x_reply_queue_readiness')}).strict(),
 x_reply_queue_publish:z.union([publish('deferred',false,z.null()),publish('cancelled',false,z.null()),publish('sent',true,sentReceipt),
  publish('unknown',false,unknownReceipt,'x_reply_queue_reconcile'),publish('cancelled',false,rejectedReceipt),publish('blocked',false,rejectedReceipt)])
};
const indeterminate = z.object({...safety,request_id:uuid,request_state:z.literal('indeterminate'),replayed:z.literal(true),
 recovery:z.literal('refresh_readiness_and_wait_for_any_review_lease_to_expire')}).strict();
const publishIndeterminate = indeterminate.extend({recovery:z.literal('reconcile_original_intent_do_not_resend'),intent_key:uuid}).strict();
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const validItem = value => value.intent_ref === `reply-queue-intent:${value.intent_key}` && value.receipt_ref === `service-write:${value.intent_key}`;

function validReadiness(value) {
 const complete = value.readiness_complete, next = value.next_after, wake = value.wake_handoff, processor = value.processor_handoff;
 if (value.wake_key !== `reply-queue:${value.account_id}` || wake.replace_key !== value.wake_key) return false;
 if (next && next.generation !== value.queue_generation) return false;
 if (value.restart_required && (complete || value.scan_complete || next !== null || value.page_candidate_wake_at !== null)) return false;
 if (value.scan_complete && next !== null) return false;
 if (complete && (!value.scan_complete || value.restart_required || value.next_wake_at !== value.page_candidate_wake_at)) return false;
 if (!complete && value.next_wake_at !== null) return false;
 const needed = complete ? value.next_wake_at !== null : null;
 const action = needed === null ? 'continue_scan' : needed ? 'enable' : 'pause';
 const task = `reply-queue-processor:${value.account_id}`;
 if (processor.task_key !== task || processor.queue_generation !== value.queue_generation || processor.action !== action
  || processor.schedule_needed !== needed || processor.next_wake_at !== value.next_wake_at
  || processor.desired_state_id !== (complete ? `${task}:generation:${value.queue_generation}:${action}:interval:900` : null)) return false;
 if (complete) return !Object.hasOwn(processor,'next_after') && !Object.hasOwn(processor,'restart_required')
  && wake.action === (needed ? 'replace_once' : 'cancel') && wake.wake_at === value.next_wake_at;
 return wake.action === 'continue_scan' && same(wake.next_after,next) && wake.restart_required === value.restart_required
  && same(processor.next_after,next) && processor.restart_required === value.restart_required;
}

// Validate before exposing any upstream text. Unknown fields (including tokens,
// supplied receipts or scheduler acknowledgements) fail closed without leaking.
export function normalizeQueueResponse(name, args, value, now = Math.floor(Date.now()/1000)) {
 try {
  if (new TextEncoder().encode(JSON.stringify(value)).length > QUEUE_LIMITS.result_utf8_bytes) return null;
  if (value?.request_id !== args.request_id) return null;
  if (value.request_state === 'indeterminate') {
   if (!QUEUE_MUTATIONS.has(name)) return null;
   if (name === 'x_reply_queue_publish') {
    if (value.intent_key !== args.intent_key) return null;
    return {...publishIndeterminate.parse(value),safe_to_retry:false};
   }
   return {...indeterminate.parse(value),safe_to_retry:false};
  }
  const parsed = schemas[name]?.parse(value);
  if (!parsed) return null;
  const status = name === 'x_reply_queue_readiness' ? parsed : parsed.readiness;
  if (status && (status.account_id !== parsed.account_id || !validReadiness(status))) return null;
  if (name === 'x_reply_queue_readiness' && args.after && parsed.readiness_complete) return null;
  const items = parsed.items ?? (parsed.item ? [parsed.item] : parsed.claim ? [parsed.claim] : []);
  if (!items.every(validItem) || new Set(items.map(item => item.target_id)).size !== items.length) return null;
  if (name === 'x_reply_queue_ingest' && (items.length !== new Set(args.records.map(record => record.target_id)).size
   || !items.every(item => args.records.some(record => ['target_id','author_id','root_id','source_created_at'].every(key => item[key] === record[key]))))) return null;
  if (name === 'x_reply_queue_list' && (items.length > (args.limit ?? 50) || parsed.has_more !== (parsed.next_after !== null))) return null;
  if (name === 'x_reply_queue_reconcile' && parsed.item.intent_key !== args.intent_key) return null;
  if (['x_reply_queue_approve','x_reply_queue_publish','x_reply_queue_cancel'].includes(name)) {
   if (parsed.item.intent_key !== args.intent_key || parsed.item.target_id !== args.target_id) return null;
   if (name === 'x_reply_queue_approve') {
    if (parsed.item.state !== 'approved' || parsed.claim_token !== args.claim_token
     || parsed.approved_revision !== parsed.item.revision || parsed.approved_revision <= args.expected_revision
     || !same(parsed.publish_binding,{target_id:args.target_id,intent_key:args.intent_key,claim_token:args.claim_token,expected_revision:parsed.approved_revision})
     || Date.parse(parsed.approval_expires_at) > Math.min(Date.parse(parsed.item.expires_at),Date.parse(parsed.claim_until),(args.rechecked_at+QUEUE_LIMITS.approval_max_age_seconds)*1000)) return null;
    return {...parsed,safe_to_retry:false,approval_valid:Date.parse(parsed.approval_expires_at)>now*1000
     && Date.parse(parsed.claim_until)>now*1000 && Date.parse(parsed.item.expires_at)>now*1000};
   }
   if (name === 'x_reply_queue_cancel' && (parsed.item.state !== 'cancelled' || parsed.author_opt_out_recorded !== (args.reason === 'explicit_stop'))) return null;
   if (name === 'x_reply_queue_publish') {
    const allowedStates={deferred:['pending','blocked','approved'],sent:['sent'],cancelled:['cancelled'],blocked:['blocked'],unknown:['unknown','dispatching']};
    if (!allowedStates[parsed.outcome].includes(parsed.item.state)) return null;
    if (parsed.receipt && (parsed.receipt.idempotency_key !== args.intent_key || parsed.receipt.receipt_ref !== parsed.item.receipt_ref)) return null;
   }
  }
  if (name === 'x_reply_queue_claim') {
   if ((parsed.claim !== null) !== ['model_review_required','operational_hold_review_only'].includes(parsed.reason)) return null;
   if (parsed.claim && parsed.claim.review_only !== (parsed.reason === 'operational_hold_review_only')) return null;
   if (parsed.claim && (!['pending','blocked','approved'].includes(parsed.claim.state) || parsed.restart_required)) return null;
   if (parsed.reason === 'restart_scan' && (!parsed.restart_required || parsed.scan_complete || parsed.next_after !== null)) return null;
   if (parsed.next_after && parsed.next_after.generation !== parsed.queue_generation) return null;
   if (parsed.scan_complete && parsed.next_after !== null) return null;
   return {...parsed,safe_to_retry:false,review_lease_valid:!!parsed.claim
    && Date.parse(parsed.claim.claim_until) > now*1000 && Date.parse(parsed.claim.expires_at) > now*1000};
  }
  return {...parsed,safe_to_retry:false};
 } catch {return null;}
}
