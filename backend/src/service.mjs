import { assert, b64url, enabled, fromB64url, SafeError } from './security.mjs';
import { isPostId } from './write-validation.mjs';
import { WRITE_AUDIENCE, WRITE_PATH, WRITE_NAMES, UUID_V4, writeScope } from './write-policy.mjs';

export const SERVICE = Object.freeze({
  issuer: 'https://frontend.example.invalid',
  subject: 'dot-x-connector:example-deployment',
  audience: 'https://backend.example.invalid/service/mcp',
  path: '/service/mcp', maxTTL: 60, clockSkew: 5
});
const encoder = new TextEncoder();
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const invalid = () => new SafeError('SERVICE_PROOF_INVALID', 401);
function bytes(part) {
  const result = fromB64url(part);
  if (b64url(result) !== part) throw invalid();
  return result;
}
function decode(part) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes(part));
  const value = JSON.parse(text);
  // The agreed frontend serializes compact JSON. This rejects duplicate keys,
  // whitespace variants and ambiguous escaped names without a second parser.
  if (JSON.stringify(value) !== text) throw invalid();
  return value;
}

export function createServiceVerifier(clock, { write = false } = {}) {
  const profile = write ? {...SERVICE, audience:WRITE_AUDIENCE, path:WRITE_PATH} : SERVICE;
  let cached;
  async function publicKey(raw) {
    assert(typeof raw === 'string' && raw.length > 0 && raw.length <= 2048, 'SERVICE_KEY_NOT_CONFIGURED', 503);
    if (cached?.raw === raw) return cached.promise;
    const promise = (async () => {
      try {
        const jwk = JSON.parse(raw);
        const allowed = ['kty','crv','x','y','alg','use','key_ops','ext','kid'];
        if (!jwk || typeof jwk !== 'object' || Array.isArray(jwk)
          || Object.keys(jwk).some(key => !allowed.includes(key))
          || jwk.kty !== 'EC' || jwk.crv !== 'P-256'
          || bytes(jwk.x).length !== 32 || bytes(jwk.y).length !== 32
          || (jwk.alg !== undefined && jwk.alg !== 'ES256')
          || (jwk.use !== undefined && jwk.use !== 'sig')
          || (jwk.ext !== undefined && typeof jwk.ext !== 'boolean')
          || (jwk.key_ops !== undefined && (!Array.isArray(jwk.key_ops)
            || jwk.key_ops.length !== 1 || jwk.key_ops[0] !== 'verify'))) throw invalid();
        // RFC 7638: only required members, in lexicographic order.
        const canonical = JSON.stringify({crv:jwk.crv,kty:jwk.kty,x:jwk.x,y:jwk.y});
        const kid = b64url(await crypto.subtle.digest('SHA-256', encoder.encode(canonical)));
        if (jwk.kid !== undefined && jwk.kid !== kid) throw invalid();
        const key = await crypto.subtle.importKey('jwk', jwk, {name:'ECDSA',namedCurve:'P-256'}, false, ['verify']);
        return {key,kid};
      } catch { throw new SafeError('SERVICE_KEY_INVALID',503); }
    })();
    cached={raw,promise};
    return promise;
  }
  return async function verify(request, env, bodyBytes) {
    assert(enabled(env.SERVICE_ENABLED), 'SERVICE_DISABLED', 503);
    if(write) assert(enabled(env.SERVICE_WRITE_ENABLED), 'SERVICE_WRITE_DISABLED', 503);
    assert(request.method === 'POST', 'METHOD_NOT_ALLOWED', 405);
    assert(request.url === profile.audience && env.PUBLIC_BASE_URL === new URL(profile.audience).origin,
      'SERVICE_TARGET_INVALID', 403);
    // A server-to-server endpoint; browser-origin headers never grant access.
    assert(!request.headers.has('origin'), 'SERVICE_BROWSER_ORIGIN_FORBIDDEN', 403);
    const {key,kid} = await publicKey(env.SERVICE_PUBLIC_JWK);
    try {
      const authorization=request.headers.get('authorization')??'';
      if(!/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(authorization)
        || authorization.length>4096)throw invalid();
      const parts=authorization.slice(7).split('.'), header=decode(parts[0]), claims=decode(parts[1]);
      const claimNames=['iss','sub','aud','scope','iat','exp','jti','method','path','body_sha256'];
      if(write) {
        claimNames.push('operation','idempotency_key');
        if(claims.operation==='x_reply') claimNames.push('in_reply_to_post_id');
        if(!WRITE_NAMES.has(claims.operation) || typeof claims.idempotency_key!=='string' || !UUID_V4.test(claims.idempotency_key)
          || claims.scope!==writeScope(claims.operation) || claims.exp-claims.iat!==45
          || !UUID_V4.test(claims.jti) || (claims.operation==='x_reply' && !isPostId(claims.in_reply_to_post_id))) throw invalid();
      }
      if(!exactKeys(header,['alg','typ','kid']) || header.alg!=='ES256' || header.typ!=='JWT' || header.kid!==kid
        || !exactKeys(claims,claimNames))throw invalid();
      if(claims.iss!==SERVICE.issuer || claims.sub!==SERVICE.subject || claims.aud!==profile.audience
        || (!write && claims.scope!=='x:read') || claims.method!=='POST' || claims.path!==profile.path
        || !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp)
        || claims.iat<0 || claims.exp<=claims.iat || claims.exp-claims.iat>SERVICE.maxTTL
        || claims.iat>clock()+SERVICE.clockSkew || claims.exp<=clock()
        || typeof claims.jti!=='string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(claims.jti)
        || typeof claims.body_sha256!=='string' || bytes(claims.body_sha256).length!==32)throw invalid();
      const signature=bytes(parts[2]);
      if(signature.length!==64 || !await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},key,signature,
        encoder.encode(`${parts[0]}.${parts[1]}`)))throw invalid();
      if(claims.body_sha256!==b64url(await crypto.subtle.digest('SHA-256',bodyBytes)))throw invalid();
      // No one-use/replay claim: exact read requests can be replayed until expiry.
      if(claims.exp<=clock())throw invalid();
      return {kind:write?'service_write':'service',subject:SERVICE.subject,...(write?{operation:claims.operation,idempotency_key:claims.idempotency_key,
        ...(claims.operation==='x_reply'?{in_reply_to_post_id:claims.in_reply_to_post_id}:{})}:{})};
    }catch{throw invalid();}
  };
}
