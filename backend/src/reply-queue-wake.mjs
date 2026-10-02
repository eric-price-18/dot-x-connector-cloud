// Pure owner/client handoff. No timer, polling, callback, or scheduling credential.
// The authenticated client upserts/cancels ONE durable one-shot by replace_key.
export function replyQueueWakeHandoff(status) {
  if(status?.version!==1||typeof status.account_id!=='string'||status.wake_key!==`reply-queue:${status.account_id}`)
    throw Error('INVALID_QUEUE_WAKE_STATUS');
  const at=status.next_wake_at;
  if(at!==null&&(typeof at!=='string'||!Number.isFinite(Date.parse(at))||new Date(Date.parse(at)).toISOString()!==at))
    throw Error('INVALID_QUEUE_WAKE_TIME');
  return {version:1,action:at===null?'cancel':'replace_once',replace_key:status.wake_key,
    wake_at:at,scheduled:false,requires:'authenticated_owner_client_one_shot_scheduler',
    on_wake:'refresh_queue_and_revalidate_one_item'};
}
