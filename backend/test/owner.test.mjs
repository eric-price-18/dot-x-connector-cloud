import test from 'node:test';
import assert from 'node:assert/strict';
import { ownerHarness, getCookie } from './owner-fixtures.mjs';
import { digest,open } from '../src/security.mjs';
import { OwnerLogin, ownerErrorPage } from '../src/owner.mjs';
import { response } from './helpers.mjs';
import { createWorker } from '../src/worker.mjs';

test('owner page is script-free, has no secrets, and remains disabled by default',async t=>{
  const h=await ownerHarness(t,{OWNER_LOGIN_ENABLED:'false'});
  const res=await h.api('/owner');const html=await res.text();
  assert.equal(res.status,200);assert(html.includes('button disabled'));assert(!html.includes('<script'));
  assert(res.headers.get('content-security-policy').includes("script-src 'none'"));
  assert.equal(res.headers.get('referrer-policy'),'same-origin');assert.equal(res.headers.get('cache-control'),'no-store');
  assert.equal((await h.api('/owner/login',{method:'POST',headers:{origin:h.cfg.base}})).status,503);
  assert.equal(h.state.idpCalls.length,0);assert.equal(h.state.xCalls.length,0);
});

test('owner error references reject markup and arbitrary exception text',async()=>{
  for(const value of ['<script>alert(1)</script>','private-provider-message','https://example.invalid/?code=private','A'.repeat(65),null]) {
    const res=ownerErrorPage(502,true,value),html=await res.text();
    assert(html.includes('Error reference: <code>INTERNAL_ERROR</code>'));
    assert(!html.includes('<script>'));
    if(typeof value==='string')assert(!html.includes(value));
    assert.equal(res.headers.get('referrer-policy'),'no-referrer');
    assert.equal(res.headers.get('cache-control'),'no-store');
  }
});

for(const [claims,tokenResponse,reference] of [
  [{token_type:'id_token'},{},'TOKEN_TYPE_INVALID'],
  [{token_type:'refresh_token'},{},'TOKEN_TYPE_INVALID'],
  [{iss:'https://mock-private-issuer.invalid'},{},'TOKEN_ISSUER_MISMATCH'],
  [{aud:'https://mock-private-audience.invalid'},{},'TOKEN_AUDIENCE_MISMATCH'],
  [{exp:0},{},'TOKEN_EXPIRED'],
  [{},{access_token:'mock-private-opaque-token'},'JWT_FORMAT_INVALID']
]) test(`owner callback exposes only fixed ${reference} diagnostic`,async t=>{
  const h=await ownerHarness(t);h.owner.claims=claims;h.owner.tokenResponse=tokenResponse;
  const res=await h.complete(await h.start()),html=await res.text();
  assert.equal(res.status,401);assert(html.includes(`Error reference: <code>${reference}</code>`));
  const output=html+h.state.logs.join(' ');
  assert(!output.includes('mock-private'));assert(!output.includes(h.owner.token));
  assert(h.state.logs.some(line=>line.includes('TOKEN_INVALID_OR_EXPIRED')));
  assert(!h.state.logs.some(line=>line.includes(reference)));
  assert.equal(h.db.all('SELECT * FROM owner_sessions').length,0);
  assert.equal(h.db.all('SELECT * FROM owner_login_state')[0].encrypted_payload,'');
  const rpc=await h.mcp('tools/call',{name:'x_connection_status',arguments:{}},
    {headers:{authorization:`Bearer ${tokenResponse.access_token??h.owner.token}`}});
  const rpcText=await rpc.text();assert(rpcText.includes('TOKEN_INVALID_OR_EXPIRED'));
  assert(!rpcText.includes(reference));assert.equal(h.state.xCalls.length,0);
});

test('owner keeps the OAuth response Bearer requirement separate from the signed JWT access class',async t=>{
  const h=await ownerHarness(t);
  await h.login();
  h.owner.tokenResponse={token_type:'access_token'};
  const res=await h.complete(await h.start());
  assert.equal(res.status,502);assert((await res.text()).includes('OWNER_TOKEN_INVALID'));
  assert.equal(h.state.xCalls.length,0);
});

