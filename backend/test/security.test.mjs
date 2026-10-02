import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, accidentalNetwork, rejectsCode, response } from './helpers.mjs';
import { b64url, configuration, digest, open, seal, readBody } from '../src/security.mjs';
import { createAuthenticator } from '../src/identity.mjs';
import { createWorker } from '../src/worker.mjs';

test('AES-GCM round trip, fresh IVs, no plaintext, and authenticated context', async t => {
  const h = harness(t);
  const secret = { access_token: 'mock-private-token' };
  const one = await seal(h.env.TOKEN_ENCRYPTION_KEY, secret, 'context-a');
  const two = await seal(h.env.TOKEN_ENCRYPTION_KEY, secret, 'context-a');
  assert.notEqual(one, two);
  assert(!one.includes(secret.access_token));
  assert.deepEqual(await open(h.env.TOKEN_ENCRYPTION_KEY, one, 'context-a'), secret);
  await rejectsCode(open(h.env.TOKEN_ENCRYPTION_KEY, one, 'context-b'), 'ENCRYPTED_STORAGE_INVALID');
  await rejectsCode(open(b64url(new Uint8Array(32).fill(8)), one, 'context-a'), 'ENCRYPTED_STORAGE_INVALID');
  const tampered = JSON.parse(one);
  tampered.data = (tampered.data[0] === 'A' ? 'B' : 'A')+tampered.data.slice(1);
  await rejectsCode(open(h.env.TOKEN_ENCRYPTION_KEY, JSON.stringify(tampered), 'context-a'), 'ENCRYPTED_STORAGE_INVALID');
});

test('encrypted snapshots support larger bounded payloads', async t => {
  const h = harness(t);
  const data = { text: 'x'.repeat(300000) };
  const encrypted = await seal(h.env.TOKEN_ENCRYPTION_KEY, data, 'large');
  assert.deepEqual(await open(h.env.TOKEN_ENCRYPTION_KEY, encrypted, 'large'), data);
});

