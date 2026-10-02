import { RUNTIME_NOW } from './clock-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime,base,issuer,json } from './helpers.mjs';
import { signingFixture } from '../test/jwt-fixtures.mjs';

const cookie=(res,name)=>res.headers.getSetCookie().find(v=>v.startsWith(`${name}=`))?.split(';')[0];
async function owner(t,overrides={}) {
  const h=await runtime(t,{MCP_AUTH_MODE:'descope',MCP_JWT_ALG:'RS256',MCP_JWKS_URL:`${issuer}/keys`,
    MCP_USERINFO_URL:`${issuer}/userinfo`,OWNER_LOGIN_ENABLED:'true',OWNER_CLIENT_ID:'mock-owner-client',
    OWNER_CLIENT_AUTH_METHOD:'client_secret_post',OWNER_CLIENT_SECRET:'mock-owner-secret',
    OWNER_AUTHORIZATION_URL:`${issuer}/authorize`,OWNER_TOKEN_URL:`${issuer}/token`,OWNER_CALLBACK_URL:`${base}/owner/callback`,
    READ_POLLING_ENABLED:'false',...overrides});
  const signer=await signingFixture();
  h.state.discovery={jwks_uri:`${issuer}/keys`,userinfo_endpoint:`${issuer}/userinfo`};
  h.state.exchangeCount=0;
  h.state.onIdp=async call=>{
    if(call.url.pathname==='/keys')return json({keys:[signer.jwk]});
    if(call.url.pathname==='/userinfo')return json({sub:'mock-only-owner'},h.state.userinfoStatus??200);
    if(call.url.pathname==='/token') {
      h.state.exchangeCount++;
      h.state.ownerToken=await signer.sign({iss:issuer,aud:`${base}/mcp`,exp:RUNTIME_NOW+300,
        sub:'mock-only-owner',scope:'openid x:read',token_type:'access_token'});
      return json({access_token:h.state.ownerToken,token_type:'Bearer',expires_in:300});
    }
  };
  async function start(){
    const res=await h.api('/owner/login',{method:'POST',headers:{origin:base}});
    assert.equal(res.status,303,await res.clone().text());
    assert.equal(new URL(res.headers.get('location')).searchParams.get('scope'),'openid x:read');
    return {url:new URL(res.headers.get('location')),cookie:cookie(res,'__Host-owner-login')};
  }
  const complete=link=>h.api(`/owner/callback?${new URLSearchParams({state:link.url.searchParams.get('state'),code:'mock-code'})}`,
    {headers:{cookie:link.cookie}});
  async function login(){
    const link=await start();const res=await complete(link);assert.equal(res.status,303,await res.clone().text());
    const session=cookie(res,'__Host-owner-session');
    const page=await h.api('/owner',{headers:{cookie:session}});assert.equal(page.status,200,await page.clone().text());
    const html=await page.text();const csrf=/name="csrf" value="([A-Za-z0-9_-]+)"/.exec(html)?.[1];assert(csrf);
    return {link,cookie:session,csrf,html};
  }
  const form=(path,session,extra={})=>h.api(path,{method:'POST',raw:new URLSearchParams({csrf:session.csrf,...extra}).toString(),
    headers:{cookie:session.cookie,origin:base,'content-type':'application/x-www-form-urlencoded'}});
  return {h,start,complete,login,form};
}

test('workerd owner: Descope callback, encrypted browser session, X read-only link and local logout',async t=>{
  const {h,login,form}=await owner(t);const session=await login();
  assert(!session.html.includes(h.state.ownerToken));
  const row=await h.db.prepare('SELECT * FROM owner_sessions').first();assert(!row.encrypted_payload.includes(h.state.ownerToken));
  assert.equal((await form('/owner/connect',session,{mode:'post'})).status,403);
  const res=await form('/owner/connect',session);assert.equal(res.status,303);
  const url=new URL(res.headers.get('location'));assert.equal(url.searchParams.get('scope'),'tweet.read users.read offline.access');
  assert.equal(h.xCalls().length,0);
  const linked=await h.api(`/x/callback?${new URLSearchParams({state:url.searchParams.get('state'),code:'mock-x-code'})}`,
    {headers:{cookie:`${cookie(res,'__Host-x-link')}; ${session.cookie}`}});
  assert.equal(linked.status,303);assert.equal(linked.headers.get('location'),'/owner');
  assert.equal(h.xCalls().length,2);
  assert.equal((await form('/owner/logout',session)).status,303);
  assert.equal(await h.db.prepare('SELECT * FROM owner_sessions').first(),null);
  assert(await h.db.prepare('SELECT * FROM accounts').first());
});

