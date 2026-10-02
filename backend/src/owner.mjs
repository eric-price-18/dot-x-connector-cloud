import { assert, digest, enabled, httpsUrl, open, randomValue, readBody, responseJson, seal } from './security.mjs';
import { Store } from './storage.mjs';

const LOGIN_COOKIE = '__Host-owner-login';
const SESSION_COOKIE = '__Host-owner-session';
const cookie = (name, value, seconds) => `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${seconds}`;
export const clearOwnerLogin = cookie(LOGIN_COOKIE, '', 0);
const clearSession = cookie(SESSION_COOKIE, '', 0);
const safeHeaders = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'cross-origin-opener-policy': 'same-origin' };

export function ownerRedirect(path, cookies = []) {
  const headers = new Headers({ ...safeHeaders, location: path,
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'" });
  for (const value of cookies) headers.append('set-cookie', value);
  return new Response(null, { status: 303, headers });
}
export function hasOwnerSessionCookie(request) {
  // Selects only the X callback's presentation; never grants authentication.
  return (request.headers.get('cookie') ?? '').split(';').some(v => v.trim().startsWith(`${SESSION_COOKIE}=`));
}
function readCookie(request, name) {
  const matches = (request.headers.get('cookie') ?? '').split(';').map(v => v.trim())
    .filter(v => v.startsWith(`${name}=`));
  if (!matches.length) return null;
  assert(matches.length === 1, 'OWNER_COOKIE_INVALID', 401);
  const value = matches[0].slice(name.length+1);
  assert(/^[A-Za-z0-9_-]{43}$/.test(value), 'OWNER_COOKIE_INVALID', 401);
  return value;
}
function formOrigin(request, cfg) {
  assert(request.headers.get('origin') === cfg.base, 'OWNER_ORIGIN_REQUIRED', 403);
  const site = request.headers.get('sec-fetch-site');
  assert(site === null || site === 'same-origin', 'OWNER_ORIGIN_REQUIRED', 403);
}
async function csrfForm(request, csrf) {
  assert(request.headers.get('content-type')?.split(';')[0] === 'application/x-www-form-urlencoded', 'OWNER_FORM_REQUIRED', 415);
  const params = new URLSearchParams(await readBody(request, 1024));
  assert([...params.keys()].every(v => v === 'csrf') && params.getAll('csrf').length === 1
    && params.get('csrf') === csrf, 'OWNER_CSRF_INVALID', 403);
}
function document(content, origin, status = 200, cookies = []) {
  const nonce = randomValue();
  const headers = new Headers({ ...safeHeaders, 'content-type': 'text/html; charset=utf-8',
    // Preserve Origin on native same-origin form POSTs; redirect responses still
    // use no-referrer so OAuth callback parameters never leave through Referer.
    'referrer-policy': 'same-origin',
    'content-security-policy': `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'none'; form-action 'self' ${origin} https://x.com; frame-ancestors 'none'; base-uri 'none'` });
  for (const value of cookies) headers.append('set-cookie', value);
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Dot X Connector · Owner connection</title>
<style nonce="${nonce}">body{font:17px/1.55 system-ui,sans-serif;background:#f5f7fa;color:#182638;margin:0;padding:6vh 24px}main{max-width:560px;margin:auto;background:white;border:1px solid #dce3ec;border-radius:16px;padding:32px}h1{font-size:1.7rem;line-height:1.2}p{color:#415268}button{font:inherit;background:#154b7e;color:white;border:0;border-radius:7px;padding:11px 18px;cursor:pointer}button:disabled{opacity:.55;cursor:default}form{margin:20px 0}a{color:#154b7e}.quiet{font-size:.9rem}</style>
<main><p class="quiet">DOT X CONNECTOR</p><h1>Owner connection</h1>${content}</main></html>`, { status, headers });
}
export function ownerErrorPage(status = 400, callback = false, code = 'INTERNAL_ERROR') {
  // The worker passes only its internal SafeError code, never an upstream body,
  // exception message, OAuth parameter or token. Keep the rendered form inert.
  const reference=typeof code==='string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'INTERNAL_ERROR';
  const response=document(`<p>This step could not be completed. Start again to sign in securely.</p><p class="quiet">Error reference: <code>${reference}</code></p><p><a href="/owner" rel="noreferrer">Return to owner connection</a></p>`, '', status,
    callback ? [clearOwnerLogin] : [clearSession]);
  response.headers.set('referrer-policy','no-referrer');
  return response;
}

export class OwnerLogin {
  constructor(env, cfg, idpFetch, authenticate, clock) {
    this.env=env; this.cfg=cfg; this.idpFetch=idpFetch; this.authenticate=authenticate; this.clock=clock;
    this.store=new Store(env.DB,clock);
  }
  settings() {
    assert(enabled(this.env.OWNER_LOGIN_ENABLED), 'OWNER_LOGIN_DISABLED', 503);
    assert(this.cfg.mode === 'descope', 'OWNER_DESCOPE_REQUIRED', 503);
    const authorization = httpsUrl(this.env.OWNER_AUTHORIZATION_URL, 'OWNER_CONFIGURATION_REQUIRED');
    const token = httpsUrl(this.env.OWNER_TOKEN_URL, 'OWNER_CONFIGURATION_REQUIRED');
    assert(authorization.origin === new URL(this.cfg.issuer).origin && token.origin === authorization.origin,
      'OWNER_ENDPOINT_ORIGIN_MISMATCH', 503);
    assert(typeof this.env.OWNER_CLIENT_ID === 'string' && this.env.OWNER_CLIENT_ID.length > 0
      && this.env.OWNER_CLIENT_ID.length <= 256 && this.env.OWNER_CALLBACK_URL === `${this.cfg.base}/owner/callback`
      && ['none','client_secret_post'].includes(this.env.OWNER_CLIENT_AUTH_METHOD), 'OWNER_CONFIGURATION_REQUIRED', 503);
    if (this.env.OWNER_CLIENT_AUTH_METHOD === 'client_secret_post')
      assert(this.env.OWNER_CLIENT_SECRET, 'OWNER_CLIENT_SECRET_REQUIRED', 503);
    return { authorization:authorization.href, token:token.href };
  }
  context(kind) {
    // Bind transactions/sessions to exact client, resource, owner, endpoints and
    // verification configuration. Configuration changes invalidate old sessions.
    return `owner:${kind}:${JSON.stringify([this.cfg.issuer,this.cfg.resource,this.cfg.jwks,this.cfg.userinfo,
      this.cfg.algorithm,this.env.MCP_ALLOWED_SUBJECT,this.env.OWNER_CLIENT_ID,this.env.OWNER_CALLBACK_URL,
      this.env.OWNER_AUTHORIZATION_URL,this.env.OWNER_TOKEN_URL,this.env.OWNER_CLIENT_AUTH_METHOD])}`;
  }
  async discovery() {
    const pins=this.settings();
    const data=await responseJson(await this.idpFetch(this.cfg.discovery, {
      headers:{accept:'application/json'},redirect:'manual',signal:AbortSignal.timeout(8000) }));
    assert(data?.issuer === this.cfg.issuer && data.authorization_endpoint === pins.authorization
      && data.token_endpoint === pins.token && data.jwks_uri === this.cfg.jwks && data.userinfo_endpoint === this.cfg.userinfo
      && Array.isArray(data.code_challenge_methods_supported) && data.code_challenge_methods_supported.includes('S256')
      && Array.isArray(data.response_types_supported) && data.response_types_supported.includes('code')
      && (data.token_endpoint_auth_methods_supported === undefined || (Array.isArray(data.token_endpoint_auth_methods_supported)
        && data.token_endpoint_auth_methods_supported.includes(this.env.OWNER_CLIENT_AUTH_METHOD))), 'OWNER_DISCOVERY_MISMATCH', 503);
    return pins;
  }
  async start(request) {
    formOrigin(request,this.cfg);
    const pins=await this.discovery();
    const state=randomValue(), browser=randomValue(), verifier=randomValue(48);
    const hash=await digest(state);
    const encrypted=await seal(this.env.TOKEN_ENCRYPTION_KEY,{verifier},this.context(`state:${hash}`));
    await this.store.run(`INSERT INTO owner_login_state(id,state_hash,cookie_hash,encrypted_payload,expires_at,consumed)
      VALUES('primary',?,?,?,?,0) ON CONFLICT(id) DO UPDATE SET state_hash=excluded.state_hash,cookie_hash=excluded.cookie_hash,
      encrypted_payload=excluded.encrypted_payload,expires_at=excluded.expires_at,consumed=0`,hash,await digest(browser),encrypted,this.clock()+600);
    const url=new URL(pins.authorization);
    url.search=new URLSearchParams({response_type:'code',client_id:this.env.OWNER_CLIENT_ID,
      redirect_uri:this.env.OWNER_CALLBACK_URL,scope:'openid x:read',resource:this.cfg.resource,state,
      code_challenge:await digest(verifier),code_challenge_method:'S256'}).toString();
    return ownerRedirect(url.href,[cookie(LOGIN_COOKIE,browser,600)]);
  }
  async callback(request) {
    this.settings();
    const params=new URL(request.url).searchParams;
    const state=params.get('state'),code=params.get('code'),browser=readCookie(request,LOGIN_COOKIE);
    assert(state && /^[A-Za-z0-9_-]{43}$/.test(state) && browser, 'OWNER_BROWSER_BINDING_REQUIRED');
    assert(params.getAll('state').length===1 && params.getAll('code').length<=1 && params.getAll('error').length<=1
      && params.getAll('iss').length<=1, 'OWNER_CALLBACK_INVALID');
    const hash=await digest(state);
    const row=await this.store.first(`UPDATE owner_login_state SET consumed=1 WHERE id='primary'
      AND state_hash=? AND cookie_hash=? AND expires_at>? AND consumed=0 RETURNING encrypted_payload`,hash,await digest(browser),this.clock());
    assert(row,'OWNER_STATE_INVALID_OR_EXPIRED');
    try {
      const payload=await open(this.env.TOKEN_ENCRYPTION_KEY,row.encrypted_payload,this.context(`state:${hash}`));
      assert(!params.has('error') && typeof code === 'string' && code.length>0 && code.length<=2048
        && (!params.has('iss') || params.get('iss')===this.cfg.issuer), 'OWNER_AUTHORIZATION_DECLINED_OR_INVALID');
      const pins=await this.discovery();
      const form=new URLSearchParams({grant_type:'authorization_code',client_id:this.env.OWNER_CLIENT_ID,code,
        redirect_uri:this.env.OWNER_CALLBACK_URL,code_verifier:payload.verifier,resource:this.cfg.resource});
      if(this.env.OWNER_CLIENT_AUTH_METHOD==='client_secret_post')form.set('client_secret',this.env.OWNER_CLIENT_SECRET);
      const data=await responseJson(await this.idpFetch(pins.token,{method:'POST',redirect:'manual',signal:AbortSignal.timeout(8000),
        headers:{'content-type':'application/x-www-form-urlencoded',accept:'application/json'},body:form.toString()}));
      assert(typeof data?.access_token==='string' && data.access_token.length>0 && data.access_token.length<=8192
        && typeof data.token_type==='string' && data.token_type.toLowerCase()==='bearer'
        && Number.isSafeInteger(data.expires_in) && data.expires_in>0, 'OWNER_TOKEN_INVALID', 502);
      const identity=await this.authenticate(new Request(`${this.cfg.base}/owner`,{headers:{authorization:`Bearer ${data.access_token}`}}));
      assert(identity.scopes.includes('x:read') && !identity.scopes.some(v=>v==='x:post'||v==='x:reply'), 'OWNER_READ_ONLY_REQUIRED', 403);
      const seconds=Math.floor(Math.min(600,data.expires_in,identity.expires_at-this.clock()));
      assert(seconds>0,'OWNER_TOKEN_INVALID',401);
      const session=randomValue(),csrf=randomValue();
      const encrypted=await seal(this.env.TOKEN_ENCRYPTION_KEY,{token:data.access_token,csrf},this.context('session'));
      const saved=await this.store.first(`INSERT INTO owner_sessions(id,session_hash,encrypted_payload,expires_at)
        SELECT 'primary',?,?,? WHERE EXISTS(SELECT 1 FROM owner_login_state WHERE id='primary' AND state_hash=? AND consumed=1)
        ON CONFLICT(id) DO UPDATE SET session_hash=excluded.session_hash,encrypted_payload=excluded.encrypted_payload,
        expires_at=excluded.expires_at RETURNING id`,await digest(session),encrypted,this.clock()+seconds,hash);
      assert(saved,'OWNER_LOGIN_SUPERSEDED',409);
      // Refresh and ID tokens are deliberately discarded; this short session never refreshes.
      return ownerRedirect('/owner',[clearOwnerLogin,cookie(SESSION_COOKIE,session,seconds)]);
    } finally {
      await this.store.run("UPDATE owner_login_state SET encrypted_payload='' WHERE id='primary' AND state_hash=? AND consumed=1",hash);
    }
  }
  async session(request, validate=true) {
    this.settings();
    const value=readCookie(request,SESSION_COOKIE);
    assert(value,'OWNER_SIGN_IN_REQUIRED',401);
    const hash=await digest(value);
    const row=await this.store.first("SELECT * FROM owner_sessions WHERE id='primary' AND session_hash=?",hash);
    assert(row && row.expires_at>this.clock(),'OWNER_SESSION_EXPIRED',401);
    const payload=await open(this.env.TOKEN_ENCRYPTION_KEY,row.encrypted_payload,this.context('session'));
    assert(typeof payload.token==='string' && /^[A-Za-z0-9_-]{43}$/.test(payload.csrf),'OWNER_SESSION_INVALID',401);
    let identity;
    if(validate)identity=await this.authenticate(new Request(`${this.cfg.base}/owner`,{headers:{authorization:`Bearer ${payload.token}`}}));
    return {hash,csrf:payload.csrf,identity};
  }
  async page(request) {
    const ready=enabled(this.env.OWNER_LOGIN_ENABLED);
    const origin=new URL(this.cfg.issuer).origin;
    const writeConsent=enabled(this.env.OWNER_X_WRITE_CONSENT_ENABLED);
    const consentText=writeConsent
      ? 'X consent requests tweet.read, users.read, offline.access and tweet.write. This stores a grant for future writing. The grant alone does not enable posting, replies or polling.'
      : 'This page can connect read-only access to your mentions and posts.';
    if(!ready || !readCookie(request,SESSION_COOKIE))return document(
      `<p>Sign in to manage your X connection. ${consentText}</p>
      <form method="post" action="/owner/login"><button${ready?'':' disabled'}>Sign in with Descope</button></form>
      ${ready?'':'<p>Owner sign-in is not enabled yet.</p>'}<p class="quiet">Posting and replies are not available on this page.</p>`,origin);
    const session=await this.session(request);
    const row=await this.store.account();
    if(row)assert(row.issuer===this.cfg.issuer && row.subject===this.env.MCP_ALLOWED_SUBJECT
      && row.x_user_id===this.env.X_EXPECTED_USER_ID,'ACCOUNT_NOT_LINKED_OR_BINDING_MISMATCH',403);
    const active=enabled(this.env.LIVE_X_ENABLED);
    return document(`<p>You are signed in as the configured owner.</p><p>${row?'An X account is connected.':'No X account is connected yet.'}</p>
      <p>${consentText}</p><form method="post" action="/owner/connect"><input type="hidden" name="csrf" value="${session.csrf}"><button${active?'':' disabled'}>${row?'Reconnect':'Connect'} X ${writeConsent?'with approved scopes':'read-only'}</button></form>
      ${active?'':'<p>X access is currently disabled.</p>'}<form method="post" action="/owner/logout"><input type="hidden" name="csrf" value="${session.csrf}"><button>Sign out of this page</button></form>
      <p class="quiet">Signing out ends this browser session. It does not disconnect X.</p>`,origin);
  }
  async connect(request, startX) {
    formOrigin(request,this.cfg);
    const session=await this.session(request);
    await csrfForm(request,session.csrf);
    const link=await startX(session.identity);
    return ownerRedirect(link.authorization_url,[link.cookie]);
  }
  async logout(request) {
    formOrigin(request,this.cfg);
    const session=await this.session(request,false);
    await csrfForm(request,session.csrf);
    await this.store.run("DELETE FROM owner_sessions WHERE id='primary' AND session_hash=?",session.hash);
    return ownerRedirect('/owner',[clearSession,clearOwnerLogin]);
  }
}
