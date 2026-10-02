import {SITE_ORIGIN,ownerIdentity,readPublicKey,publicInfo,initializeFromOwnerClick} from './service-key.mjs';
const reply=(data,status=200,extra={})=>Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...extra}});
const COOKIE='__Host-dot-x-setup';
export async function handleSetup(request,db){
 const owner=ownerIdentity(request.headers);if(!owner)return reply({error:'Authenticated owner identity required'},request.headers.has('oai-authenticated-user-id')?403:401);
 if(!db)return reply({error:'Private storage unavailable. Please retry later.'},503);
 try{
  const row=await readPublicKey(db);if(row&&row.owner_id!==owner.id)return reply({error:'Owner access only'},403);
  if(request.method==='GET'){
   const csrf=crypto.randomUUID();
   return reply({...publicInfo(row),csrf},200,{'Set-Cookie':`${COOKIE}=${csrf}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=600`});
  }
  if(request.method!=='POST')return reply({error:'Method not allowed'},405);
  const cookie=request.headers.get('cookie')?.split(';').map(s=>s.trim()).find(s=>s.startsWith(COOKIE+'='))?.slice(COOKIE.length+1);
  const csrf=request.headers.get('x-setup-csrf');
  if(request.headers.get('origin')!==SITE_ORIGIN||request.headers.get('sec-fetch-site')!=='same-origin'||!cookie||!csrf||cookie!==csrf||!/^[a-f0-9-]{36}$/.test(csrf))return reply({error:'Reload this page before setup'},403);
  if(request.headers.get('content-type')!=='application/json')return reply({error:'JSON required'},415);
  const reader=request.body?.getReader();let size=0,chunks=[];
  if(reader)while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>128){await reader.cancel();return reply({error:'Invalid setup request'},400);}chunks.push(value);}
  const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}
  let input;try{input=JSON.parse(new TextDecoder().decode(bytes));}catch{return reply({error:'Invalid setup request'},400);}
  if(!input||Array.isArray(input)||Object.keys(input).length!==1||input.action!=='generate-read-only-key')return reply({error:'Invalid setup request'},400);
  return reply(await initializeFromOwnerClick(db,owner));
 }catch{return reply({error:'Setup unavailable. Retrying will not replace an existing key.'},503);}
}