test('workerd owner: expanded consent persists encrypted while writes and polling stay disabled',async t=>{
  const {h,login,form}=await owner(t,{OWNER_X_WRITE_CONSENT_ENABLED:'true',MAX_X_REQUESTS_DAY:'2',MAX_X_REQUESTS_HOUR:'2',MAX_READ_RECORDS_MONTH:'0',MAX_WRITES_DAY:'0'});
  h.state.xScopes='tweet.read users.read offline.access tweet.write';
  const session=await login();assert(session.html.includes('tweet.write'));
  const res=await form('/owner/connect',session);assert.equal(res.status,303);
  const url=new URL(res.headers.get('location'));assert.equal(url.searchParams.get('scope'),h.state.xScopes);
  assert.equal(h.xCalls().length,0);
  const linked=await h.api(`/x/callback?${new URLSearchParams({state:url.searchParams.get('state'),code:'mock-x-code'})}`,
    {headers:{cookie:`${cookie(res,'__Host-x-link')}; ${session.cookie}`}});
  assert.equal(linked.status,303);assert.equal(h.xCalls().length,2);
  const row=await h.db.prepare('SELECT * FROM accounts').first();assert(row);
  assert(!row.encrypted_tokens.includes('mock-access'));
  const listed=await h.mcp('tools/list');const names=(await listed.json()).result.tools.map(v=>v.name);
  assert(!names.includes('x_create_post'));assert(!names.includes('x_reply_to_post'));
  await h.restart();
  assert.equal((await h.api('/owner',{headers:{cookie:session.cookie}})).status,200);
  assert.equal(h.xCalls().length,2);
});

test('workerd owner: concurrent callback is one-use and browser session survives runtime restart',async t=>{
  const {h,start,complete}=await owner(t);const link=await start();
  const results=await Promise.all([complete(link),complete(link)]);
  assert.deepEqual(results.map(v=>v.status).sort(),[303,400]);assert.equal(h.state.exchangeCount,1);
  const session=cookie(results.find(v=>v.status===303),'__Host-owner-session');
  await h.restart();
  assert.equal((await h.api('/owner',{headers:{cookie:session}})).status,200);
  assert.equal((await complete(link)).status,400);assert.equal(h.state.exchangeCount,1);
});

test('workerd owner: expired state/session, CSRF and live revocation deny linking',async t=>{
  const {h,start,complete,login,form}=await owner(t);const link=await start();
  await h.db.prepare('UPDATE owner_login_state SET expires_at=0').run();
  assert.equal((await complete(link)).status,400);assert.equal(h.state.exchangeCount,0);
  const session=await login();assert.equal((await form('/owner/connect',session,{csrf:'wrong'})).status,403);
  h.state.userinfoStatus=401;assert.equal((await form('/owner/connect',session)).status,401);
  h.state.userinfoStatus=200;await h.db.prepare('UPDATE owner_sessions SET expires_at=0').run();
  assert.equal((await form('/owner/connect',session)).status,401);assert.equal(h.xCalls().length,0);
});

test('workerd owner: production X gate remains closed after successful owner login',async t=>{
  const {h,login,form}=await owner(t,{LIVE_X_ENABLED:'false'});const session=await login();
  assert(session.html.includes('X access is currently disabled'));
  assert.equal((await form('/owner/connect',session)).status,503);assert.equal(h.xCalls().length,0);
});

test('workerd owner: live identity gate prevents login initiation and foreign form origins are rejected',async t=>{
  const {h}=await owner(t,{LIVE_IDP_ENABLED:'false'});
  assert.equal((await h.api('/owner/login',{method:'POST',headers:{origin:base}})).status,503);
  assert.equal((await h.api('/owner/login',{method:'POST',headers:{origin:'https://attacker.example.invalid'}})).status,403);
  assert.equal(h.state.calls.length,0);
});
