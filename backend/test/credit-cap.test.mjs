import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, response, rejectsCode, accidentalNetwork } from './helpers.mjs';
import { writeHarness, writeScopes, key } from './write-fixtures.mjs';
import { replyHarness, replyArgs } from './reply-fixtures.mjs';
import { Store } from '../src/storage.mjs';
import { XConnector } from '../src/x.mjs';
import { CREDIT_RUN_ID, CREDIT_RUN_DEADLINE, CREDIT_MAX_MICROUSD } from '../src/credit-policy.mjs';

const options = { X_CREDIT_INITIAL_MICROUSD: '0', MAX_X_REQUESTS_DAY: '100', MAX_X_REQUESTS_HOUR: '20' };
const ledger = h => h.db.all('SELECT * FROM x_credit_budgets');
const used = h => ledger(h)[0]?.used_micro_usd ?? 0;
const post = (n = 1) => ({ text: `Credit cap original ${n}`, idempotency_key: key(n) });
const AUTH = 'X_CREDIT_AUTHORIZATION_REQUIRED';
const CAP = 'X_CREDIT_CAP_REACHED_OR_CHANGED';

test('public credit policy pins one expired example run and a five-dollar ceiling', () => {
  assert.equal(CREDIT_RUN_ID, 'example-disabled-budget');
  assert.equal(CREDIT_MAX_MICROUSD, 5_000_000);
  assert.equal(CREDIT_RUN_DEADLINE, Date.parse('2000-01-02T08:00:00Z') / 1000);
});

for (const [label, change] of [
  ['missing run', { X_CREDIT_BUDGET_ID: undefined }],
  ['new run', { X_CREDIT_BUDGET_ID: 'test-invalid-new-budget' }],
  ['missing cap', { X_CREDIT_CAP_MICROUSD: undefined }],
  ['cap over five dollars', { X_CREDIT_CAP_MICROUSD: '5000001' }],
  ['zero cap', { X_CREDIT_CAP_MICROUSD: '0' }],
  ['fractional cap', { X_CREDIT_CAP_MICROUSD: '4999999.5' }],
  ['missing initial spend', { X_CREDIT_INITIAL_MICROUSD: undefined }],
  ['empty initial spend', { X_CREDIT_INITIAL_MICROUSD: '' }],
  ['negative initial spend', { X_CREDIT_INITIAL_MICROUSD: '-1' }],
  ['fractional initial spend', { X_CREDIT_INITIAL_MICROUSD: '0.5' }],
  ['initial spend over cap', { X_CREDIT_INITIAL_MICROUSD: '5000001' }],
  ['unsafe initial spend', { X_CREDIT_INITIAL_MICROUSD: '9007199254740992' }],
  ['missing expiry', { X_CREDIT_EXPIRES_AT: undefined }],
  ['extended expiry', { X_CREDIT_EXPIRES_AT: String(CREDIT_RUN_DEADLINE + 1) }],
  ['fractional expiry', { X_CREDIT_EXPIRES_AT: String(CREDIT_RUN_DEADLINE - 0.5) }],
  ['missing account', { X_EXPECTED_USER_ID: undefined }],
  ['invalid account', { X_EXPECTED_USER_ID: '0' }]
]) test(`credit authorization rejects ${label} before ledger or egress`, async t => {
  const h = harness(t, options);
  Object.assign(h.env, change);
  await rejectsCode(h.store.reserveCredit(h.env, 10_000), AUTH);
  assert.deepEqual(ledger(h), []);
  assert.equal(h.state.xCalls.length, 0);
});