test('owner login uses exact pins, PKCE, read scope, resource and encrypted browser state',async t=>{
  const h=await ownerHarness(t);const link=await h.start();
  const params=link.url.searchParams;
  assert.equal(params.get('scope'),'openid x:read');assert.equal(params.get('resource'),h.cfg.resource);
  assert.equal(params.get('redirect_uri'),h.env.OWNER_CALLBACK_URL);assert.equal(params.get('client_id'),h.env.OWNER_CLIENT_ID);
  assert.equal(params.get('code_challenge_method'),'S256');
  for(const part of ['Secure','HttpOnly','SameSite=Lax','Path=/','Max-Age=600'])assert(link.res.headers.get('set-cookie').includes(part));
  const row=h.db.all('SELECT * FROM owner_login_state')[0];
  assert.equal(row.state_hash,await digest(params.get('state')));assert(!JSON.stringify(row).includes(params.get('state')));
  assert(!JSON.stringify(row).includes(link.cookie.split('=')[1]));
  const res=await h.complete(link);assert.equal(res.status,303);assert.equal(res.headers.get('location'),'/owner');
  const form=new URLSearchParams(h.owner.exchanges[0].body);
  assert.equal(await digest(form.get('code_verifier')),params.get('code_challenge'));
  assert.equal(form.get('client_secret'),h.env.OWNER_CLIENT_SECRET);assert.equal(form.get('resource'),h.cfg.resource);
  assert.equal(form.get('redirect_uri'),h.env.OWNER_CALLBACK_URL);
  const saved=h.db.all('SELECT * FROM owner_sessions')[0];
  assert(!saved.encrypted_payload.includes(h.owner.token));assert(!JSON.stringify(saved).includes('mock-owner-refresh'));
  assert.equal(h.db.all('SELECT * FROM owner_login_state')[0].encrypted_payload,'');
  assert.equal(h.state.xCalls.length,0);
});

test('explicit public owner client uses PKCE without a client secret',async t=>{
  const h=await ownerHarness(t,{OWNER_CLIENT_AUTH_METHOD:'none',OWNER_CLIENT_SECRET:undefined});await h.login();
  assert.equal(new URLSearchParams(h.owner.exchanges[0].body).has('client_secret'),false);
});

for(const [name,change] of [
  ['missing client',{OWNER_CLIENT_ID:undefined}],['missing callback',{OWNER_CALLBACK_URL:undefined}],
  ['wrong callback',{OWNER_CALLBACK_URL:'https://connector.example.invalid/other'}],
  ['unknown client method',{OWNER_CLIENT_AUTH_METHOD:'client_secret_basic'}],
  ['missing confidential secret',{OWNER_CLIENT_SECRET:undefined}],
  ['cross-origin authorize',{OWNER_AUTHORIZATION_URL:'https://attacker.invalid/authorize'}],
  ['cross-origin token',{OWNER_TOKEN_URL:'https://attacker.invalid/token'}]
])test(`owner login fails closed: ${name}`,async t=>{
  const h=await ownerHarness(t,change);
  assert.equal((await h.api('/owner/login',{method:'POST',headers:{origin:h.cfg.base}})).status,503);
  assert.equal(h.owner.exchanges.length,0);assert.equal(h.db.all('SELECT * FROM owner_login_state').length,0);
});

test('owner native forms require exact Origin even when another MCP origin is allowed',async t=>{
  const h=await ownerHarness(t,{MCP_ALLOWED_ORIGINS:'https://other.example.invalid'});
  for(const headers of [{},{origin:'null'},{origin:'https://other.example.invalid'},
    {origin:h.cfg.base,'sec-fetch-site':'cross-site'}])
    assert.equal((await h.api('/owner/login',{method:'POST',headers})).status,403);
  assert.equal(h.state.idpCalls.length,0);
});

test('owner callback rejects missing/wrong/duplicate browser cookie and duplicate parameters',async t=>{
  const h=await ownerHarness(t);const link=await h.start();
  for(const cookie of ['',`__Host-owner-login=${'A'.repeat(43)}`,`${link.cookie}; ${link.cookie}`])
    assert.notEqual((await h.complete(link,{}, {cookie})).status,303);
  const state=link.url.searchParams.get('state');
  assert.equal((await h.api(`/owner/callback?state=${state}&state=${state}&code=mock`,{headers:{cookie:link.cookie}})).status,400);
  assert.equal(h.owner.exchanges.length,0);
  assert.equal((await h.complete(link)).status,303);
});

test('owner state expires and concurrent callback replay exchanges the code once',async t=>{
  const h=await ownerHarness(t);const expired=await h.start();h.state.now+=600;
  assert.equal((await h.complete(expired)).status,400);
  const link=await h.start();const results=await Promise.all([h.complete(link),h.complete(link)]);
  assert.deepEqual(results.map(v=>v.status).sort(),[303,400]);assert.equal(h.owner.exchanges.length,1);
});

test('owner decline consumes state and redacts upstream text',async t=>{
  const h=await ownerHarness(t);const link=await h.start();
  const res=await h.complete(link,{error:'access_denied',error_description:'private-provider-message'});
  assert.equal(res.status,400);assert(!((await res.text())+h.state.logs.join(' ')).includes('private-provider-message'));
  assert.equal((await h.complete(link)).status,400);assert.equal(h.owner.exchanges.length,0);
});

