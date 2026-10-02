import test from 'node:test';
import assert from 'node:assert/strict';
import { RUNTIME_NOW } from './clock-fixture.mjs';
import { runtime, json } from './helpers.mjs';
import { writeFixture, writeScopes, key } from '../test/write-fixtures.mjs';
import { replyData, lookupResponse, replyArgs } from '../test/reply-fixtures.mjs';
import { seal } from '../src/security.mjs';
import { ownerContext } from '../src/reads.mjs';
import { CREDIT_RUN_DEADLINE } from './credit-fixture.mjs';

const now = () => RUNTIME_NOW;
const post = (n = 1) => ({ text: `Runtime credit original ${n}`, idempotency_key: key(n) });
const CAP = 'x_credit_cap_reached_or_changed';
const AUTH = 'x_credit_authorization_required';
const ledger = h => h.db.prepare('SELECT * FROM x_credit_budgets').first();
const used = async h => (await ledger(h))?.used_micro_usd ?? 0;

async function setup(t, overrides = {}) {
  // Both the test clock and synthetic credit window are fixed constants.
  assert(now() + 15 < CREDIT_RUN_DEADLINE, 'The synthetic fixture window must contain the fixed test time');
  const f = await writeFixture(now());
  const h = await runtime(t, { ...f.env,
    X_CALLBACK_URL: new URL(f.env.PUBLIC_BASE_URL).origin + '/x/callback',
    X_CREDIT_INITIAL_MICROUSD: '0', MAX_X_REQUESTS_DAY: '100', MAX_X_REQUESTS_HOUR: '20',
    ...overrides });
  async function seedAccount(expires = h.clock() + 7200) {
    const encrypted = await seal(h.bindings.TOKEN_ENCRYPTION_KEY, {
      access_token: 'runtime-credit-mock-access', refresh_token: 'runtime-credit-mock-refresh', scopes: writeScopes
    }, ownerContext(h.bindings));
    await h.db.prepare(`INSERT INTO accounts
      (id,issuer,subject,x_user_id,encrypted_tokens,expires_at,updated_at)
      VALUES('primary',?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      x_user_id=excluded.x_user_id,encrypted_tokens=excluded.encrypted_tokens,
      expires_at=excluded.expires_at,refresh_status='idle',refresh_attempt=NULL`)
      .bind(h.bindings.MCP_ISSUER, h.bindings.MCP_ALLOWED_SUBJECT, h.bindings.X_EXPECTED_USER_ID,
        encrypted, expires, h.clock()).run();
  }
  await seedAccount();
  async function call(name, args) {
    const request = await f.request(name, args, { iat: h.clock(), exp: h.clock() + 45 });
    const response = await h.mf.dispatchFetch(request.url, { method: request.method,
      headers: request.headers, redirect: 'manual', body: await request.arrayBuffer() });
    const body = await response.json();
    return { response, body, receipt: body.result?.structuredContent };
  }
  const sends = () => h.xCalls().filter(v => v.method === 'POST' && v.url.pathname !== '/2/oauth2/token');
  return { ...h, call, seedAccount, sends, get db() { return h.db; } };
}

test('workerd credit: concurrent distinct writes reserve remaining spend atomically across durable restart', async t => {
  const h = await setup(t, { X_CREDIT_INITIAL_MICROUSD: '4600000' });
  const results = await Promise.all(Array.from({ length: 16 }, (_, i) => h.call('x_create_original_post', post(i + 1))));
  assert.equal(results.filter(v => v.receipt.state === 'succeeded').length, 2);
  assert.equal(results.filter(v => v.receipt.code === CAP).length, 14);
  assert.equal(h.sends().length, 2);
  const before = await ledger(h);
  assert.equal(before.used_micro_usd, 5_000_000);
  assert.equal(before.initial_micro_usd, 4_600_000);
  await h.restart();
  assert.deepEqual(await ledger(h), before);
  assert.equal((await h.call('x_create_original_post', post(17))).receipt.code, CAP);
  assert.equal(h.sends().length, 2);
});