for (const amount of [0, -1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
  test(`credit reservation rejects invalid integer amount ${amount}`, async t => {
    const h = harness(t, options);
    await rejectsCode(h.store.reserveCredit(h.env, amount), AUTH);
    assert.equal(ledger(h).length, 0);
  });

test('atomic concurrent reservations account for initial spend exactly once and never exceed five dollars', async t => {
  const h = harness(t, { ...options, X_CREDIT_INITIAL_MICROUSD: '1000000' });
  const outcomes = await Promise.allSettled(Array.from({ length: 60 }, () => h.store.reserveCredit(h.env, 200_000)));
  assert.equal(outcomes.filter(v => v.status === 'fulfilled').length, 20);
  assert(outcomes.filter(v => v.status === 'rejected').every(v => v.reason.code === CAP));
  assert.equal(ledger(h).length, 1);
  assert.equal(used(h), 5_000_000);
  assert.equal(ledger(h)[0].initial_micro_usd, 1_000_000);
  assert.equal(h.state.xCalls.length, 0);
});

test('the first unaffordable reservation still durably pins initial spend and immutable authorization', async t => {
  const h = harness(t, { ...options, X_CREDIT_INITIAL_MICROUSD: '4800001' });
  await rejectsCode(h.store.reserveCredit(h.env, 200_000), CAP);
  assert.equal(ledger(h).length, 1);
  assert.equal(used(h), 4_800_001);
  await h.store.reserveCredit(h.env, 199_999);
  assert.equal(used(h), 5_000_000);
});

for (const initial of ['4800001', '5000000'])
  test(`first denied reservation with initial=${initial} cannot be reset by changed deployment bindings`, async t => {
    const h = harness(t, { ...options, X_CREDIT_INITIAL_MICROUSD: initial });
    await rejectsCode(h.store.reserveCredit(h.env, 200_000), CAP);
    const before = ledger(h);
    assert.equal(before.length, 1);
    assert.equal(used(h), Number(initial));
    for (const changed of [
      { X_CREDIT_INITIAL_MICROUSD: '0' },
      { X_CREDIT_CAP_MICROUSD: '4999999', X_CREDIT_INITIAL_MICROUSD: '0' },
      { X_CREDIT_EXPIRES_AT: String(CREDIT_RUN_DEADLINE - 1), X_CREDIT_INITIAL_MICROUSD: '0' }
    ]) {
      const restarted = new Store(h.db, h.clock);
      await rejectsCode(restarted.reserveCredit({ ...h.env, ...changed }, 200_000), CAP);
      assert.deepEqual(ledger(h), before);
    }
    assert.equal(h.state.xCalls.length, 0);
  });

for (const [field, value, code] of [
  ['X_CREDIT_BUDGET_ID', 'test-invalid-new-budget', AUTH],
  ['X_EXPECTED_USER_ID', '4343', CAP],
  ['X_CREDIT_CAP_MICROUSD', '4999999', CAP],
  ['X_CREDIT_EXPIRES_AT', String(CREDIT_RUN_DEADLINE - 1), CAP],
  ['X_CREDIT_INITIAL_MICROUSD', '1', CAP]
]) test(`durable credit authorization rejects changed ${field} after Store recreation`, async t => {
  const h = harness(t, options);
  await h.store.reserveCredit(h.env, 200_000);
  const before = ledger(h);
  const restarted = new Store(h.db, h.clock);
  await rejectsCode(restarted.reserveCredit({ ...h.env, [field]: value }, 1), code);
  assert.deepEqual(ledger(h), before);
  await restarted.reserveCredit(h.env, 1);
  assert.equal(used(h), 200_001);
});

test('midnight, expiring request buckets, cleanup and Store recreation never reset the fixed-window cap', async t => {
  const h = harness(t, options);
  h.state.now = Date.parse('2000-01-01T23:59:59Z') / 1000;
  await h.store.reserveX(h.env, 0, true);
  h.state.now += 2;
  await h.store.cleanup();
  assert.equal(h.db.all('SELECT * FROM budgets').length, 0);
  const restarted = new Store(h.db, h.clock);
  await restarted.reserveX(h.env, 0, true);
  assert.equal(used(h), 400_000);
  const before = ledger(h);
  h.state.now = CREDIT_RUN_DEADLINE;
  await restarted.cleanup();
  await rejectsCode(restarted.reserveCredit(h.env, 1), AUTH);
  assert.deepEqual(ledger(h), before);
  h.state.now += 86400;
  await restarted.cleanup();
  await rejectsCode(restarted.reserveCredit(h.env, 1), AUTH);
  assert.deepEqual(ledger(h), before);
});

test('expiry is exclusive, permits an earlier deadline and cannot be extended after initialization', async t => {
  const h = harness(t, options);
  h.env.X_CREDIT_EXPIRES_AT = String(h.clock() + 10);
  await h.store.reserveCredit(h.env, 10_000);
  h.state.now += 9;
  await h.store.reserveCredit(h.env, 10_000);
  h.state.now++;
  await rejectsCode(h.store.reserveCredit(h.env, 1), AUTH);
  await rejectsCode(h.store.reserveCredit({ ...h.env, X_CREDIT_EXPIRES_AT: String(CREDIT_RUN_DEADLINE) }, 1), CAP);
  assert.equal(used(h), 20_000);
});

test('originals, reposts, replies, reads, refresh and user verification consume one shared ledger', async t => {
  const h = await replyHarness(t, { ...options, POST_ENABLED: 'true', READ_POLLING_ENABLED: 'true' });
  const replyMock = h.state.onX;
  h.state.onX = (url, init) => new URL(url).pathname.endsWith('/retweets')
    ? response({ data: { retweeted: true } }) : replyMock(url, init);
  assert.equal((await h.call('x_create_original_post', post())).receipt.state, 'succeeded');
  assert.equal(used(h), 200_000);
  assert.equal((await h.call('x_repost', { post_id: '900', idempotency_key: key(2) })).receipt.state, 'succeeded');
  assert.equal(used(h), 400_000);
  assert.equal((await h.call('x_reply', replyArgs(3))).receipt.state, 'succeeded');
  assert.equal(used(h), 600_000); // Browser-reviewed reply: one legacy-priced $0.20 mutation.
  await h.x.poll();
  assert.equal(used(h), 650_000);
  await h.x.verifyUser('mock-token');
  assert.equal(used(h), 660_000);
  h.state.xScopes = writeScopes.join(' ');
  await h.store.run('UPDATE accounts SET expires_at=0');
  await h.x.tokens();
  assert.equal(used(h), 680_000);
  assert.equal(ledger(h).length, 1);
  assert.equal(h.state.xCalls.length, 8);
});

test('initial OAuth exchange and account verification each reserve before mocked egress', async t => {
  const h = harness(t, options);
  const seen = [];
  h.state.onX = () => { seen.push(used(h)); };
  await h.link();
  assert.deepEqual(seen, [10_000, 20_000]);
  assert.equal(used(h), 20_000);
});

test('concurrent distinct service writes share the final twenty-cent reservation', async t => {
  const h = await writeHarness(t, { ...options, X_CREDIT_INITIAL_MICROUSD: '4800000' });
  await h.seed({ scopes: writeScopes });
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => h.call('x_create_original_post', post(i + 1))));
  assert.equal(results.filter(r => r.receipt.state === 'succeeded').length, 1);
  assert.equal(results.filter(r => r.receipt.code === CAP.toLowerCase()).length, 11);
  assert.equal(used(h), 5_000_000);
  assert.equal(h.sends().length, 1);
});

