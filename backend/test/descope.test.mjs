import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, response, rejectsCode } from './helpers.mjs';
import { signingFixture } from './jwt-fixtures.mjs';
import { createAuthenticator } from '../src/identity.mjs';
import { configuration } from '../src/security.mjs';
import { invalidToken, tokenErrorReference } from '../src/jwt.mjs';

test('token diagnostics accept only fixed internal references and keep generic public errors',()=>{
  for(const reference of ['TOKEN_ISSUER_MISMATCH','JWT_SIGNATURE_INVALID']) {
    const error=invalidToken(reference);
    assert.equal(error.code,'TOKEN_INVALID_OR_EXPIRED');assert.equal(error.status,401);
    assert.equal(tokenErrorReference(error),reference);
    assert(!JSON.stringify(error).includes(reference));
  }
  for(const reference of ['private-token-claim','https://private.invalid',null,'UNTRUSTED_CODE'])
    assert.equal(tokenErrorReference(invalidToken(reference)),undefined);
  assert.equal(tokenErrorReference(new Error('private-provider-message')),undefined);
});

async function descope(t, alg = 'RS256') {
  const h = harness(t, { MCP_AUTH_MODE: 'descope', MCP_JWT_ALG: alg,
    MCP_JWKS_URL: 'https://identity.example.invalid/.well-known/jwks.json',
    MCP_USERINFO_URL: 'https://identity.example.invalid/apps/userinfo',
    MCP_INTROSPECTION_CLIENT_ID: undefined, MCP_INTROSPECTION_CLIENT_SECRET: undefined,
    MCP_INTROSPECTION_URL: undefined });
  const signing = await signingFixture(alg);
  const state = { jwks: { keys: [signing.jwk] }, userinfo: { sub: h.env.MCP_ALLOWED_SUBJECT },
    status: 200, headers: {}, onKeys: null };
  h.state.discovery = { jwks_uri: h.cfg.jwks, userinfo_endpoint: h.cfg.userinfo };
  h.state.onIdp = async (url, options) => {
    if (url === h.cfg.jwks) {
      await state.onKeys?.(); assert.equal(options.headers.authorization, undefined);
      return response(state.jwks);
    }
    if (url === h.cfg.userinfo) {
      assert.equal(options.method, 'GET'); assert(options.headers.authorization.startsWith('Bearer '));
      return response(state.userinfo, state.status, state.headers);
    }
  };
  const claims = { iss: h.cfg.issuer, aud: h.cfg.resource, sub: h.env.MCP_ALLOWED_SUBJECT,
    exp: h.state.now+300, iat: h.state.now, scope: 'x:read', token_type:'access_token' };
  const auth = createAuthenticator(h.idpFetch, h.clock);
  const request = token => h.request('/mcp', { headers: { authorization: `Bearer ${token}` } });
  return { ...h, signing, state, claims, advance: seconds => { h.state.now += seconds; },
    sign: (changes = {}, header = {}) => signing.sign({ ...claims,...changes },header),
    authenticate: token => auth(request(token), h.env), request, auth,
    count: path => h.state.idpCalls.filter(v => v.url === h.cfg[path]).length };
}

for (const alg of ['RS256','ES256']) test(`Descope ${alg}: signed resource token plus live UserInfo needs no client secret`, async t => {
  const h = await descope(t, alg); const token = await h.sign();
  assert.equal((await h.authenticate(token)).subject, h.env.MCP_ALLOWED_SUBJECT);
  await h.authenticate(token);
  assert.equal(h.count('discovery'), 1); assert.equal(h.count('jwks'), 1); assert.equal(h.count('userinfo'), 2);
  assert.equal(h.count('introspection'), 0);
});

test('token diagnostics distinguish verification and claim failures without changing rejection',async t=>{
  const h=await descope(t);
  for(const [claims,header,reference] of [
    [{iss:'https://mock-private.invalid'},{},'TOKEN_ISSUER_MISMATCH'],
    [{aud:'https://mock-private.invalid'},{},'TOKEN_AUDIENCE_MISMATCH'],
    [{exp:0},{},'TOKEN_EXPIRED'],
    [{nbf:9999999999},{},'TOKEN_NOT_YET_VALID'],
    [{iat:9999999999},{},'TOKEN_ISSUED_IN_FUTURE'],
    [{},{alg:'HS256'},'JWT_ALGORITHM_MISMATCH'],
    [{},{kid:'mock-unknown'},'JWT_KEY_NOT_FOUND'],
    [{},{typ:'mock-wrong-type'},'JWT_TYPE_INVALID']
  ]) {
    await assert.rejects(h.authenticate(await h.sign(claims,header)),error=>{
      assert.equal(error.code,'TOKEN_INVALID_OR_EXPIRED');assert.equal(tokenErrorReference(error),reference);
      assert(!JSON.stringify(error).includes('mock-private'));return true;
    });
  }
  assert.equal(h.count('userinfo'),0);
});

