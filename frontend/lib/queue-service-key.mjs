// Server-only, fixed queue proof. Reuses the existing initialized key and owner.
import {SITE_ORIGIN, SERVICE_SUBJECT, initializedOwner, b64url, digest} from './service-key.mjs';
import {QUEUE_ENDPOINT, QUEUE_PATH, QUEUE_SCOPES, queueEnabled, validateQueueArguments} from './queue-contract.mjs';
const encoder = new TextEncoder();

export async function fixedQueueRequest(headers, db, name, args, env = {}) {
 if (!queueEnabled(name,env)) throw Error('disabled');
 const checked = validateQueueArguments(name,args);
 if (!checked.ok || !db || !await initializedOwner(headers,db)) throw Error('owner');
 const row = await db.prepare('SELECT private_jwk, fingerprint FROM service_identity WHERE id = 1').first();
 if (!row) throw Error('key');
 const body = JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:checked.args}});
 const iat = Math.floor(Date.now()/1000), request_id = checked.args.request_id;
 const header = {alg:'ES256',typ:'JWT',kid:row.fingerprint};
 const claims = {iss:SITE_ORIGIN,sub:SERVICE_SUBJECT,aud:QUEUE_ENDPOINT,scope:QUEUE_SCOPES[name],
  iat,exp:iat+45,jti:request_id,method:'POST',path:QUEUE_PATH,body_sha256:await digest(body),operation:name,request_id};
 const data = b64url(encoder.encode(JSON.stringify(header))) + '.' + b64url(encoder.encode(JSON.stringify(claims)));
 const key = await crypto.subtle.importKey('jwk',JSON.parse(row.private_jwk),{name:'ECDSA',namedCurve:'P-256'},false,['sign']);
 const signature = await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key,encoder.encode(data));
 if (signature.byteLength !== 64) throw Error('signature');
 return {body,authorization:'Bearer ' + data + '.' + b64url(signature)};
}
