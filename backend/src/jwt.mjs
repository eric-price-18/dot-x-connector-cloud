import { assert, fromB64url, responseJson, SafeError } from './security.mjs';

// Fixed owner-page diagnostics only. MCP responses and logs keep the generic
// error, and no token/header/claim values are retained in the error object.
const references = new Set(['JWT_FORMAT_INVALID','JWT_HEADER_INVALID','JWT_ALGORITHM_MISMATCH',
  'JWT_KEY_ID_INVALID','JWT_TYPE_INVALID','JWT_KEY_NOT_FOUND','JWT_KEY_METADATA_INVALID',
  'JWT_KEY_PARAMETERS_INVALID','JWT_SIGNATURE_INVALID','TOKEN_CLAIMS_INVALID','TOKEN_INACTIVE',
  'TOKEN_ISSUER_MISMATCH','TOKEN_AUDIENCE_MISMATCH','TOKEN_EXPIRED','TOKEN_NOT_YET_VALID',
  'TOKEN_ISSUED_IN_FUTURE','TOKEN_SUBJECT_INVALID','TOKEN_TYPE_INVALID']);
const diagnostics = new WeakMap();
export function invalidToken(reference) {
  const error = new SafeError('TOKEN_INVALID_OR_EXPIRED', 401);
  if (references.has(reference)) diagnostics.set(error, reference);
  return error;
}
export const tokenErrorReference = error => diagnostics.get(error);
const invalid = invalidToken;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const decode = part => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fromB64url(part)));

// Only asymmetric algorithms explicitly pinned by the operator. No token-provided
// key URLs, embedded keys, algorithm negotiation, or unsigned-token fallback.
export function createJwtVerifier(idpFetch, clock) {
  let cached, pending;
  async function keys(cfg) {
    const key = JSON.stringify([cfg.issuer, cfg.jwks, cfg.algorithm]);
    if (cached?.key === key && cached.until > clock()) return cached.keys;
    if (pending?.key === key) return pending.promise;
    const promise = (async () => {
      let data;
      try {
        data = await responseJson(await idpFetch(cfg.jwks, {
          headers: { accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(8000)
        }));
      } catch (error) {
        if (error instanceof SafeError && error.code === 'LIVE_IDP_DISABLED') throw error;
        throw new SafeError('IDENTITY_PROVIDER_UNAVAILABLE', 503);
      }
      assert(Array.isArray(data?.keys) && data.keys.length > 0 && data.keys.length <= 32,
        'IDP_JWKS_INVALID', 503);
      cached = { key, keys: data.keys, until: clock()+300 };
      return data.keys;
    })();
    const flight = pending = { key, promise };
    try { return await promise; } finally { if (pending === flight) pending = undefined; }
  }
  return async function verify(token, cfg) {
    let parts, header, claims;
    try {
      parts = token.split('.');
      if (parts.length !== 3 || parts.some(v => !v || !/^[A-Za-z0-9_-]+$/.test(v))) throw invalid('JWT_FORMAT_INVALID');
      header = decode(parts[0]); claims = decode(parts[1]);
      if (!object(header) || !object(claims)
        || ['jku','jwk','x5u','crit','b64'].some(v => Object.hasOwn(header,v))) throw invalid('JWT_HEADER_INVALID');
      if (header.alg !== cfg.algorithm) throw invalid('JWT_ALGORITHM_MISMATCH');
      if (typeof header.kid !== 'string' || !header.kid || header.kid.length > 256) throw invalid('JWT_KEY_ID_INVALID');
      if (header.typ !== undefined && !['JWT','at+jwt'].includes(header.typ)) throw invalid('JWT_TYPE_INVALID');
    } catch (error) { throw invalid(tokenErrorReference(error) ?? 'JWT_FORMAT_INVALID'); }
    // Unknown kids fail until this bounded cache expires, preventing random-kid
    // request floods from forcing repeated JWKS fetches. No stale-on-error use.
    const matches = (await keys(cfg)).filter(v => object(v) && v.kid === header.kid);
    if (matches.length !== 1) throw invalid('JWT_KEY_NOT_FOUND');
    const jwk = matches[0];
    try {
      if ((jwk.alg !== undefined && jwk.alg !== cfg.algorithm)
        || (jwk.use !== undefined && jwk.use !== 'sig')
        || (jwk.key_ops !== undefined && (!Array.isArray(jwk.key_ops)
          || !jwk.key_ops.includes('verify') || jwk.key_ops.some(v => v !== 'verify')))
        || ['d','p','q','dp','dq','qi','oth','k'].some(v => Object.hasOwn(jwk,v))) throw invalid('JWT_KEY_METADATA_INVALID');
      const rsa = cfg.algorithm === 'RS256';
      let algorithm;
      if (rsa) {
        if (jwk.kty !== 'RSA' || jwk.e !== 'AQAB') throw invalid('JWT_KEY_PARAMETERS_INVALID');
        const modulus = fromB64url(jwk.n);
        if (modulus.length < 256 || modulus.length > 512 || modulus[0] < 128) throw invalid('JWT_KEY_PARAMETERS_INVALID');
        algorithm = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
      } else {
        if (jwk.kty !== 'EC' || jwk.crv !== 'P-256'
          || fromB64url(jwk.x).length !== 32 || fromB64url(jwk.y).length !== 32) throw invalid('JWT_KEY_PARAMETERS_INVALID');
        algorithm = { name: 'ECDSA', namedCurve: 'P-256' };
      }
      const key = await crypto.subtle.importKey('jwk', jwk, algorithm, false, ['verify']);
      const signature = fromB64url(parts[2]);
      if (!rsa && signature.length !== 64) throw invalid('JWT_SIGNATURE_INVALID');
      const valid = await crypto.subtle.verify(rsa ? algorithm : { name: 'ECDSA', hash: 'SHA-256' },
        key, signature, new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
      if (!valid) throw invalid('JWT_SIGNATURE_INVALID');
      return claims;
    } catch (error) { throw invalid(tokenErrorReference(error) ?? 'JWT_KEY_PARAMETERS_INVALID'); }
  };
}
