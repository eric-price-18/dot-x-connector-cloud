import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime, base, issuer, json } from './helpers.mjs';
import { basicAuth, digest, open } from '../src/security.mjs';

test('workerd: default gates, discovery, MCP negotiation and missing authentication', async t => {
  const h = await runtime(t, { LIVE_X_ENABLED: 'false', LIVE_IDP_ENABLED: 'false', READ_POLLING_ENABLED: 'false' });
  assert.equal((await h.api('/health')).status, 200);
  const meta = await (await h.api('/.well-known/oauth-protected-resource/mcp')).json();
  assert.equal(meta.resource, `${base}/mcp`); assert.deepEqual(meta.authorization_servers, [issuer]);
  const init = await (await h.mcp('initialize', { protocolVersion: '2025-11-25' }, false)).json();
  assert.equal(init.result.protocolVersion, '2025-11-25');
  const tools = await (await h.mcp('tools/list')).json();
  assert.equal(tools.result.tools.length, 3);
  assert.equal((await h.call('x_connection_status', {}, false)).response.status, 401);
  assert.equal((await h.call('x_connection_status')).response.status, 503);
  await h.scheduled();
  assert.equal(h.state.calls.length, 0);
});

test('workerd/local D1: PKCE callback is one-use, encrypted and durable after restart', async t => {
  const h = await runtime(t); const link = await h.start();
  assert.equal(link.url.searchParams.get('scope'), 'tweet.read users.read offline.access');
  assert.equal(link.url.searchParams.get('code_challenge_method'), 'S256');
  const responses = await Promise.all([h.complete(link), h.complete(link)]);
  assert.deepEqual(responses.map(v => v.status).sort(), [200, 400]);
  const tokens = h.xCalls().filter(v => v.url.pathname === '/2/oauth2/token');
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].headers.get('authorization'), basicAuth('mock-only-x-client', 'mock-only-x-secret'));
  assert.equal(await digest(new URLSearchParams(tokens[0].body).get('code_verifier')), link.url.searchParams.get('code_challenge'));
  const before = await h.db.prepare('SELECT * FROM accounts').first();
  assert.equal(before.x_user_id, '4242');
  assert(!before.encrypted_tokens.includes('mock-access'));
  assert.equal((await open(h.bindings.TOKEN_ENCRYPTION_KEY, before.encrypted_tokens,
    `account:primary:${issuer}:mock-only-owner:4242`)).refresh_token, 'mock-refresh-1');
  assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM oauth_states').first()).n, 0);
  await h.restart();
  assert.deepEqual(await h.db.prepare('SELECT * FROM accounts').first(), before);
  assert.equal((await h.complete(link)).status, 400);
  const status = await h.call('x_connection_status');
  assert.equal(status.body.result.isError, undefined);
  assert.equal(h.xCalls().length, 2);
});

test('workerd: strict IdP identity and X account pinning fail closed', async t => {
  const h = await runtime(t);
  h.state.identity.aud = 'https://other.example.invalid/mcp';
  assert.equal((await h.call('x_connection_status')).response.status, 401);
  h.state.identity = {};
  h.state.userId = '4343';
  const link = await h.start();
  const response = await h.complete(link);
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, 'X_ACCOUNT_BINDING_MISMATCH');
  assert.equal(await h.db.prepare('SELECT * FROM accounts').first(), null);
});

test('workerd/local D1: scheduled refresh rotates tokens and encrypts readable cached snapshots', async t => {
  const h = await runtime(t); await h.link();
  await h.db.prepare('UPDATE accounts SET expires_at=0').run();
  const before = h.xCalls().length;
  await h.scheduled();
  assert.equal(h.xCalls().length-before, 4);
  assert.equal(h.state.tokens, 2);
  const account = await h.db.prepare('SELECT * FROM accounts').first();
  assert.equal(account.version, 2); assert.equal(account.refresh_status, 'idle');
  const rows = (await h.db.prepare('SELECT * FROM snapshots').all()).results;
  assert.equal(rows.length, 2);
  for (const row of rows) assert(!row.encrypted_payload.includes('Mock'));
  const count = h.xCalls().length;
  const cached = await h.call('x_read_mentions');
  assert.equal(cached.body.result.isError, undefined);
  assert(JSON.stringify(cached.body).includes('Mock mention'));
  assert.equal(h.xCalls().length, count);
  await h.restart();
  assert(JSON.stringify((await h.call('x_read_posts')).body).includes('Mock original post'));
});