for (const [label, outcome, state] of [
  ['network exception', () => { throw new Error('mock lost response'); }, 'unknown'],
  ['upstream 500', () => response({}, 500), 'unknown'],
  ['unverified success', () => response({}, 201), 'unknown'],
  ['explicit rejection', () => response({}, 403), 'rejected'],
  ['rate limit', () => response({}, 429), 'rejected']
]) test(`failed or ${label} mutation retains credit and cannot release budget for a fresh intent`, async t => {
  const h = await writeHarness(t, { ...options, X_CREDIT_INITIAL_MICROUSD: '4800000' });
  await h.seed({ scopes: writeScopes });
  h.state.onX = outcome;
  const first = await h.call('x_create_original_post', post());
  assert.equal(first.receipt.state, state);
  assert.equal(used(h), 5_000_000);
  assert.deepEqual((await h.call('x_create_original_post', post())).receipt, first.receipt);
  assert.equal((await h.call('x_create_original_post', post(2))).receipt.code, CAP.toLowerCase());
  assert.equal(h.sends().length, 1);
  assert.equal(used(h), 5_000_000);
});

test('failed read and failed refresh keep their pre-fetch reservations', async t => {
  const h = harness(t, options);
  await h.seed({ expires: 0 });
  h.state.onX = () => { throw new Error('mock network failure'); };
  await rejectsCode(h.x.request('/2/users/me', { token: 'mock' }), 'X_REQUEST_UNCERTAIN');
  assert.equal(used(h), 10_000);
  await rejectsCode(h.x.tokens(), 'X_REQUEST_UNCERTAIN');
  assert.equal(used(h), 20_000);
  assert.equal((await h.store.account()).refresh_status, 'reconnect');
  await rejectsCode(h.x.tokens(), 'REFRESH_IN_PROGRESS_OR_RECONNECT_REQUIRED');
  assert.equal(h.state.xCalls.length, 2);
  assert.equal(used(h), 20_000);
});