test('PKCE uses the RFC 7636 S256 vector', async () => {
  assert.equal(await digest('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});

test('missing configuration fails closed while health stays harmless', async t => {
  const h = harness(t);
  const res = await h.worker.fetch(h.request('/mcp', { method:'POST', data:{} }), {});
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.message, 'CONFIGURATION_REQUIRED');
  assert.equal((await h.worker.fetch(h.request('/health'), {})).status, 200);
  assert.equal(h.state.idpCalls.length+h.state.xCalls.length, 0);
});

test('HTTPS, canonical base and pinned IdP origins are mandatory', t => {
  const h = harness(t);
  for (const changes of [
    { PUBLIC_BASE_URL:'http://localhost' }, { PUBLIC_BASE_URL:`${h.cfg.base}/` },
    { PUBLIC_BASE_URL:`${h.cfg.base}/wrong` }, { MCP_INTROSPECTION_URL:'https://attacker.invalid/introspect' },
    { MCP_DISCOVERY_URL:`${h.cfg.discovery}?token=bad` }
  ]) assert.throws(() => configuration({ ...h.env, ...changes }));
});

test('production defaults block IdP and X egress before network or consent URL', async t => {
  const h = harness(t);
  const defaultWorker = createWorker({ clock:h.clock, logger:()=>{} });
  const res = await defaultWorker.fetch(h.request('/mcp', { method:'POST', auth:true,
    headers:{ accept:'application/json, text/event-stream' }, data:{ jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'x_connection_status'} } }), h.env);
  assert.equal(res.status, 503);
  assert.equal((await res.json()).result.content[0].text, 'LIVE_IDP_DISABLED');
  const idpOnly = createWorker({ clock:h.clock, idpFetch:h.idpFetch, logger:()=>{} });
  const link = await idpOnly.fetch(h.request('/x/connect', { method:'POST',auth:true,data:{} }), h.env);
  assert.equal(link.status, 503);
  assert.equal((await link.json()).error, 'LIVE_X_DISABLED');
  assert.equal(accidentalNetwork.length, 0);
  assert.equal(h.db.all('SELECT * FROM oauth_states').length, 0);
});

for (const [name, claims, code] of [
  ['inactive', { active:false }, 'TOKEN_INVALID_OR_EXPIRED'],
  ['wrong issuer', { iss:'https://wrong.invalid' }, 'TOKEN_INVALID_OR_EXPIRED'],
  ['wrong audience', { aud:'https://api.x.com' }, 'TOKEN_INVALID_OR_EXPIRED'],
  ['missing audience', { aud:null }, 'TOKEN_INVALID_OR_EXPIRED'],
  ['expired', { exp:0 }, 'TOKEN_INVALID_OR_EXPIRED'],
  ['missing expiry', { exp:null }, 'TOKEN_INVALID_OR_EXPIRED'],
  ['future nbf', { nbf:9999999999 }, 'TOKEN_INVALID_OR_EXPIRED'],
  ['blank subject', { sub:'' }, 'TOKEN_INVALID_OR_EXPIRED'],
  ['wrong owner', { sub:'other-owner' }, 'OWNER_BINDING_MISMATCH'],
  ['missing scope', { scope:'openid' }, 'INSUFFICIENT_SCOPE']
]) test(`MCP bearer rejects ${name}`, async t => {
  const h = harness(t); h.state.identity = claims;
  const auth = createAuthenticator(h.idpFetch, h.clock);
  await rejectsCode(auth(h.request('/mcp',{auth:true}), h.env), code);
  assert.equal(h.state.xCalls.length, 0);
});

test('introspection validates an audience array and rechecks every invocation', async t => {
  const h = harness(t); h.state.identity = { aud:['unrelated',h.cfg.resource] };
  const auth = createAuthenticator(h.idpFetch,h.clock);
  assert.equal((await auth(h.request('/mcp',{auth:true}),h.env)).subject,h.env.MCP_ALLOWED_SUBJECT);
  h.state.identity.active = false;
  await rejectsCode(auth(h.request('/mcp',{auth:true}),h.env),'TOKEN_INVALID_OR_EXPIRED');
  assert.equal(h.state.idpCalls.filter(v=>v.url===h.cfg.discovery).length,1);
  assert.equal(h.state.idpCalls.filter(v=>v.url===h.cfg.introspection).length,2);
});

for (const [name, discovery] of [
  ['no S256', {code_challenge_methods_supported:['plain']}],
  ['no authorization code', {response_types_supported:['token']}],
  ['wrong issuer', {issuer:'https://wrong.invalid'}],
  ['wrong introspection', {introspection_endpoint:'https://wrong.invalid'}],
  ['malformed PKCE metadata', {code_challenge_methods_supported:'S256'}],
  ['malformed response-type metadata', {response_types_supported:'authorization_code'}],
  ['insecure registration endpoint', {registration_endpoint:'http://identity.example.invalid/register'}],
  ['no client registration', {client_id_metadata_document_supported:false}]
]) test(`incompatible identity provider fails closed: ${name}`, async t => {
  const h = harness(t); h.state.discovery = discovery;
  const res = await h.call('x_connection_status');
  assert.equal(res.response.status,503);
  assert.equal(h.state.xCalls.length,0);
});

test('identity-provider outage does not grant access', async t => {
  const h = harness(t);
  h.state.onIdp = url => url===h.cfg.introspection ? response({private:'must not surface'},503) : undefined;
  const res = await h.call('x_connection_status');
  assert.equal(res.response.status,503);
  assert.equal(res.body.result.content[0].text,'IDENTITY_PROVIDER_UNAVAILABLE');
  assert(!JSON.stringify(res.body).includes('must not surface'));
});

test('account binding cannot be replaced by another identity or X user', async t => {
  const h = harness(t); await h.seed();
  await rejectsCode(h.store.saveAccount(h.cfg.issuer,'other-owner','4242','bad',h.state.now+100),'ACCOUNT_BINDING_MISMATCH');
  await rejectsCode(h.store.saveAccount(h.cfg.issuer,h.env.MCP_ALLOWED_SUBJECT,'4343','bad',h.state.now+100),'ACCOUNT_BINDING_MISMATCH');
  assert.equal((await h.store.account()).x_user_id,'4242');
});

test('body limits reject oversized declared and streamed input', async () => {
  await rejectsCode(readBody(new Request('https://example.invalid',{method:'POST',headers:{'content-length':'20000'},body:'x'})), 'REQUEST_TOO_LARGE');
  await rejectsCode(readBody(new Request('https://example.invalid',{method:'POST',body:'x'.repeat(20000)})), 'REQUEST_TOO_LARGE');
});

test('redacted logs never contain errors, query codes, credentials or post text', async t => {
  const h = harness(t,{POST_ENABLED:'true'});
  h.state.mcpScopes = 'x:read x:post';
  await h.seed({scopes:['tweet.read','users.read','offline.access','tweet.write']});
  h.state.onX = () => { throw new Error('mock-secret access_token mock-private-content'); };
  const res = await h.call('x_create_post',{text:'mock-private-content',idempotency_key:'mock-redaction-key'});
  assert.equal(res.body.result.isError,true);
  const output = h.state.logs.join(' ')+JSON.stringify(res.body);
  for (const value of ['mock-secret','access_token','mock-private-content','mock-seeded-access',h.env.X_CLIENT_SECRET]) assert(!output.includes(value));
  assert(h.state.logs.every(line=>Object.keys(JSON.parse(line)).join(',')==='event,code'));
});

test('scheduled exceptions are sanitized before reaching platform exception logging', async t => {
  const h=harness(t,{READ_POLLING_ENABLED:'true'});
  h.db.beforeQuery=()=>{throw new Error('mock-private-database-error');};
  await assert.rejects(h.worker.scheduled({},h.env,{}),error=>error.code==='INTERNAL_ERROR' && !error.stack.includes('mock-private-database-error'));
  assert(!h.state.logs.join(' ').includes('mock-private-database-error'));
});
