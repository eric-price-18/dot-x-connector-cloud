import {ownerIdentity} from './service-key.mjs';
import {fixedWriteRequest} from './write-service-key.mjs';
import {WRITE_ENDPOINT, MUTATIONS, writeEnabled, validateConfiguredWriteArguments, normalizeWriteReceipt} from './write-contract.mjs';
const MAX_BYTES = 16384;
export const DEFAULT_WRITE_TIMEOUT_MS = 8000;
export const DEFAULT_REPLY_TIMEOUT_MS = 55000;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (status, reason, extra = {}) => ({ok:false,status,reason,safe_to_retry:false,...extra});

async function readBounded(response) {
 if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json' || Number(response.headers.get('content-length')) > MAX_BYTES) throw Error('format');
 const reader = response.body?.getReader(); if (!reader) throw Error('empty');
 const chunks = []; let size = 0;
 while (true) {
  const {done,value} = await reader.read(); if (done) break;
  size += value.byteLength;
  if (size > MAX_BYTES) {await reader.cancel(); throw Error('size');}
  chunks.push(value);
 }
 const bytes = new Uint8Array(size); let at = 0;
 for (const chunk of chunks) {bytes.set(chunk,at); at += chunk.length;}
 return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
}

// This layer never retries. Only the backend's durable ledger decides whether a key was dispatched.
// The incoming request, signing proof and transport success cannot establish X publication success.
export function createWriteAdapter({db, env = {}, fetchImpl = globalThis.fetch, timeoutMs} = {}) {
 return {async call(headers, name, args) {
  if (!ownerIdentity(headers)) return fail(403,'owner_identity_required');
  const checked = await validateConfiguredWriteArguments(name,args,env);
  if (!checked.ok) return fail(400,checked.reason);
  if (!writeEnabled(name,env)) return fail(503,name === 'x_reply' ? 'own_thread_replies_disabled' : 'write_disabled');
  if (!db) return fail(503,'service_authentication_unavailable');
  const deadlineMs = timeoutMs ?? (name === 'x_reply' ? DEFAULT_REPLY_TIMEOUT_MS : DEFAULT_WRITE_TIMEOUT_MS);
  const mutation = MUTATIONS.has(name);
  let dispatched = false; const controller = new AbortController(); let timer;
  const uncertain = reason => fail(503,reason,mutation ? {value:{version:1,operation:name,idempotency_key:checked.args.idempotency_key,state:'unknown',code:'transport_outcome_unknown',safe_to_retry:false}} : {});
  const work = (async () => {
   let proof;
   try {proof = await fixedWriteRequest(headers,db,name,checked.args,env);} catch {return fail(503,'service_authentication_unavailable');}
   if (controller.signal.aborted) return fail(503,'request_not_dispatched');
   let response;
   try {
    dispatched = true;
    response = await fetchImpl(WRITE_ENDPOINT,{method:'POST',redirect:'manual',signal:controller.signal,headers:{'Content-Type':'application/json','Accept':'application/json, text/event-stream','MCP-Protocol-Version':'2025-11-25','Authorization':proof.authorization},body:proof.body});
   } catch {return uncertain('write_outcome_unknown');}
   // Even an error response could have been returned after the backend's dispatch. Be conservative.
   if (response.status !== 200) return uncertain('write_outcome_unknown');
   try {
    const payload = await readBounded(response);
    if (!object(payload) || payload.jsonrpc !== '2.0' || payload.id !== 1 || payload.error || !object(payload.result)) return uncertain('invalid_write_response');
    const receipt = normalizeWriteReceipt(name,checked.args,payload.result.structuredContent);
    if (!receipt) return uncertain('invalid_write_response');
    if (payload.result.isError === true && receipt.state === 'succeeded') return uncertain('invalid_write_response');
    return {ok:!['unknown','rejected','pending'].includes(receipt.state),status:200,value:receipt,safe_to_retry:false};
   } catch {return uncertain('invalid_write_response');}
  })();
  try {
   return await Promise.race([work,new Promise(resolve => {timer = setTimeout(() => {controller.abort(); resolve(dispatched ? uncertain('write_outcome_unknown') : fail(503,'request_not_dispatched'));},deadlineMs);})]);
  } finally {clearTimeout(timer);}
 }};
}
