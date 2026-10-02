import { ownerIdentity, fixedServiceRequest, SERVICE_BRIDGE_ENABLED } from './service-key.mjs';
const ENDPOINT='https://backend.example.invalid/service/mcp';
const NAMES=new Set(['x_connection_status','x_read_mentions','x_read_posts']);
const MAX_BYTES=65536;
const fail=(status,reason)=>({ok:false,status,reason});
const isObject=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exactKeys=(v,keys)=>Object.keys(v).every(k=>keys.includes(k));
const iso=v=>typeof v==='string'&&v.length<=40&&/^\d{4}-\d{2}-\d{2}T/.test(v)&&Number.isFinite(Date.parse(v));
function normalize(name,value){
 if(!isObject(value))return null;
 if(name==='x_connection_status'){
  const keys=['linked','reconnect_required','polling_enabled','post_enabled','reply_enabled'];
  if(!exactKeys(value,keys)||!keys.every(k=>typeof value[k]==='boolean'))return null;
  return Object.fromEntries(keys.map(k=>[k,value[k]]));
 }
 if(!exactKeys(value,['records','fetched_at','stale','pending_pages'])||!Array.isArray(value.records)||value.records.length>20||!(value.fetched_at===null||iso(value.fetched_at))||typeof value.stale!=='boolean'||typeof value.pending_pages!=='boolean')return null;
 const records=[];
 for(const row of value.records){
  if(!isObject(row)||!exactKeys(row,['id','text','author_id','created_at'])||typeof row.id!=='string'||row.id.length<1||row.id.length>128||typeof row.text!=='string'||row.text.length>10000||('author_id'in row&&(typeof row.author_id!=='string'||row.author_id.length>128))||('created_at'in row&&!iso(row.created_at)))return null;
  records.push({id:row.id,text:row.text,...('author_id'in row?{author_id:row.author_id}:{}),...('created_at'in row?{created_at:row.created_at}:{})});
 }
 return {records,fetched_at:value.fetched_at,stale:value.stale,pending_pages:value.pending_pages};
}
async function readBounded(response){
 if(!response.headers.get('content-type')?.toLowerCase().startsWith('application/json'))throw Error('format');
 if(Number(response.headers.get('content-length'))>MAX_BYTES)throw Error('size');
 const reader=response.body?.getReader();if(!reader)throw Error('empty');
 const chunks=[];let size=0;
 while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_BYTES){await reader.cancel();throw Error('size');}chunks.push(value);}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
 return JSON.parse(new TextDecoder().decode(bytes));
}
// Production proofs are per-request and bound to the exact body, never cached.
export function createServiceAdapter({db,fetchImpl=globalThis.fetch,timeoutMs=8000}={}){
 return {async call(identityHeaders,name,args={}){
  if(!ownerIdentity(identityHeaders))return fail(403,'owner_identity_required');
  if(!NAMES.has(name)||!isObject(args)||Object.keys(args).length)return fail(400,'invalid_tool_request');
  if(!SERVICE_BRIDGE_ENABLED||!db)return fail(503,'backend_service_authorization_required');
  const controller=new AbortController();let timer;
  const work=(async()=>{
   let proof;try{proof=await fixedServiceRequest(identityHeaders,db,name);}catch{return fail(503,'service_authentication_unavailable');}
   if(controller.signal.aborted)return fail(503,'upstream_timeout');
   let response;
   try{response=await fetchImpl(ENDPOINT,{method:'POST',redirect:'manual',signal:controller.signal,headers:{'Content-Type':'application/json','Accept':'application/json, text/event-stream','MCP-Protocol-Version':'2025-11-25','Authorization':proof.authorization},body:proof.body});}catch(e){const message=typeof e?.message==='string'?e.message:'';const category=/illegal invocation/i.test(message)?'illegal_invocation':/redirect/i.test(message)?'redirect':/1042/.test(message)?'worker_routing_1042':/network|DNS|connect/i.test(message)?'network':e?.name==='AbortError'?'abort':e?.name==='TypeError'?'type_error':'fetch_error';return fail(503,'upstream_'+category);}
   if(response.status===401||response.status===403)return fail(response.status,'upstream_authorization_denied');
   // workerd does not support redirect:error. Manual guarantees proofs are never forwarded.
   if(response.status>=300&&response.status<400)return fail(503,'upstream_redirect_rejected');
   if(response.status!==200)return fail(503,'upstream_http_'+response.status);
   try{
    const body=await readBounded(response);
    if(!isObject(body)||body.jsonrpc!=='2.0'||body.id!==1)return fail(502,'invalid_upstream_response');
    if(body.error)return fail(503,'upstream_tool_error');
    if(body.result?.isError===true){
     const content=body.result.content;
     const missingCache=name!=='x_connection_status'&&Array.isArray(content)&&content.length===1&&content[0]?.type==='text'&&content[0].text==='D1_BINDING_REQUIRED';
     return fail(503,missingCache?'backend_cache_not_configured':'upstream_tool_error');
    }
    if(!isObject(body.result))return fail(502,'invalid_upstream_response');
    let raw=body.result.structuredContent;
    if(raw===undefined){const content=body.result.content;if(!Array.isArray(content)||content.length!==1||content[0]?.type!=='text'||typeof content[0].text!=='string')return fail(502,'invalid_upstream_response');raw=JSON.parse(content[0].text);}
    const value=normalize(name,raw);if(!value)return fail(502,'invalid_upstream_response');
    return {ok:true,status:200,value};
   }catch{return fail(502,'invalid_upstream_response');}
  })();
  try{return await Promise.race([work,new Promise(resolve=>{timer=setTimeout(()=>{controller.abort();resolve(fail(503,'upstream_timeout'));},timeoutMs);})]);}finally{clearTimeout(timer);}
 }};
}