test('Descope accepts only the documented signed access_token class, not OAuth transport or other token classes',async t=>{
  const h=await descope(t);
  assert.equal((await h.authenticate(await h.sign())).subject,h.env.MCP_ALLOWED_SUBJECT);
  for(const token_type of ['Bearer','bearer','id_token','refresh_token','access',undefined,null,1,{}]) {
    await assert.rejects(h.authenticate(await h.sign({token_type})),error=>
      error.code==='TOKEN_INVALID_OR_EXPIRED' && tokenErrorReference(error)==='TOKEN_TYPE_INVALID');
  }
  assert.equal(h.count('userinfo'),1);
});

for (const [name, change, code] of [
  ['wrong issuer', {iss:'https://other.invalid'}, 'TOKEN_INVALID_OR_EXPIRED'],
  ['wrong audience', {aud:'https://api.x.com'}, 'TOKEN_INVALID_OR_EXPIRED'],
  ['no audience', {aud:null}, 'TOKEN_INVALID_OR_EXPIRED'],
  ['expired', {exp:0}, 'TOKEN_INVALID_OR_EXPIRED'],
  ['string expiry', {exp:'9999999999'}, 'TOKEN_INVALID_OR_EXPIRED'],
  ['missing expiry', {exp:undefined}, 'TOKEN_INVALID_OR_EXPIRED'],
  ['future nbf', {nbf:9999999999}, 'TOKEN_INVALID_OR_EXPIRED'],
  ['future issued-at', {iat:9999999999}, 'TOKEN_INVALID_OR_EXPIRED'],
  ['no owner', {sub:''}, 'TOKEN_INVALID_OR_EXPIRED'],
  ['other owner with same email', {sub:'other',email:'owner@example.invalid'}, 'OWNER_BINDING_MISMATCH'],
  ['no tool scope', {scope:'openid'}, 'INSUFFICIENT_SCOPE'],
  ['array scope', {scope:['x:read']}, 'INSUFFICIENT_SCOPE']
]) test(`Descope rejects ${name} before UserInfo`, async t => {
  const h = await descope(t); await rejectsCode(h.authenticate(await h.sign(change)),code);
  assert.equal(h.count('userinfo'),0);
});

for (const [name, header] of [
  ['unsigned algorithm',{alg:'none'}], ['HMAC confusion',{alg:'HS256'}],
  ['unpinned algorithm',{alg:'ES256'}], ['unknown key',{kid:'other-key'}], ['missing kid',{kid:undefined}],
  ['embedded JWK',{jwk:{kty:'oct',k:'mock'}}], ['remote jku',{jku:'https://attacker.invalid/key'}],
  ['remote x5u',{x5u:'https://attacker.invalid/cert'}], ['critical extension',{crit:['mock']}],
  ['unencoded payload',{b64:false}], ['wrong token type',{typ:'refresh'}]
]) test(`Descope rejects ${name}`, async t => {
  const h = await descope(t); await rejectsCode(h.authenticate(await h.sign({},header)),'TOKEN_INVALID_OR_EXPIRED');
  assert.equal(h.count('userinfo'),0);
});

test('Descope rejects altered signature and malformed JWTs', async t => {
  const h = await descope(t); const token = await h.sign();
  const parts = token.split('.');
  parts[2] = (parts[2][0] === 'A' ? 'B' : 'A')+parts[2].slice(1);
  for (const bad of [parts.join('.'),'abc.def.ghi','opaque-token'])
    await rejectsCode(h.authenticate(bad),'TOKEN_INVALID_OR_EXPIRED');
  assert.equal(h.count('userinfo'),0);
});

for (const [name, change] of [
  ['duplicate kid', key => ({ keys:[key,key] })], ['empty JWKS', () => ({keys:[]})],
  ['encryption key', key => ({keys:[{...key,use:'enc'}]})],
  ['wrong JWK alg', key => ({keys:[{...key,alg:'HS256'}]})],
  ['private key material', key => ({keys:[{...key,d:'private-mock'}]})],
  ['bad key operations', key => ({keys:[{...key,key_ops:['sign']}]})],
  ['weak RSA modulus', key => ({keys:[{...key,n:Buffer.alloc(128,255).toString('base64url')}]})]
]) test(`Descope rejects ${name}`, async t => {
  const h=await descope(t); h.state.jwks=change(h.signing.jwk);
  await assert.rejects(h.authenticate(await h.sign())); assert.equal(h.count('userinfo'),0);
});

