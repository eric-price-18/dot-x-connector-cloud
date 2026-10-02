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
      h.state.ownerToken=await signer.sign({iss:issuer,aud:`${base}/mcp`,exp:h.state.now+300,
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

const maintenancePath='/owner/maintenance/ongoing-reconcile';
async function maintenance(t,changes={}) {
 const now=Date.parse('2035-01-02T12:00Z')/1000;
 const evidence={account_id:'4242',observed_at:now,cycle_start:now,cycle_end:Date.parse('2035-01-31T10:00Z')/1000,provider_cycle_month:'2035-01',confirmed_used_micro_usd:0,confirmed_prepaid_micro_usd:4000000,evidence_id:'b'.repeat(64),auto_recharge_off:true,exclusive_billing:true};
 const f=await owner(t,{LIVE_X_ENABLED:'false',READ_POLLING_ENABLED:'false',POST_ENABLED:'false',REPLY_ENABLED:'false',SERVICE_WRITE_ENABLED:'false',X_ORIGINAL_POSTS_ENABLED:'false',X_REPOSTS_ENABLED:'false',X_OWN_THREAD_REPLIES_ENABLED:'false',X_ONGOING_OPERATIONS_ENABLED:'false',ONGOING_MAINTENANCE_ENABLED:'true',ONGOING_RECONCILIATION_JSON:JSON.stringify(evidence),...changes});
 await f.h.setTime(now);
 await f.h.db.prepare('INSERT INTO accounts(id,issuer,subject,x_user_id,encrypted_tokens,expires_at,updated_at) VALUES(?,?,?,?,?,?,?)').bind('primary',issuer,'mock-only-owner','4242','synthetic-unused-encrypted-payload',now+7200,now).run();return f;
}
test('workerd owner reconciliation: authenticated browser form, transactional D1, replay safety, zero X calls',async t=>{
 const {h,login,form}=await maintenance(t),session=await login();assert(session.html.includes('Apply spending reconciliation'));assert(!session.html.includes('b'.repeat(64)));
 const res=await form(maintenancePath,session);assert.equal(res.status,200,await res.clone().text());assert.deepEqual(await res.json(),{reconciled:true});
 assert.equal((await h.db.prepare('SELECT prepaid_micro_usd FROM ongoing_credit_state').first()).prepaid_micro_usd,4000000);
 await h.restart();assert.equal((await form(maintenancePath,session)).status,409);assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM ongoing_cycles').first()).n,1);assert.equal(h.xCalls().length,0);
});
test('workerd owner reconciliation: missing session, bad CSRF and caller fields denied before ledger writes',async t=>{
 const {h,login,form}=await maintenance(t),session=await login();
 assert.equal((await form(maintenancePath,{...session,cookie:''})).status,401);
 assert.equal((await form(maintenancePath,{...session,csrf:'bad'})).status,403);
 assert.equal((await form(maintenancePath,session,{sql:'DELETE FROM sends'})).status,403);
 assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM ongoing_credit_state').first()).n,0);assert.equal(h.xCalls().length,0);
});
test('workerd owner reconciliation: default-off gate and active operations block maintenance',async t=>{
 for(const changes of [{ONGOING_MAINTENANCE_ENABLED:'false'},{X_ONGOING_OPERATIONS_ENABLED:'true'}]){
  const {h,login,form}=await maintenance(t,changes),session=await login();const res=await form(maintenancePath,session);assert([403,409].includes(res.status));assert.equal(h.xCalls().length,0);assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM ongoing_cycles').first()).n,0);
 }
});
