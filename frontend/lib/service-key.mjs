// Server-only. No key import/export API or general-purpose signing endpoint.
export const SITE_ORIGIN='https://frontend.example.invalid';
export const SERVICE_SUBJECT='dot-x-connector:example-deployment';
export const ENDPOINT='https://backend.example.invalid/service/mcp';
export const SERVICE_BRIDGE_ENABLED=false; // Enable only after configuring this deployment and verifying the backend public-key pin.
export const OWNER_EMAIL='owner@example.invalid';
const NAMES=new Set(['x_connection_status','x_read_mentions','x_read_posts']);
const encoder=new TextEncoder();
export const b64url=bytes=>btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
export const digest=async text=>b64url(await crypto.subtle.digest('SHA-256',encoder.encode(text)));
export function ownerIdentity(headers){
 const id=headers.get('oai-authenticated-user-id'); const email=headers.get('oai-authenticated-user-email');
 if(!id?.trim()||!email?.trim())return null;
 return email.trim().toLowerCase()===OWNER_EMAIL?{id,email:OWNER_EMAIL}:null;
}
export async function readPublicKey(db){return db.prepare('SELECT owner_id, public_jwk, fingerprint, created_at FROM service_identity WHERE id = 1').first();}
export function publicInfo(row){return row?{initialized:true,public_jwk:JSON.parse(row.public_jwk),fingerprint:row.fingerprint,created_at:row.created_at,bridge_enabled:SERVICE_BRIDGE_ENABLED}:{initialized:false,bridge_enabled:false};}
export async function initializedOwner(headers,db){const owner=ownerIdentity(headers);if(!owner)return false;const row=await readPublicKey(db);return !!row&&row.owner_id===owner.id;}
// Only the explicit browser POST route calls this. No startup, migration, MCP or GET side effects.
export async function initializeFromOwnerClick(db,owner){
 const old=await readPublicKey(db);if(old){if(old.owner_id!==owner.id)throw Error('owner');return publicInfo(old);}
 const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
 const exported=await crypto.subtle.exportKey('jwk',pair.publicKey);
 const pub={kty:'EC',crv:'P-256',x:exported.x,y:exported.y};
 const fingerprint=await digest(JSON.stringify({crv:pub.crv,kty:pub.kty,x:pub.x,y:pub.y}));
 const privateJwk=await crypto.subtle.exportKey('jwk',pair.privateKey);
 await db.prepare('INSERT INTO service_identity (id, owner_id, public_jwk, private_jwk, fingerprint, created_at) VALUES (1, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING').bind(owner.id,JSON.stringify(pub),JSON.stringify(privateJwk),fingerprint,new Date().toISOString()).run();
 // Unique singleton insert means concurrent requests cannot replace the winner.
 const saved=await readPublicKey(db);if(!saved||saved.owner_id!==owner.id)throw Error('owner');return publicInfo(saved);
}
export async function fixedServiceRequest(headers,db,name){
 if(!NAMES.has(name)||!await initializedOwner(headers,db))throw Error('owner');
 if(!SERVICE_BRIDGE_ENABLED)throw Error('disabled');
 const row=await db.prepare('SELECT private_jwk, fingerprint FROM service_identity WHERE id = 1').first();
 const body=JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:{}}});
 const iat=Math.floor(Date.now()/1000);
 const header={alg:'ES256',typ:'JWT',kid:row.fingerprint};
 const claims={iss:SITE_ORIGIN,sub:SERVICE_SUBJECT,aud:ENDPOINT,scope:'x:read',iat,exp:iat+45,jti:crypto.randomUUID(),method:'POST',path:'/service/mcp',body_sha256:await digest(body)};
 const data=b64url(encoder.encode(JSON.stringify(header)))+'.'+b64url(encoder.encode(JSON.stringify(claims)));
 const key=await crypto.subtle.importKey('jwk',JSON.parse(row.private_jwk),{name:'ECDSA',namedCurve:'P-256'},false,['sign']);
 const signature=await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key,encoder.encode(data));
 // Proof is used only in server-to-server request, never returned to MCP or browser.
 return {body,authorization:'Bearer '+data+'.'+b64url(signature)};
}
