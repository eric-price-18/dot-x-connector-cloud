// Server-only. Reuse the established key without changing the read proof contract.
import {SITE_ORIGIN, SERVICE_SUBJECT, initializedOwner, b64url, digest} from './service-key.mjs';
import {WRITE_ENDPOINT, WRITE_PATH, writeEnabled, validateConfiguredWriteArguments} from './write-contract.mjs';
const encoder = new TextEncoder();

export async function fixedWriteRequest(headers, db, name, args, env = {}) {
 if (!writeEnabled(name, env)) throw Error('disabled');
 const checked = await validateConfiguredWriteArguments(name, args, env);
 if (!checked.ok || !db || !await initializedOwner(headers, db)) throw Error('owner');
 const row = await db.prepare('SELECT private_jwk, fingerprint FROM service_identity WHERE id = 1').first();
 if (!row) throw Error('key');
 const body = JSON.stringify({jsonrpc:'2.0', id:1, method:'tools/call', params:{name, arguments:checked.args}});
 const iat = Math.floor(Date.now() / 1000);
 const header = {alg:'ES256', typ:'JWT', kid:row.fingerprint};
 const claims = {
  iss:SITE_ORIGIN, sub:SERVICE_SUBJECT, aud:WRITE_ENDPOINT,
  scope:name === 'x_get_write_status' ? 'x:write:status' : name === 'x_reply' ? 'x:reply' : 'x:write',
  iat, exp:iat + 45, jti:crypto.randomUUID(), method:'POST', path:WRITE_PATH,
  body_sha256:await digest(body), operation:name, idempotency_key:checked.args.idempotency_key,
  ...(name === 'x_reply' ? {in_reply_to_post_id:checked.args.in_reply_to_post_id} : {})
 };
 const data = b64url(encoder.encode(JSON.stringify(header))) + '.' + b64url(encoder.encode(JSON.stringify(claims)));
 const key = await crypto.subtle.importKey('jwk', JSON.parse(row.private_jwk), {name:'ECDSA',namedCurve:'P-256'}, false, ['sign']);
 const signature = await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'}, key, encoder.encode(data));
 return {body, authorization:'Bearer ' + data + '.' + b64url(signature)};
}