test('workerd/local D1: simultaneous polls make one refresh and one pair of reads', async t => {
  const h = await runtime(t); await h.link();
  await h.db.prepare('UPDATE accounts SET expires_at=0').run();
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  h.state.onX = async call => { if (call.url.pathname === '/2/oauth2/token') { enter(); await blocked; } };
  const first = h.api('/admin/poll', { method: 'POST', auth: true });
  await entered;
  try {
    const second = await h.api('/admin/poll', { method: 'POST', auth: true });
    assert.equal(second.status, 409);
    assert.equal((await second.json()).error, 'POLL_IN_PROGRESS');
  } finally { release(); }
  assert.equal((await first).status, 200);
  assert.equal(h.state.tokens, 2);
  assert.equal(h.xCalls().filter(v => v.url.pathname.endsWith('/mentions')).length, 1);
});

test('workerd/local D1: original sends are gated independently and tombstones survive restart', async t => {
  const h = await runtime(t, { POST_ENABLED: 'true' });
  h.state.scope = 'x:read x:post'; h.state.xScopes += ' tweet.write';
  await h.link('post');
  const args = { text: 'Mock original', idempotency_key: 'runtime-test-key-0001' };
  const responses = await Promise.all([h.call('x_create_post', args), h.call('x_create_post', args)]);
  assert(responses.some(v => !v.body.result.isError));
  assert.equal(h.xCalls().filter(v => v.url.pathname === '/2/tweets').length, 1);
  assert.equal((await h.call('x_reply_to_post', { ...args, in_reply_to_post_id: '1002' })).body.error.message, 'UNKNOWN_OR_DISABLED_TOOL');
  await h.restart();
  const repeated = await h.call('x_create_post', args);
  assert(JSON.stringify(repeated.body).includes('duplicate'));
  const otherKey = await h.call('x_create_post', { ...args, idempotency_key: 'runtime-test-key-0002' });
  assert.equal(otherKey.body.result.content[0].text, 'DUPLICATE_CONTENT_DO_NOT_RESEND');
  assert.equal(h.xCalls().filter(v => v.url.pathname === '/2/tweets').length, 1);
});

test('workerd/local D1: 429 cooldown persists and suppresses another outbound attempt', async t => {
  const h = await runtime(t); await h.link();
  h.state.onX = call => call.url.pathname.endsWith('/mentions') ? json({}, 429, { 'retry-after': '120' }) : undefined;
  assert.equal((await h.api('/admin/poll', { method: 'POST', auth: true })).status, 429);
  const count = h.xCalls().length;
  await h.restart();
  const blocked = await h.api('/admin/poll', { method: 'POST', auth: true });
  assert.equal((await blocked.json()).error, 'X_RATE_LIMIT_COOLDOWN');
  assert.equal(h.xCalls().length, count);
});

for (const endpoint of ['/.well-known/oauth-authorization-server', '/introspect'])
  test(`workerd: IdP ${endpoint} redirect is rejected without credential forwarding`, async t => {
    const h = await runtime(t);
    h.state.onIdp = call => call.url.pathname === endpoint
      ? json({}, 307, { location: 'https://redirect-target.example.invalid/steal' }) : undefined;
    const result = await h.call('x_connection_status');
    assert.equal(result.response.status, endpoint === '/introspect' ? 503 : 502);
    assert.equal(result.body.result.isError, true);
    assert.equal(h.xCalls().length, 0);
    assert(h.state.calls.every(v => v.url.origin === issuer));
  });

