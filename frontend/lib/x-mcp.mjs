import { readPublicKey, publicInfo, SERVICE_BRIDGE_ENABLED, SITE_ORIGIN } from './service-key.mjs';
import { createServiceAdapter } from './service-adapter.mjs';
import { WRITE_NAMES, discoverWriteTools, writeEnabled } from './write-contract.mjs';
import { createWriteAdapter } from './write-service-adapter.mjs';
// Sites dispatch is the only trusted ingress. Never expose this app outside it.
const OWNER_EMAIL = 'owner@example.invalid';
const MAX_BODY_BYTES = 8192;
const annotations = {readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false};
export const tools = [
 {name:'x_connection_status',description:'Check backend stored X-link state and configured gates. This tool never contacts X and does not verify live-token or publishing readiness.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations},
 ...['x_read_mentions','x_read_posts'].map(name=>({name,description:'Read up to 20 cached X records. Returns an explicit error if cache storage is not configured. Never performs a live X request.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations}))
];
export function authorize(headers) {
 const id=headers.get('oai-authenticated-user-id');
 const email=headers.get('oai-authenticated-user-email');
 if (!id?.trim() || !email?.trim()) return 401;
 return email.trim().toLowerCase()===OWNER_EMAIL ? 200 : 403;
}
const json=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const error=(id,code,message,status=200)=>json({jsonrpc:'2.0',id,error:{code,message}},status);
const result=(id,value)=>json({jsonrpc:'2.0',id,result:value});
export async function handleMcp(request, db, env = {}) {
 if(request.method!=='POST')return json({error:'Method not allowed'},405);
 if(!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))return json({error:'JSON required'},415);
 if(Number(request.headers.get('content-length'))>MAX_BODY_BYTES)return json({error:'Request too large'},413);
 // Stream and cap input, including requests without Content-Length.
 const reader=request.body?.getReader();let size=0,parts=[];
 if(reader){while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_BODY_BYTES){await reader.cancel();return json({error:'Request too large'},413);}parts.push(value);}}
 let message;
 try{const bytes=new Uint8Array(size);let at=0;for(const part of parts){bytes.set(part,at);at+=part.length;}message=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{return error(null,-32700,'Parse error',400);}
 if(!message||Array.isArray(message)||message.jsonrpc!=='2.0'||typeof message.method!=='string')return error(null,-32600,'Invalid request',400);
 const {id=null,method,params={}}=message;
 const writeFrontend={original_posts_enabled:writeEnabled('x_create_original_post',env),reposts_enabled:writeEnabled('x_repost',env),replies_enabled:writeEnabled('x_reply',env),reply_mode:'own_threads_only',backend_write_readiness:'not_checked'};
 if(!(id===null||typeof id==='string'||typeof id==='number'))return error(null,-32600,'Invalid request',400);
 if(method==='initialize')return result(id,{protocolVersion:'2025-11-25',capabilities:{tools:{listChanged:false}},serverInfo:{name:'dot-x-connector',version:'0.1.0'},instructions:discoverWriteTools(env).length?'Private owner-only frontend. Read tools only read existing cache. Separately enabled write tools publish as @example_dot_bot. Preserve idempotency keys; unknown or pending outcomes must never trigger a resend. Any enabled reply tool is restricted to eligible direct replies to the account’s original root posts, respecting opt-outs and one automated reply per interaction.':'Private, read-only, owner-only frontend. Only status and existing cache reads are available. Never performs live X requests.'});
 if(method==='notifications/initialized')return new Response(null,{status:202});
 if(method==='ping')return result(id,{});
 if(method==='tools/list')return result(id,{tools:[...tools,...discoverWriteTools(env)]});
 if(method!=='tools/call')return error(id,-32601,'Method not found');
 const access=authorize(request.headers);
 if(access!==200)return error(id,-32001,access===401?'Authenticated owner identity required':'Owner access only',access);
 if(params && typeof params==='object' && !Array.isArray(params) && WRITE_NAMES.has(params.name)) {
  const origin=request.headers.get('origin');
  if((origin!==null&&origin!==SITE_ORIGIN)||request.headers.get('sec-fetch-site')==='cross-site')return error(id,-32001,'Cross-origin write denied',403);
  if(Object.keys(params).some(key=>!['name','arguments','_meta'].includes(key)))return error(id,-32602,'Invalid write request');
  // MCP 2025-11-25 CallToolRequestParams permits transport metadata. It carries
  // no authority and is never forwarded to the strict arguments or signed body.
  // https://modelcontextprotocol.io/specification/2025-11-25/schema#calltoolrequestparams
  if(Object.hasOwn(params,'_meta')) {
   const meta=params._meta;
   if(!meta||typeof meta!=='object'||Array.isArray(meta)||(Object.hasOwn(meta,'progressToken')&&typeof meta.progressToken!=='string'&&!(typeof meta.progressToken==='number'&&Number.isFinite(meta.progressToken))))return error(id,-32602,'Invalid write metadata');
  }
  const upstream=await createWriteAdapter({db,env}).call(request.headers,params.name,params.arguments);
  const value=upstream.value??{available:false,reason:upstream.reason,safe_to_retry:false};
  return result(id,{content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value,isError:!upstream.ok});
 }
 if(!params||typeof params!=='object'||Array.isArray(params)||!tools.some(t=>t.name===params.name))return error(id,-32602,'Unknown tool');
 const args=params.arguments??{};
 if(!args||typeof args!=='object'||Array.isArray(args))return error(id,-32602,'Invalid arguments');
 const keys=Object.keys(args);
 if(keys.length)return error(id,-32602,'This tool accepts no arguments');

 let keyInfo={initialized:false,bridge_enabled:false};
 if(db){try{const row=await readPublicKey(db);if(row&&row.owner_id!==request.headers.get('oai-authenticated-user-id'))return error(id,-32001,'Owner access only',403);keyInfo=publicInfo(row);}catch{return error(id,-32002,'Private storage unavailable',503);}}
 if(SERVICE_BRIDGE_ENABLED){
  const upstream=await createServiceAdapter({db}).call(request.headers,params.name);
  const value=params.name==='x_connection_status'?{
   frontend:'ready',owner_authenticated:true,upstream_configured:true,
   backend_connected:upstream.ok,x_connected:null,x_linked:upstream.ok?upstream.value.linked:null,x_reconnect_required:upstream.ok?upstream.value.reconnect_required:null,
   live_x_enabled:null,read_tools_contact_x:false,backend_status_scope:'stored_link_and_configured_gates_only',write_frontend:writeFrontend,service_key:keyInfo,
   ...(upstream.ok?{backend_status:upstream.value}:{available:false,reason:upstream.reason})
  }:upstream.ok?upstream.value:{available:false,reason:upstream.reason};
  return result(id,{content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value,isError:!upstream.ok});
 }

 const value=params.name==='x_connection_status'?{
  frontend:'ready',owner_authenticated:true,upstream_configured:false,backend_contacted:false,x_connected:null,x_linked:null,x_reconnect_required:null,live_x_enabled:null,read_tools_contact_x:false,backend_status_scope:'stored_link_and_configured_gates_only',write_frontend:writeFrontend,cached_reads_enabled:false,reason:'backend_service_authorization_required',service_key:keyInfo
 }:{available:false,reason:'backend_service_authorization_required',message:'Cached reads remain disabled pending public-key pin verification. No backend or X request was made.'};
 return result(id,{content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value,isError:params.name!=='x_connection_status'});
}
