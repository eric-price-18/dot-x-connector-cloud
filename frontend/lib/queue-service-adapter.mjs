import {ownerIdentity} from './service-key.mjs';
import {UUID_V4} from './write-contract.mjs';
import {fixedQueueRequest} from './queue-service-key.mjs';
import {QUEUE_ENDPOINT, QUEUE_LIMITS, QUEUE_MUTATIONS, queueEnabled, validateQueueArguments} from './queue-contract.mjs';
import {normalizeQueueResponse} from './queue-response.mjs';
export const DEFAULT_QUEUE_TIMEOUT_MS = 8000;
export const DEFAULT_QUEUE_PUBLISH_TIMEOUT_MS = 30000;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

async function readBounded(response) {
 if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json'
  || Number(response.headers.get('content-length')) > QUEUE_LIMITS.wire_utf8_bytes) throw Error('format');
 const reader = response.body?.getReader(); if (!reader) throw Error('empty');
 const chunks = []; let size = 0;
 while (true) {
  const {done,value} = await reader.read(); if (done) break;
  size += value.byteLength;
  if (size > QUEUE_LIMITS.wire_utf8_bytes) {await reader.cancel(); throw Error('size');}
  chunks.push(value);
 }
 const bytes = new Uint8Array(size); let at = 0;
 for (const chunk of chunks) {bytes.set(chunk,at);at += chunk.length;}
 return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
}

// Exactly one fixed request; never retries, follows redirects, initializes a key,
// contacts X directly, or turns transport success into approval/send authority.
export function createQueueAdapter({db,env = {},fetchImpl = globalThis.fetch,timeoutMs} = {}) {
 return {async call(headers,name,args) {
  const requestId = typeof args?.request_id === 'string' && UUID_V4.test(args.request_id) ? args.request_id : null;
  const fail = (status,reason,uncertain = false) => ({ok:false,status,reason,safe_to_retry:false,
   value:{available:false,reason,operation:name,request_id:requestId,safe_to_retry:false,approval_required:true,send_authorized:false,
    ...(uncertain ? {request_state:'indeterminate',...(name === 'x_reply_queue_publish'
     ? {intent_key:args.intent_key,recovery:'reconcile_original_intent_do_not_resend'}
     : {recovery:'refresh_readiness_and_wait_for_any_review_lease_to_expire'})} : {})}});
  if (!ownerIdentity(headers)) return fail(403,'owner_identity_required');
  const checked = validateQueueArguments(name,args);
  if (!checked.ok) return fail(400,checked.reason);
  if (!queueEnabled(name,env)) return fail(503,'reply_queue_disabled');
  if (!db) return fail(503,'service_authentication_unavailable');
  let dispatched = false, timer; const controller = new AbortController();
  const uncertain = reason => fail(503,reason,QUEUE_MUTATIONS.has(name));
  const work = (async () => {
   let proof;
   try {proof = await fixedQueueRequest(headers,db,name,checked.args,env);} catch {return fail(503,'service_authentication_unavailable');}
   if (controller.signal.aborted) return fail(503,'request_not_dispatched');
   let response;
   try {
    dispatched = true;
    response = await fetchImpl(QUEUE_ENDPOINT,{method:'POST',redirect:'manual',signal:controller.signal,
     headers:{'Content-Type':'application/json','Accept':'application/json, text/event-stream','MCP-Protocol-Version':'2025-11-25','Authorization':proof.authorization},body:proof.body});
   } catch {return uncertain('queue_outcome_unknown');}
   if (response.status !== 200) return uncertain('queue_outcome_unknown');
   try {
    const payload = await readBounded(response);
    if (!object(payload) || payload.jsonrpc !== '2.0' || payload.id !== 1 || payload.error || !object(payload.result)
     || payload.result.isError === true) return uncertain('invalid_queue_response');
    const value = normalizeQueueResponse(name,checked.args,payload.result.structuredContent);
    if (!value) return uncertain('invalid_queue_response');
    return {ok:value.request_state === 'completed',status:200,value,safe_to_retry:false};
   } catch {return uncertain('invalid_queue_response');}
  })();
  try {
   return await Promise.race([work,new Promise(resolve => {timer = setTimeout(() => {
    controller.abort(); resolve(dispatched ? uncertain('queue_outcome_unknown') : fail(503,'request_not_dispatched'));
   },timeoutMs ?? (name === 'x_reply_queue_publish' ? DEFAULT_QUEUE_PUBLISH_TIMEOUT_MS : DEFAULT_QUEUE_TIMEOUT_MS));})]);
  } finally {clearTimeout(timer);}
 }};
}