test('a later request/hour limit failure keeps its earlier conservative credit reservation', async t => {
  const h = harness(t, { ...options, MAX_X_REQUESTS_HOUR: '0' });
  await rejectsCode(h.x.request('/2/users/me', { token: 'mock' }), 'LOCAL_BUDGET_EXHAUSTED');
  assert.equal(used(h), 10_000);
  assert.equal(h.state.xCalls.length, 0);
});

test('exhaustion blocks read, OAuth exchange, refresh and user verification before X egress', async t => {
  const h = harness(t, { ...options, X_CREDIT_INITIAL_MICROUSD: '5000000' });
  await h.seed({ expires: 0 });
  await rejectsCode(h.x.request('/2/users/4242/tweets', { token: 'mock', records: 5 }), CAP);
  await rejectsCode(h.x.verifyUser('mock'), CAP);
  await rejectsCode(h.x.tokens(), CAP);
  const pending = await h.start();
  const callback = await h.complete(pending);
  assert.equal(callback.status, 429);
  assert.equal((await callback.json()).error, CAP);
  assert.equal(h.state.xCalls.length, 0);
  assert.equal(ledger(h).length, 1);
  assert.equal(used(h), 5_000_000);
});

test('exhaustion stops reply paid lookups and repost/original mutations with zero X egress', async t => {
  const h = await replyHarness(t, { ...options, POST_ENABLED: 'true', X_CREDIT_INITIAL_MICROUSD: '5000000' });
  for (const [name, args] of [
    ['x_reply', replyArgs(1)],
    ['x_repost', { post_id: '900', idempotency_key: key(2) }],
    ['x_create_original_post', post(3)]
  ]) assert.equal((await h.call(name, args)).receipt.code, CAP.toLowerCase());
  assert.equal(h.state.xCalls.length, 0);
});

for (const route of ['read', 'service original', 'service repost', 'service reply', 'legacy original'])
  test(`expiry during awaited budget work fences ${route} immediately before fetch`, async t => {
    const h = route === 'service reply'
      ? await replyHarness(t, options) : await writeHarness(t, options);
    await h.seed({ scopes: writeScopes });
    const cutoff = h.clock() + 1;
    h.env.X_CREDIT_EXPIRES_AT = String(cutoff);
    let expired = false;
    h.db.beforeQuery = (sql, args) => {
      const bucket = route === 'read' ? 'requests:hour:' : 'writes:day:';
      if (!expired && sql.includes('INSERT INTO budgets') && String(args[0]).startsWith(bucket)) {
        expired = true;
        h.state.now = cutoff;
      }
    };
    if (route === 'read') await rejectsCode(h.x.verifyUser('mock'), AUTH);
    else if (route === 'legacy original') await rejectsCode(h.x.send('post', { text: 'Legacy cutoff original', idempotency_key: key(1) }), AUTH);
    else {
      const [name, args] = route === 'service reply' ? ['x_reply', replyArgs(1)]
        : route === 'service repost' ? ['x_repost', { post_id: '900', idempotency_key: key(1) }]
          : ['x_create_original_post', post()];
      assert.equal((await h.call(name, args)).receipt.code, AUTH.toLowerCase());
    }
    assert(expired);
    assert.equal(h.sends().length, 0);
    assert.equal(h.state.xCalls.length, 0);
    assert.equal(used(h), route === 'read' ? 10_000 : 200_000);
    const restarted = new XConnector(h.env, h.cfg, new Store(h.db, h.clock), h.xFetch, h.clock);
    await rejectsCode(restarted.verifyUser('mock'), AUTH);
  });

test('credit suite has made zero accidental real-network calls', () => {
  assert.deepEqual(accidentalNetwork, []);
});


test('public credit policy denies real-time requests even with matching example bindings', async t => {
  const h=harness(t,options);h.state.now=Math.floor(Date.now()/1000);
  await rejectsCode(h.store.reserveCredit(h.env,1),AUTH);
  assert.deepEqual(ledger(h),[]);assert.equal(h.state.xCalls.length,0);
});
