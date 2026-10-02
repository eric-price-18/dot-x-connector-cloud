import { assert, basicAuth, configuration, httpsUrl, responseJson, SafeError } from './security.mjs';
import { createJwtVerifier, invalidToken } from './jwt.mjs';

const tokenCheck = (condition, reference) => { if (!condition) throw invalidToken(reference); };

export function createAuthenticator(idpFetch, clock) {
  let cachedDiscovery;
  const verifyJwt = createJwtVerifier(idpFetch, clock);
  return async function authenticate(request, env, required = 'x:read') {
    const cfg = configuration(env);
    const authorization = request.headers.get('authorization') ?? '';
    assert(/^Bearer [A-Za-z0-9._~+/-]+=*$/.test(authorization) && authorization.length <= 8192,
      'AUTHENTICATION_REQUIRED', 401);
    const cacheKey = JSON.stringify([cfg.discovery, cfg.issuer, cfg.mode, cfg.introspection,
      cfg.jwks, cfg.userinfo, cfg.algorithm, env.MCP_CLIENT_REGISTRATION]);
    if (!cachedDiscovery || cachedDiscovery.key !== cacheKey || cachedDiscovery.until <= clock()) {
      const discovery = await responseJson(await idpFetch(cfg.discovery,
        // workerd supports manual/follow only. responseJson rejects every 3xx.
        { headers: { accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(8000) }));
      assert(discovery && discovery.issuer === cfg.issuer
        && Array.isArray(discovery.code_challenge_methods_supported) && discovery.code_challenge_methods_supported.includes('S256')
        && Array.isArray(discovery.response_types_supported) && discovery.response_types_supported.includes('code')
        && (discovery.grant_types_supported === undefined || (Array.isArray(discovery.grant_types_supported) && discovery.grant_types_supported.includes('authorization_code'))),
      'IDP_NOT_PKCE_COMPATIBLE', 503);
      httpsUrl(discovery.authorization_endpoint, 'IDP_INVALID_DISCOVERY');
      httpsUrl(discovery.token_endpoint, 'IDP_INVALID_DISCOVERY');
      if (discovery.registration_endpoint !== undefined)
        httpsUrl(discovery.registration_endpoint, 'IDP_INVALID_DISCOVERY');
      if (cfg.mode === 'descope') {
        assert(discovery.jwks_uri === cfg.jwks && discovery.userinfo_endpoint === cfg.userinfo,
          'IDP_JWT_ENDPOINT_MISMATCH', 503);
      } else assert(discovery.introspection_endpoint === cfg.introspection, 'IDP_INTROSPECTION_MISMATCH', 503);
      assert(discovery.client_id_metadata_document_supported === true || discovery.registration_endpoint
        || env.MCP_CLIENT_REGISTRATION === 'predefined', 'IDP_CLIENT_REGISTRATION_REQUIRED', 503);
      cachedDiscovery = { key: cacheKey, until: clock()+600 };
    }
    let identity;
    if (cfg.mode === 'descope') {
      identity = await verifyJwt(authorization.slice(7), cfg);
    } else {
      try {
        identity = await responseJson(await idpFetch(cfg.introspection, {
          method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(8000),
          headers: { authorization: basicAuth(env.MCP_INTROSPECTION_CLIENT_ID, env.MCP_INTROSPECTION_CLIENT_SECRET),
            'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
          body: new URLSearchParams({ token: authorization.slice(7), token_type_hint: 'access_token' }).toString()
        }));
      } catch (error) {
        if (error instanceof SafeError && error.code === 'LIVE_IDP_DISABLED') throw error;
        throw new SafeError('IDENTITY_PROVIDER_UNAVAILABLE', 503);
      }
    }
    tokenCheck(identity && typeof identity === 'object' && !Array.isArray(identity), 'TOKEN_CLAIMS_INVALID');
    const audience = Array.isArray(identity.aud) ? identity.aud : [identity.aud];
    tokenCheck(cfg.mode === 'descope' || identity.active === true, 'TOKEN_INACTIVE');
    tokenCheck(identity.iss === cfg.issuer, 'TOKEN_ISSUER_MISMATCH');
    tokenCheck(audience.includes(cfg.resource), 'TOKEN_AUDIENCE_MISMATCH');
    tokenCheck(Number.isFinite(identity.exp) && identity.exp > clock(), 'TOKEN_EXPIRED');
    tokenCheck(identity.nbf === undefined || (Number.isFinite(identity.nbf) && identity.nbf <= clock()), 'TOKEN_NOT_YET_VALID');
    tokenCheck(identity.iat === undefined || (Number.isFinite(identity.iat) && identity.iat <= clock()), 'TOKEN_ISSUED_IN_FUTURE');
    tokenCheck(typeof identity.sub === 'string' && identity.sub.length > 0, 'TOKEN_SUBJECT_INVALID');
    // Descope's signed JWT class is access_token, distinct from the Bearer
    // transport type in OAuth token/introspection responses. Reject ID/refresh
    // JWTs explicitly; the owner's token-response Bearer check is separate.
    tokenCheck(cfg.mode === 'descope' ? identity.token_type === 'access_token'
      : identity.token_type === undefined || (typeof identity.token_type === 'string' && identity.token_type.toLowerCase() === 'bearer'), 'TOKEN_TYPE_INVALID');
    assert(identity.sub === env.MCP_ALLOWED_SUBJECT, 'OWNER_BINDING_MISMATCH', 403);
    let scopes = typeof identity.scope === 'string' ? identity.scope.split(/\s+/) : [];
    assert(scopes.includes(required), 'INSUFFICIENT_SCOPE', 403);
    if (cfg.mode === 'descope') {
      // Recheck live acceptance on every invocation. Never cache UserInfo or
      // fall back to signature-only access if the provider rejects/is offline.
      let info;
      try {
        const response = await idpFetch(cfg.userinfo, { method: 'GET', redirect: 'manual',
          signal: AbortSignal.timeout(8000), headers: { authorization, accept: 'application/json' } });
        assert(![401,403].includes(response.status), 'TOKEN_INVALID_OR_REVOKED', 401);
        info = await responseJson(response);
      } catch (error) {
        if (error instanceof SafeError && ['LIVE_IDP_DISABLED','TOKEN_INVALID_OR_REVOKED'].includes(error.code)) throw error;
        throw new SafeError('IDENTITY_PROVIDER_UNAVAILABLE', 503);
      }
      assert(info && typeof info === 'object' && !Array.isArray(info) && info.sub === identity.sub,
        'USERINFO_SUBJECT_MISMATCH', 401);
      // UserInfo may omit scope. If supplied it can only narrow the signed grant.
      if (info.scope !== undefined) {
        assert(typeof info.scope === 'string', 'INSUFFICIENT_SCOPE', 403);
        const liveScopes = info.scope.split(/\s+/);
        scopes = scopes.filter(scope => liveScopes.includes(scope));
        assert(scopes.includes(required), 'INSUFFICIENT_SCOPE', 403);
      }
      tokenCheck(identity.exp > clock(), 'TOKEN_EXPIRED');
    }
    return { issuer: cfg.issuer, subject: identity.sub, scopes, expires_at: identity.exp };
  };
}
