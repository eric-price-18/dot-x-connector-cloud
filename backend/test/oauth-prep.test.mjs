import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createWorker } from '../src/worker.mjs';
import { accidentalNetwork } from './helpers.mjs';
import { ownerHarness } from './owner-fixtures.mjs';

const prep=JSON.parse(readFileSync(new URL('../config/oauth.example.json',import.meta.url),'utf8'));

test('OAuth preparation keeps public discovery and all unconfigured human/X routes fail-closed',async()=>{
  const worker=createWorker({logger:()=>{}}), env=prep.vars;
  const request=(path,method='GET')=>worker.fetch(new Request(`${env.PUBLIC_BASE_URL}${path}`,{
    method,headers:{origin:env.PUBLIC_BASE_URL}
  }),env);
  assert.equal((await request('/.well-known/oauth-protected-resource/mcp')).status,200);
  for(const [path,method] of [['/owner','GET'],['/owner/login','POST'],['/owner/callback','GET'],
    ['/owner/connect','POST'],['/x/connect','POST'],['/x/callback','GET'],['/admin/poll','POST']])
    assert.equal((await request(path,method)).status,503);
  assert.deepEqual(await worker.scheduled({},env,{}),{skipped:'READ_POLLING_DISABLED'});
  assert.deepEqual(accidentalNetwork,[]);
});

test('owner supports the mock provider advertised confidential methods without a public-client fallback',async t=>{
  const h=await ownerHarness(t);
  h.state.discovery.token_endpoint_auth_methods_supported=['client_secret_basic','client_secret_post'];
  await h.login();
  assert.equal(h.owner.exchanges.length,1);
  h.env.OWNER_CLIENT_AUTH_METHOD='none';
  assert.equal((await h.api('/owner/login',{method:'POST',headers:{origin:h.cfg.base}})).status,503);
  assert.equal(h.owner.exchanges.length,1);
  assert.equal(h.state.xCalls.length,0);
});

test('synthetic predefined owner profile pins issuer/endpoints and rejects another resource issuer',async t=>{
  const metadata=JSON.parse(readFileSync(new URL('./fixtures/descope-owner-discovery.json',import.meta.url),'utf8'));
  const h=await ownerHarness(t,{
    MCP_ISSUER:metadata.issuer,MCP_DISCOVERY_URL:metadata.issuer+'/.well-known/openid-configuration',
    MCP_JWKS_URL:metadata.jwks_uri,MCP_USERINFO_URL:metadata.userinfo_endpoint,
    OWNER_AUTHORIZATION_URL:metadata.authorization_endpoint,OWNER_TOKEN_URL:metadata.token_endpoint
  });
  h.state.discovery=metadata;
  const link=await h.start();
  assert.equal(link.url.origin+link.url.pathname,metadata.authorization_endpoint);
  assert.equal(link.url.searchParams.get('scope'),'openid x:read');
  assert.equal(link.url.searchParams.get('resource'),h.cfg.resource);
  h.owner.claims={iss:'https://identity.example.invalid/v1/apps/other-example-resource'};
  assert.equal((await h.complete(link)).status,401);
  assert.equal(h.db.all('SELECT * FROM owner_sessions').length,0);
  h.owner.claims={};await h.login();assert.equal(h.state.xCalls.length,0);
});

test('setup budgets permit only the two-call mocked X grant and block content polling without egress',async t=>{
  const h=await ownerHarness(t,Object.fromEntries(Object.entries(prep.vars).filter(([key])=>key.startsWith('MAX_'))));
  const session=await h.login();
  const started=await h.form('/owner/connect',session);
  const url=new URL(started.headers.get('location'));
  const cookie=started.headers.getSetCookie().find(v=>v.startsWith('__Host-x-link=')).split(';')[0];
  const callback=await h.api(`/x/callback?${new URLSearchParams({state:url.searchParams.get('state'),code:'mock-code'})}`,
    {headers:{cookie:`${cookie}; ${session.cookie}`}});
  assert.equal(callback.status,303);
  assert.deepEqual(h.state.xCalls.map(v=>new URL(v.url).pathname),['/2/oauth2/token','/2/users/me']);
  assert(await h.store.account());
  const poll=await h.api('/admin/poll',{method:'POST',headers:{authorization:`Bearer ${h.owner.token}`}});
  assert.equal(poll.status,403);
  assert.equal((await poll.json()).error,'READ_POLLING_DISABLED');
  await assert.rejects(h.x.verifyUser('mock-extra-request'),error=>error.code==='LOCAL_BUDGET_EXHAUSTED');
  assert.equal(h.state.xCalls.length,2);
});
