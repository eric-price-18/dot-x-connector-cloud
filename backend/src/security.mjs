export class SafeError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export function assert(condition, code, status = 400) {
  if (!condition) throw new SafeError(code, status);
}

export const enabled = (value) => value === 'true';
const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64url(bytes) {
  const input = new Uint8Array(bytes);
  let binary = '';
  for (let i = 0; i < input.length; i += 32768) binary += String.fromCharCode(...input.subarray(i, i+32768));
  return btoa(binary)
    .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function fromB64url(value) {
  assert(typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value), 'INVALID_ENCODING');
  return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
}

export function randomValue(bytes = 32) {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function digest(value) {
  return b64url(await crypto.subtle.digest('SHA-256', enc.encode(value)));
}

async function aesKey(secret) {
  assert(typeof secret === 'string', 'ENCRYPTION_NOT_CONFIGURED', 503);
  const bytes = fromB64url(secret);
  assert(bytes.length === 32, 'ENCRYPTION_NOT_CONFIGURED', 503);
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function seal(secret, value, context) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(context) },
    await aesKey(secret), enc.encode(JSON.stringify(value))
  );
  return JSON.stringify({ v: 1, iv: b64url(iv), data: b64url(data) });
}

export async function open(secret, envelope, context) {
  try {
    const data = JSON.parse(envelope);
    assert(data.v === 1, 'INVALID_ENVELOPE');
    const bytes = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromB64url(data.iv), additionalData: enc.encode(context) },
      await aesKey(secret), fromB64url(data.data)
    );
    return JSON.parse(dec.decode(bytes));
  } catch {
    throw new SafeError('ENCRYPTED_STORAGE_INVALID', 503);
  }
}

export function httpsUrl(value, code = 'CONFIGURATION_REQUIRED') {
  try {
    const url = new URL(value);
    assert(url.protocol === 'https:' && !url.username && !url.password && !url.hash && !url.search, code, 503);
    return url;
  } catch {
    throw new SafeError(code, 503);
  }
}

// Public metadata needs only these public pins. Never use this as an auth check.
export function publicConfiguration(env) {
  const base = httpsUrl(env.PUBLIC_BASE_URL);
  assert(base.pathname === '/' && !env.PUBLIC_BASE_URL.endsWith('/'), 'PUBLIC_BASE_MUST_BE_ORIGIN', 503);
  httpsUrl(env.MCP_ISSUER);
  return { base: base.origin, issuer: env.MCP_ISSUER,
    resource: `${base.origin}/mcp` };
}

export function configuration(env) {
  const common = publicConfiguration(env);
  const issuer = new URL(common.issuer);
  const discovery = httpsUrl(env.MCP_DISCOVERY_URL);
  const mode = env.MCP_AUTH_MODE ?? 'introspection';
  assert(['introspection', 'descope'].includes(mode), 'IDP_CONFIGURATION_REQUIRED', 503);
  assert(typeof env.MCP_ALLOWED_SUBJECT === 'string' && env.MCP_ALLOWED_SUBJECT.length > 0,
    'IDP_CONFIGURATION_REQUIRED', 503);
  Object.assign(common, { discovery: discovery.href, mode });
  assert(discovery.origin === issuer.origin, 'IDP_ENDPOINT_ORIGIN_MISMATCH', 503);
  if (mode === 'descope') {
    const jwks = httpsUrl(env.MCP_JWKS_URL);
    const userinfo = httpsUrl(env.MCP_USERINFO_URL);
    assert(jwks.origin === issuer.origin && userinfo.origin === issuer.origin,
      'IDP_ENDPOINT_ORIGIN_MISMATCH', 503);
    assert(['RS256','ES256'].includes(env.MCP_JWT_ALG), 'IDP_JWT_ALGORITHM_REQUIRED', 503);
    return { ...common, jwks: jwks.href, userinfo: userinfo.href, algorithm: env.MCP_JWT_ALG };
  }
  const introspection = httpsUrl(env.MCP_INTROSPECTION_URL);
  assert(introspection.origin === issuer.origin,
    'IDP_ENDPOINT_ORIGIN_MISMATCH', 503);
  assert(env.MCP_ALLOWED_SUBJECT && env.MCP_INTROSPECTION_CLIENT_ID && env.MCP_INTROSPECTION_CLIENT_SECRET,
    'IDP_CONFIGURATION_REQUIRED', 503);
  return { ...common, introspection: introspection.href };
}

export function xConfiguration(env, cfg) {
  assert(env.X_CLIENT_ID && env.X_CLIENT_SECRET && /^\d{1,25}$/.test(env.X_EXPECTED_USER_ID ?? '')
    && env.TOKEN_ENCRYPTION_KEY, 'X_CONFIGURATION_REQUIRED', 503);
  assert(env.X_CALLBACK_URL === `${cfg.base}/x/callback`, 'EXACT_X_CALLBACK_REQUIRED', 503);
}

export function positiveLimit(env, key, fallback, ceiling) {
  const value = env[key] === undefined ? fallback : Number(env[key]);
  assert(Number.isSafeInteger(value) && value >= 0 && value <= ceiling, 'INVALID_BUDGET_CONFIGURATION', 503);
  return value;
}

export async function readBodyBytes(request, maxBytes = 16384) {
  assert(!request.headers.get('content-length') || Number(request.headers.get('content-length')) <= maxBytes,
    'REQUEST_TOO_LARGE', 413);
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) {
      await reader.cancel();
      throw new SafeError('REQUEST_TOO_LARGE', 413);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

export async function readBody(request, maxBytes = 16384) {
  return dec.decode(await readBodyBytes(request, maxBytes));
}

export async function responseJson(response) {
  assert(response.ok, 'UPSTREAM_REJECTED', 502);
  try { return JSON.parse(await readBody(response, 65536)); }
  catch (error) {
    if (error instanceof SafeError) throw error;
    throw new SafeError('UPSTREAM_INVALID_RESPONSE', 502);
  }
}

// Allowlist logging: never log upstream errors, URLs, bodies, tokens, or identities.
export function logCode(logger, event, error) {
  logger(JSON.stringify({ event, code: error instanceof SafeError ? error.code : 'INTERNAL_ERROR' }));
}

export function basicAuth(id, secret) {
  return `Basic ${btoa(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`)}`;
}
