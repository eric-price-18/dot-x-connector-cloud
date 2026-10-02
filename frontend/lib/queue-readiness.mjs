import {normalizeQueueResponse} from './queue-response.mjs';
import {validateQueueArguments} from './queue-contract.mjs';
import {replyQueueProcessorHandoff} from './queue-processor.mjs';
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);

// Owner-side orchestration helper only. No scheduler, callback, credential or
// publication runs here. Inputs must be the exact sequence of fresh tool calls.
// A caller must refresh before/after any scheduler mutation: a queue generation
// does not freeze time, budgets, grants or confirmed-send spacing.
export function aggregateQueueReadiness(pages) {
 if(!Array.isArray(pages)||!pages.length)throw Error('READINESS_SCAN_REQUIRED');
 let after,account,generation,nextWake=null,last;
 for(const [index,page] of pages.entries()) {
  if(!page||!validateQueueArguments('x_reply_queue_readiness',page.arguments).ok
   ||!same(page.arguments.after,after))throw Error('READINESS_CURSOR_MISMATCH');
  const {safe_to_retry,...raw}=page.value??{};
  if(safe_to_retry!==false)throw Error('VALIDATED_READINESS_REQUIRED');
  const value=normalizeQueueResponse('x_reply_queue_readiness',page.arguments,raw);
  if(!value||value.restart_required)throw Error('READINESS_RESTART_REQUIRED');
  account??=value.account_id;generation??=value.queue_generation;
  if(account!==value.account_id||generation!==value.queue_generation)throw Error('READINESS_RESTART_REQUIRED');
  if(index<pages.length-1&&value.scan_complete)throw Error('READINESS_EXTRA_PAGE');
  if(value.page_candidate_wake_at!==null&&(nextWake===null||value.page_candidate_wake_at<nextWake))nextWake=value.page_candidate_wake_at;
  after=value.next_after;last=value;
 }
 if(!last.scan_complete||after!==null)return {complete:false,queue_generation:generation,next_after:after,processor_handoff:null,scheduled:false};
 const complete={...last,readiness_complete:true,next_wake_at:nextWake};
 return {complete:true,account_id:account,queue_generation:generation,observed_at:last.observed_at,
  next_wake_at:nextWake,processor_handoff:replyQueueProcessorHandoff(complete),scheduled:false};
}