test('owner optional callback issuer must match and configuration changes invalidate pending state',async t=>{
  const h=await ownerHarness(t);const link=await h.start();
  assert.equal((await h.complete(link,{iss:'https://attacker.invalid'})).status,400);
  const next=await h.start();h.env.OWNER_CLIENT_ID='mock-changed-client';
  assert.equal((await h.complete(next)).status,503);assert.equal(h.owner.exchanges.length,0);
});

test('owner authorization endpoints must still match discovery at callback',async t=>{
  const h=await ownerHarness(t);const link=await h.start();h.state.discovery.token_endpoint='https://attacker.invalid/token';
  assert.equal((await h.complete(link)).status,503);assert.equal(h.owner.exchanges.length,0);
});

for(const [name,claims,info,status] of [
  ['other owner',{sub:'other'},{sub:'other'},200],['wrong audience',{aud:'https://api.x.com'},null,200],
  ['write scope',{scope:'x:read x:post'},null,200],['revoked',{},null,401],['userinfo outage',{},null,503],
  ['userinfo mismatch',{}, {sub:'other'},200]
])test(`owner callback creates no session for ${name}`,async t=>{
  const h=await ownerHarness(t);h.owner.claims=claims;if(info)h.owner.userinfo=info;h.owner.userinfoStatus=status;
  assert.notEqual((await h.complete(await h.start())).status,303);
  assert.equal(h.db.all('SELECT * FROM owner_sessions').length,0);assert.equal(h.state.xCalls.length,0);
});

test('owner token failure is one-use; redirects and private errors are never exposed',async t=>{
  const h=await ownerHarness(t);h.owner.onExchange=()=>response({private:'mock-secret-token-body'},307,{location:'https://attacker.invalid'});
  const link=await h.start();const res=await h.complete(link);assert.equal(res.status,502);
  const html=await res.text();
  assert(html.includes('Error reference: <code>UPSTREAM_REJECTED</code>'));
  assert(!(html+h.state.logs.join(' ')).includes('mock-secret-token-body'));
  assert.equal((await h.complete(link)).status,400);assert.equal(h.owner.exchanges.length,1);
});

test('owner session is short, encrypted, never rendered, and cannot authenticate MCP by cookie',async t=>{
  const h=await ownerHarness(t);const session=await h.login();
  assert(!session.html.includes(h.owner.token));assert(!session.html.includes(h.env.OWNER_CLIENT_SECRET));
  assert(session.res.headers.getSetCookie().some(v=>v.startsWith('__Host-owner-session=')&&v.includes('Max-Age=300')));
  const result=await h.call('x_connection_status',{}, {auth:false,headers:{cookie:session.cookie}});
  assert.equal(result.response.status,401);
  h.state.now+=300;assert.equal((await h.api('/owner',{headers:{cookie:session.cookie}})).status,401);
});

test('owner link requires CSRF and defaults to X read-only, with no grant or poll at initiation',async t=>{
  const h=await ownerHarness(t);const session=await h.login();
  assert.equal((await h.form('/owner/connect',session,{csrf:'wrong'})).status,403);
  assert.equal((await h.form('/owner/connect',session,{mode:'post'})).status,403);
  const res=await h.form('/owner/connect',session);assert.equal(res.status,303);
  const url=new URL(res.headers.get('location'));assert.equal(url.origin,'https://x.com');
  assert.equal(url.searchParams.get('scope'),'tweet.read users.read offline.access');
  assert.equal(h.state.xCalls.length,0);
  const callback=await h.api(`/x/callback?${new URLSearchParams({state:url.searchParams.get('state'),code:'mock-code'})}`,
    {headers:{cookie:`${getCookie(res,'__Host-x-link')}; ${session.cookie}`}});
  assert.equal(callback.status,303);assert.equal(callback.headers.get('location'),'/owner');
  assert.equal(h.state.xCalls.length,2);
});