for (const initial of ['4800001', '5000000'])
  test(`workerd credit: first unaffordable call pins initial=${initial} before any X egress`, async t => {
    const h = await setup(t, { X_CREDIT_INITIAL_MICROUSD: initial });
    assert.equal((await h.call('x_create_original_post', post())).receipt.code, CAP);
    const before = await ledger(h);
    assert.equal(before.used_micro_usd, Number(initial));
    const original = { ...h.bindings };
    let n = 2;
    for (const changed of [
      { X_CREDIT_INITIAL_MICROUSD: '0' },
      { X_CREDIT_CAP_MICROUSD: '4999999', X_CREDIT_INITIAL_MICROUSD: '0' },
      { X_CREDIT_EXPIRES_AT: String(CREDIT_RUN_DEADLINE - 1), X_CREDIT_INITIAL_MICROUSD: '0' }
    ]) {
      Object.assign(h.bindings, original, changed);
      await h.restart();
      assert.equal((await h.call('x_create_original_post', post(n++))).receipt.code, CAP);
      assert.deepEqual(await ledger(h), before);
    }
    assert.equal(h.state.calls.length, 0);
  });

for (const [field, value, expected] of [
  ['X_CREDIT_BUDGET_ID', 'test-invalid-new-budget', AUTH],
  ['X_CREDIT_CAP_MICROUSD', '4999999', CAP],
  ['X_CREDIT_EXPIRES_AT', String(CREDIT_RUN_DEADLINE - 1), CAP],
  ['X_CREDIT_INITIAL_MICROUSD', '1', CAP],
  ['X_EXPECTED_USER_ID', '4343', CAP]
]) test(`workerd credit: persisted authorization rejects changed ${field}`, async t => {
  const h = await setup(t);
  assert.equal((await h.call('x_create_original_post', post())).receipt.state, 'succeeded');
  const before = await ledger(h);
  h.bindings[field] = value;
  if (field === 'X_EXPECTED_USER_ID') {
    h.bindings.SERVICE_X_ACCOUNT_ID = value;
    await h.seedAccount(); // A valid new mock account still cannot reuse/reset the prior credit authorization.
  }
  await h.restart();
  const next = await h.call('x_create_original_post', post(2));
  assert.equal(next.receipt.code, expected, JSON.stringify(next.body));
  assert.deepEqual(await ledger(h), before);
  assert.equal(h.sends().length, 1);
});

test('workerd credit: original, repost, reply, cached reads and refresh share one nonrefunded ledger', async t => {
  const h = await setup(t, { REPLY_ENABLED: 'true', X_OWN_THREAD_REPLIES_ENABLED: 'true', READ_POLLING_ENABLED: 'true' });
  const data = replyData(now());
  const charges = [];
  h.state.xScopes = writeScopes.join(' ');
  h.state.onX = async call => {
    charges.push(await used(h)); // SQL reservation is already visible before each outbound request.
    const path = call.url.pathname;
    if (path === '/2/users/4242/retweets') return json({ data: { retweeted: true } });
    if (path === '/2/tweets/1002') return json(lookupResponse(data.target));
    if (path === '/2/tweets/1001') return json(lookupResponse(data.root));
    if (path === '/2/users/4242/mentions') return json(data.mentions);
  };
  assert.equal((await h.call('x_create_original_post', post())).receipt.state, 'succeeded');
  assert.equal((await h.call('x_repost', { post_id: '900', idempotency_key: key(2) })).receipt.state, 'succeeded');
  assert.equal((await h.call('x_reply', replyArgs(3))).receipt.state, 'succeeded');
  assert.equal(await used(h), 655_000);
  await h.db.prepare('UPDATE accounts SET expires_at=0').run();
  await h.scheduled();
  assert.equal(await used(h), 725_000);
  assert.deepEqual(charges, [200_000, 400_000, 415_000, 430_000, 455_000, 655_000, 665_000, 675_000, 700_000, 725_000]);
  assert.equal(h.xCalls().length, 10);
  const before = await ledger(h);
  await h.restart();
  assert.deepEqual(await ledger(h), before);
  assert.equal((await h.call('x_get_write_status', { idempotency_key: key(3) })).receipt.state, 'succeeded');
  assert.equal(h.xCalls().length, 10);
});

for (const [label, reply, expected] of [
  ['unknown response', () => json({}, 201), 'unknown'],
  ['server failure', () => json({}, 500), 'unknown'],
  ['rejected response', () => json({}, 403), 'rejected']
]) test(`workerd credit: ${label} reservation and idempotency receipt survive restart`, async t => {
  const h = await setup(t, { X_CREDIT_INITIAL_MICROUSD: '4800000' });
  h.state.onX = reply;
  const first = await h.call('x_create_original_post', post());
  assert.equal(first.receipt.state, expected);
  assert.equal(await used(h), 5_000_000);
  await h.restart();
  assert.deepEqual((await h.call('x_create_original_post', post())).receipt, first.receipt);
  assert.equal((await h.call('x_create_original_post', post(2))).receipt.code, CAP);
  assert.equal(await used(h), 5_000_000);
  assert.equal(h.sends().length, 1);
});