for (const [name, status, info, code] of [
  ['revocation',401,{},'TOKEN_INVALID_OR_REVOKED'], ['forbidden',403,{},'TOKEN_INVALID_OR_REVOKED'],
  ['outage',503,{},'IDENTITY_PROVIDER_UNAVAILABLE'], ['rate limit',429,{},'IDENTITY_PROVIDER_UNAVAILABLE'],
  ['redirect',307,{},'IDENTITY_PROVIDER_UNAVAILABLE'], ['missing subject',200,{},'USERINFO_SUBJECT_MISMATCH'],
  ['subject mismatch',200,{sub:'other'},'USERINFO_SUBJECT_MISMATCH'],
  ['removed scope',200,{sub:'mock-only-owner',scope:'openid'},'INSUFFICIENT_SCOPE']
]) test(`Descope UserInfo ${name} denies access without JWT-only fallback`, async t => {
  const h=await descope(t); const token=await h.sign(); await h.authenticate(token);
  h.state.status=status; h.state.userinfo=info; h.state.headers={location:'https://attacker.invalid/steal'};
  await rejectsCode(h.authenticate(token),code); assert.equal(h.count('userinfo'),2);
});

test('Descope endpoint pins and algorithm are required; no introspection fallback', async t => {
  const h=await descope(t);
  for(const changes of [{MCP_JWKS_URL:undefined},{MCP_USERINFO_URL:undefined},{MCP_ALLOWED_SUBJECT:''},
    {MCP_JWT_ALG:undefined},{MCP_JWT_ALG:'HS256'},{MCP_USERINFO_URL:'https://attacker.invalid/info'},
    {MCP_JWKS_URL:'https://attacker.invalid/keys'}]) assert.throws(()=>configuration({...h.env,...changes}));
});

test('Descope validates advertised endpoints against operator pins', async t => {
  const h=await descope(t);
  const fetch = async (url, options) => url === h.cfg.discovery
    ? response({ issuer:h.cfg.issuer, code_challenge_methods_supported:['S256'],response_types_supported:['code'],
      authorization_endpoint:`${h.cfg.issuer}/authorize`,token_endpoint:`${h.cfg.issuer}/token`,
      jwks_uri:h.cfg.jwks,userinfo_endpoint:'https://attacker.invalid/steal',client_id_metadata_document_supported:true })
    : h.idpFetch(url,options);
  await rejectsCode(createAuthenticator(fetch,h.clock)(h.request(await h.sign()),h.env),'IDP_JWT_ENDPOINT_MISMATCH');
  assert.equal(h.count('userinfo'),0);
});

test('Descope JWKS cache expires, unknown kids do not trigger fetch storms, rotation recovers', async t => {
  const h=await descope(t); const token=await h.sign(); await h.authenticate(token);
  const rotated = await signingFixture('RS256','mock-rotated-key');
  const next = await rotated.sign({...h.claims,exp:h.clock()+1000});
  h.state.jwks={keys:[rotated.jwk]};
  for(let i=0;i<3;i++) await rejectsCode(h.authenticate(next),'TOKEN_INVALID_OR_EXPIRED');
  assert.equal(h.count('jwks'),1);
  h.advance(301);
  assert.equal((await h.authenticate(next)).subject,h.env.MCP_ALLOWED_SUBJECT);
  assert.equal(h.count('jwks'),2);
});

test('Descope concurrent verification shares one JWKS fetch', async t => {
  const h=await descope(t); const token=await h.sign();
  let release, entered;
  const wait=new Promise(resolve=>{release=resolve;}); const arriving=new Promise(resolve=>{entered=resolve;});
  h.state.onKeys=async()=>{entered();await wait;};
  const first=h.authenticate(token); await arriving; const second=h.authenticate(token); release();
  await Promise.all([first,second]); assert.equal(h.count('jwks'),1); assert.equal(h.count('userinfo'),2);
});

test('Descope live scopes narrow all returned permissions and cannot add a signed permission',async t=>{
  const h=await descope(t);h.state.userinfo.scope='x:read x:reply';
  const identity=await h.authenticate(await h.sign({scope:'x:read x:post'}));
  assert.deepEqual(identity.scopes,['x:read']);
});

test('Descope expired JWKS cache never falls back to stale keys on provider outage',async t=>{
  const h=await descope(t);const token=await h.sign({exp:h.clock()+1000});await h.authenticate(token);
  h.advance(301);h.state.onKeys=()=>{throw new Error('mock-private-provider-error');};
  await rejectsCode(h.authenticate(token),'IDENTITY_PROVIDER_UNAVAILABLE');
  assert.equal(h.count('userinfo'),1);
});

test('Descope rechecks expiration after UserInfo latency',async t=>{
  const h=await descope(t);const token=await h.sign({exp:h.clock()+2});
  const original=h.idpFetch;
  const auth=createAuthenticator(async(url,options)=>{
    const result=await original(url,options);if(url===h.cfg.userinfo)h.advance(3);return result;
  },h.clock);
  await rejectsCode(auth(h.request(token),h.env),'TOKEN_INVALID_OR_EXPIRED');
});