test('workerd: X token redirect is rejected and consumed state cannot be retried', async t => {
  const h = await runtime(t); const link = await h.start();
  h.state.onX = () => json({}, 307, { location: 'https://redirect-target.example.invalid/steal' });
  assert.equal((await h.complete(link)).status, 502);
  assert.equal((await h.complete(link)).status, 400);
  assert.equal(h.xCalls().length, 1);
  assert.equal(await h.db.prepare('SELECT * FROM accounts').first(), null);
});

test('workerd/local D1: daily budget exhaustion prevents provider calls', async t => {
  const h = await runtime(t, { MAX_X_REQUESTS_DAY: '2' });
  await h.link();
  const response = await h.api('/admin/poll', { method: 'POST', auth: true });
  assert.equal(response.status, 429);
  assert.equal((await response.json()).error, 'LOCAL_BUDGET_EXHAUSTED');
  assert.equal(h.xCalls().length, 2);
  const day = await h.db.prepare("SELECT used FROM budgets WHERE bucket LIKE 'requests:day:%'").first();
  assert.equal(day.used, 2);
});

test('workerd/local D1: legacy reply flag cannot bypass written X approval', async t => {
  const h=await runtime(t,{REPLY_ENABLED:'true'});
  h.state.scope='x:read x:reply';h.state.xScopes+=' tweet.write';
  const attempt=await h.api('/x/connect',{method:'POST',auth:true,data:{mode:'reply'}});
  assert.equal((await attempt.json()).error,'REPLY_DISABLED_OR_UNAUTHORIZED');
  assert.equal((await h.call('x_reply_to_post',{text:'Mock reply',idempotency_key:'runtime-reply-key-01',in_reply_to_post_id:'1002'})).body.error.message,'UNKNOWN_OR_DISABLED_TOOL');
  assert.equal(h.xCalls().length,0);
});

test('workerd/local D1: uncertain send retains its tombstone through restart', async t => {
  const h = await runtime(t, { POST_ENABLED: 'true' });
  h.state.scope = 'x:read x:post'; h.state.xScopes += ' tweet.write';
  await h.link('post');
  // An invalid success body models loss of a usable receipt after remote create.
  h.state.onX = call => call.url.pathname === '/2/tweets' ? json({}, 201) : undefined;
  const args = { text: 'Mock uncertain', idempotency_key: 'runtime-uncertain-01' };
  assert.equal((await h.call('x_create_post', args)).body.result.isError, true);
  assert.equal((await h.db.prepare('SELECT status FROM sends').first()).status, 'uncertain');
  await h.restart();
  assert.equal((await h.call('x_create_post', args)).body.result.content[0].text, 'SEND_PENDING_OR_UNCERTAIN_DO_NOT_RETRY');
  assert.equal(h.xCalls().filter(v => v.url.pathname === '/2/tweets').length, 1);
});

test('workerd/local D1: ambiguous refresh requires reconnect even after restart', async t => {
  const h = await runtime(t); await h.link();
  await h.db.prepare('UPDATE accounts SET expires_at=0').run();
  h.state.onX = call => call.url.pathname === '/2/oauth2/token' ? json({}, 200) : undefined;
  assert.equal((await h.api('/admin/poll', { method: 'POST', auth: true })).status, 502);
  assert.equal((await h.db.prepare('SELECT refresh_status FROM accounts').first()).refresh_status, 'reconnect');
  const count = h.xCalls().length;
  await h.restart();
  assert.equal((await h.api('/admin/poll', { method: 'POST', auth: true })).status, 409);
  assert.equal(h.xCalls().length, count);
});

test('workerd/local D1: expired browser state fails before code exchange', async t => {
  const h = await runtime(t); const link = await h.start();
  await h.db.prepare('UPDATE oauth_states SET expires_at=0').run();
  const response = await h.complete(link);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'OAUTH_STATE_INVALID_OR_EXPIRED');
  assert.equal(h.xCalls().length, 0);
});