test('workerd credit: exhausted cap denies original, repost, reply and scheduled reads with zero X egress', async t => {
  const h = await setup(t, { X_CREDIT_INITIAL_MICROUSD: '5000000', REPLY_ENABLED: 'true',
    X_OWN_THREAD_REPLIES_ENABLED: 'true', READ_POLLING_ENABLED: 'true' });
  for (const [name, args] of [
    ['x_create_original_post', post()],
    ['x_repost', { post_id: '900', idempotency_key: key(2) }],
    ['x_reply', replyArgs(3)]
  ]) assert.equal((await h.call(name, args)).receipt.code, CAP);
  assert.equal((await h.scheduled()).outcome, 'exception');
  await h.db.prepare('UPDATE accounts SET expires_at=0').run();
  assert.equal((await h.scheduled()).outcome, 'exception');
  assert.equal((await h.db.prepare("SELECT refresh_status FROM accounts WHERE id='primary'").first()).refresh_status, 'reconnect');
  assert.equal(h.xCalls().length, 0);
  assert.equal(h.state.calls.length, 0);
  assert.equal(await used(h), 5_000_000);
});

test('workerd credit: initial OAuth exchange spends first and exhaustion blocks account verification', async t => {
  const h = await runtime(t, { X_CREDIT_INITIAL_MICROUSD: '4990000' });
  const pending = await h.start();
  const result = await h.complete(pending);
  assert.equal(result.status, 429);
  assert.equal((await result.json()).error, 'X_CREDIT_CAP_REACHED_OR_CHANGED');
  assert.equal(await used(h), 5_000_000);
  assert.deepEqual(h.xCalls().map(v => v.url.pathname), ['/2/oauth2/token']);
  assert.equal(await h.db.prepare('SELECT id FROM accounts').first(), null);
  await h.restart();
  assert.equal(await used(h), 5_000_000);
});

test('workerd credit: an expired fixed-window grant remains denied after restart and retains charges', async t => {
  const cutoff = now() + 4;
  const h = await setup(t, { X_CREDIT_EXPIRES_AT: String(cutoff) });
  assert.equal((await h.call('x_create_original_post', post())).receipt.state, 'succeeded');
  const before = await ledger(h);
  await h.setTime(cutoff);
  assert.equal((await h.call('x_create_original_post', post(2))).receipt.code, AUTH);
  await h.restart();
  assert.equal((await h.call('x_create_original_post', post(3))).receipt.code, AUTH);
  assert.deepEqual(await ledger(h), before);
  assert.equal(h.sends().length, 1);
});

test('workerd credit: expiry while awaiting refresh prevents the next verification and mutation fetch', async t => {
  const cutoff = now() + 4;
  const h = await setup(t, { X_CREDIT_EXPIRES_AT: String(cutoff) });
  await h.seedAccount(0);
  h.state.xScopes = writeScopes.join(' ');
  h.state.onX = async call => {
    assert.equal(call.url.pathname, '/2/oauth2/token');
    await h.setTime(cutoff);
  };
  assert.equal((await h.call('x_create_original_post', post())).receipt.code, AUTH);
  assert.deepEqual(h.xCalls().map(v => v.url.pathname), ['/2/oauth2/token']);
  assert.equal(await used(h), 10_000);
  assert.equal(h.sends().length, 0);
  assert.equal((await h.db.prepare("SELECT refresh_status FROM accounts WHERE id='primary'").first()).refresh_status, 'reconnect');
});

test('workerd credit: absent initial-spend binding fails closed before any mocked X fetch', async t => {
  const h = await setup(t);
  delete h.bindings.X_CREDIT_INITIAL_MICROUSD;
  await h.restart();
  assert.equal((await h.call('x_create_original_post', post())).receipt.code, AUTH);
  assert.equal(await ledger(h), null);
  assert.equal(h.state.calls.length, 0);
});

test('workerd credit: unmodified production module rejects synthetic fixture bindings before X egress', async t => {
  const h=await runtime(t,{}, {productionCreditPolicy:true});
  const pending=await h.start();const response=await h.complete(pending);
  assert.equal(response.status,503);
  assert.equal((await response.json()).error,'X_CREDIT_AUTHORIZATION_REQUIRED');
  assert.equal(h.xCalls().length,0);
  assert.equal(await ledger(h),null);
});
