import { RUNTIME_NOW } from './clock-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime, issuer, base, json } from './helpers.mjs';
import { signingFixture } from '../test/jwt-fixtures.mjs';

async function descope(t, algorithm='RS256') {
  const h=await runtime(t,{MCP_AUTH_MODE:'descope',MCP_JWT_ALG:algorithm,
    MCP_JWKS_URL:`${issuer}/keys`,MCP_USERINFO_URL:`${issuer}/apps/userinfo`,
    MCP_INTROSPECTION_CLIENT_ID:'',MCP_INTROSPECTION_CLIENT_SECRET:''});
  const fixture=await signingFixture(algorithm);
  h.state.discovery={jwks_uri:h.bindings.MCP_JWKS_URL,userinfo_endpoint:h.bindings.MCP_USERINFO_URL};
  h.state.onIdp=call=>{
    if(call.url.pathname==='/keys') {
      assert.equal(call.headers.get('authorization'),null);
      return json({keys:[fixture.jwk]});
    }
    if(call.url.pathname==='/apps/userinfo') {
      assert.equal(call.headers.get('authorization'),`Bearer ${h.state.bearer}`);
      return json(h.state.userinfo ?? {sub:'mock-only-owner'},h.state.userinfoStatus ?? 200,
        h.state.userinfoStatus===307 ? {location:'https://attacker.example.invalid/info'} : {});
    }
  };
  const claims={iss:issuer,aud:[base+'/mcp'],exp:RUNTIME_NOW+300,sub:'mock-only-owner',scope:'x:read',token_type:'access_token'};
  h.state.bearer=await fixture.sign(claims);
  return {...h,fixture,claims};
}

for(const alg of ['RS256','ES256']) test(`workerd Descope ${alg}: actual signature verification, UserInfo, X link and cached reads`,async t=>{
  const h=await descope(t,alg);
  await h.link(); await h.scheduled();
  const result=await h.call('x_read_mentions');
  assert.equal(result.body.result.isError,undefined); assert(JSON.stringify(result.body).includes('Mock mention'));
  assert.equal(h.state.calls.filter(v=>v.url.pathname==='/introspect').length,0);
  assert.equal(h.state.calls.filter(v=>v.url.pathname==='/keys').length,1);
  assert.equal(h.state.calls.filter(v=>v.url.pathname==='/apps/userinfo').length,2);
});

test('workerd Descope: invalid signatures, owner, issuer, audience, expiry and scopes never reach UserInfo',async t=>{
  const h=await descope(t);
  for(const change of [{iss:'https://other.invalid'},{aud:'https://api.x.com'},{exp:0},{sub:'other'},{scope:'openid'},
    {token_type:'id_token'},{token_type:'refresh_token'},{token_type:'Bearer'},{token_type:undefined}]) {
    h.state.bearer=await h.fixture.sign({...h.claims,...change});
    assert([401,403].includes((await h.call('x_connection_status')).response.status));
  }
  const parts=(await h.fixture.sign(h.claims)).split('.');
  parts[2]=(parts[2][0]==='A'?'B':'A')+parts[2].slice(1);h.state.bearer=parts.join('.');
  assert.equal((await h.call('x_connection_status')).response.status,401);
  assert.equal(h.state.calls.filter(v=>v.url.pathname==='/apps/userinfo').length,0);
  assert.equal(h.xCalls().length,0);
});

for(const status of [401,503,307]) test(`workerd Descope: live UserInfo ${status} blocks an otherwise valid JWT`,async t=>{
  const h=await descope(t);
  assert.equal((await h.call('x_connection_status')).response.status,200);
  h.state.userinfoStatus=status;
  const result=await h.call('x_connection_status');
  assert.equal(result.response.status,status===401?401:503); assert.equal(result.body.result.isError,true);
  assert.equal(h.state.calls.filter(v=>v.url.pathname==='/apps/userinfo').length,2);
  assert.equal(h.xCalls().length,0);
});

test('workerd Descope: UserInfo subject mismatch and endpoint substitution fail closed',async t=>{
  const h=await descope(t);h.state.userinfo={sub:'other'};
  assert.equal((await h.call('x_connection_status')).response.status,401);
  h.state.discovery.userinfo_endpoint='https://attacker.example.invalid/info';
  await h.restart();
  assert.equal((await h.call('x_connection_status')).response.status,503);
  assert.equal(h.state.calls.filter(v=>v.url.pathname==='/apps/userinfo').length,1);
});