test('approved owner write consent stores the full grant but enables no X activity',async t=>{
  const h=await ownerHarness(t,{OWNER_X_WRITE_CONSENT_ENABLED:'true',MAX_X_REQUESTS_DAY:'2',MAX_X_REQUESTS_HOUR:'2',MAX_READ_RECORDS_MONTH:'0',MAX_WRITES_DAY:'0'});
  h.state.xScopes='tweet.read users.read offline.access tweet.write';
  const session=await h.login();assert(session.html.includes('tweet.write'));
  assert(!session.html.includes('Connect X read-only'));
  assert.equal((await h.form('/owner/connect',session,{mode:'post'})).status,403);
  const res=await h.form('/owner/connect',session);assert.equal(res.status,303);
  const url=new URL(res.headers.get('location'));
  assert.equal(url.searchParams.get('scope'),h.state.xScopes);assert.equal(h.state.xCalls.length,0);
  const callback=await h.api(`/x/callback?${new URLSearchParams({state:url.searchParams.get('state'),code:'mock-code'})}`,
    {headers:{cookie:`${getCookie(res,'__Host-x-link')}; ${session.cookie}`}});
  assert.equal(callback.status,303);assert.equal(h.state.xCalls.length,2);
  const row=await h.store.account();
  const tokens=await open(h.env.TOKEN_ENCRYPTION_KEY,row.encrypted_tokens,h.x.context());
  assert.deepEqual(tokens.scopes,h.state.xScopes.split(' '));
  assert(!row.encrypted_tokens.includes('mock-access'));
  await assert.rejects(h.x.send('post',{}),{code:'POST_DISABLED'});
  await assert.rejects(h.x.send('reply',{}),{code:'REPLY_APPROVAL_REQUIRED'});
  await assert.rejects(h.x.poll(),{code:'READ_POLLING_DISABLED'});
  assert.equal(h.state.xCalls.length,2);
  // The public JSON route still defaults to read-only even with owner consent enabled.
  const apiStart=await h.api('/x/connect',{method:'POST',headers:{authorization:`Bearer ${h.owner.token}`},data:{}});
  assert.equal(apiStart.status,200);
  assert.equal(new URL((await apiStart.json()).authorization_url).searchParams.get('scope'),'tweet.read users.read offline.access');
});

for(const scopes of ['tweet.read users.read offline.access','tweet.read users.read offline.access tweet.write dm.read'])
test(`owner expanded consent rejects missing or extra grant scope: ${scopes}`,async t=>{
  const h=await ownerHarness(t,{OWNER_X_WRITE_CONSENT_ENABLED:'true'});h.state.xScopes=scopes;
  const session=await h.login();const res=await h.form('/owner/connect',session);
  const url=new URL(res.headers.get('location'));
  const callback=await h.api(`/x/callback?${new URLSearchParams({state:url.searchParams.get('state'),code:'mock-code'})}`,
    {headers:{cookie:getCookie(res,'__Host-x-link')}});
  assert.equal((await callback.json()).error,'X_SCOPE_MISMATCH');
  assert.equal(await h.store.account(),null);assert.equal(h.state.xCalls.length,1);
});

test('owner write consent cannot bypass its explicit gate or owner read permission',async t=>{
  const h=await ownerHarness(t);
  await assert.rejects(h.x.start({scopes:['x:read']},'read',true),{code:'X_WRITE_CONSENT_DISABLED_OR_UNAUTHORIZED'});
  h.env.OWNER_X_WRITE_CONSENT_ENABLED='true';
  await assert.rejects(h.x.start({scopes:[]},'read',true),{code:'X_WRITE_CONSENT_DISABLED_OR_UNAUTHORIZED'});
  assert.equal(h.db.all('SELECT * FROM oauth_states').length,0);assert.equal(h.state.xCalls.length,0);
});

test('owner connection honors live X gate in production transport',async t=>{
  const h=await ownerHarness(t);const session=await h.login();
  const worker=createWorker({idpFetch:h.idpFetch,clock:h.clock,logger:()=>{}});
  const req=h.request('/owner/connect',{method:'POST',raw:`csrf=${session.csrf}`,
    headers:{origin:h.cfg.base,cookie:session.cookie,'content-type':'application/x-www-form-urlencoded'}});
  assert.equal((await worker.fetch(req,h.env)).status,503);assert.equal(h.state.xCalls.length,0);
});

test('owner session rechecks UserInfo and local logout does not revoke or unlink X',async t=>{
  const h=await ownerHarness(t);const session=await h.login();await h.seed();h.owner.userinfoStatus=401;
  assert.equal((await h.form('/owner/connect',session)).status,401);assert.equal(h.state.xCalls.length,0);
  assert.equal((await h.form('/owner/logout',session)).status,303);
  assert.equal(h.db.all('SELECT * FROM owner_sessions').length,0);assert(await h.store.account());
});

test('a newer owner login fences a delayed earlier callback from overwriting its session',async t=>{
  const h=await ownerHarness(t);const old=await h.start();
  let entered,release;const arriving=new Promise(r=>{entered=r;});const wait=new Promise(r=>{release=r;});
  let count=0;h.owner.onExchange=async()=>{if(++count===1){entered();await wait;}};
  const delayed=h.complete(old);await arriving;
  const current=await h.login();const saved=h.db.all('SELECT * FROM owner_sessions')[0];release();
  assert.equal((await delayed).status,409);assert.deepEqual(h.db.all('SELECT * FROM owner_sessions')[0],saved);
  assert.equal((await h.api('/owner',{headers:{cookie:current.cookie}})).status,200);
});
