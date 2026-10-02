import { Miniflare, convertV4MiniflareOptions, Log, LogLevel, Response } from 'miniflare';
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { CREDIT_RUN_ID, CREDIT_RUN_DEADLINE, creditModuleSource } from './credit-fixture.mjs';
import { RUNTIME_NOW, CLOCK_CONTROL_PATH } from './clock-fixture.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
import assert from 'node:assert/strict';

export const base = 'https://connector.example.invalid';
export const issuer = 'https://identity.example.invalid';
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', ...headers }
});

// Test entry points inject only a fixed clock and optional transport faults.
// productionCreditPolicy retains the untouched expired policy for denial tests.
export function runtimeModules(testFaults={}) {
  return [
    ...(testFaults.canarySlotAckLoss||testFaults.canaryConfigurationRace
      ? [{type:'ESModule',path:resolve(root,'runtime-test/canary-fault-worker.mjs')}] : []),
    ...['clock-worker','clock-fixture'].map(name=>({type:'ESModule',path:resolve(root,`runtime-test/${name}.mjs`)})),
    ...['worker','identity','jwt','owner','x','security','storage','reads','service','service-writes',
      'write-policy','write-validation','twitter-text-vendor','credit-policy','reply-guard','canary-mention','ongoing','ongoing-diagnostics','maintenance','pricing']
      .map(name=>({type:'ESModule',path:resolve(root,`src/${name}.mjs`),
        ...(name==='credit-policy'&&!testFaults.productionCreditPolicy?{contents:creditModuleSource}:{})}))
  ];
}

// Worker fetch is intercepted at workerd's outbound service; unknown egress
// always fails. The credit module is replaced in memory by a synthetic fixture
// unless productionCreditPolicy is requested. Canary fault wrappers are test-only.
export async function runtime(t, overrides = {}, testFaults = {}) {
  const persistence = await mkdtemp(resolve(tmpdir(),'dot-x-connector-test-'));
  const state = { now:RUNTIME_NOW,calls: [], unexpected: [], tokens: 0, scope: 'x:read',
    xScopes: 'tweet.read users.read offline.access', userId: '4242', onX: null,
    identity: {}, discovery: {}, bearer: 'mock-mcp-token', onIdp: null, logs: [] };
  const bindings = {
    PUBLIC_BASE_URL: base, MCP_ISSUER: issuer,
    MCP_DISCOVERY_URL: `${issuer}/.well-known/oauth-authorization-server`,
    MCP_INTROSPECTION_URL: `${issuer}/introspect`,
    MCP_INTROSPECTION_CLIENT_ID: 'mock-only-resource-client',
    MCP_INTROSPECTION_CLIENT_SECRET: 'mock-only-idp-secret',
    MCP_CLIENT_REGISTRATION: 'predefined', MCP_ALLOWED_SUBJECT: 'mock-only-owner',
    SERVICE_X_ACCOUNT_ID: '4242', X_EXPECTED_USER_ID: '4242', X_CLIENT_ID: 'mock-only-x-client',
    X_CLIENT_SECRET: 'mock-only-x-secret', X_CALLBACK_URL: `${base}/x/callback`,
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64url'),
    // These apply only to the egress-intercepted local test runtime.
    LIVE_X_ENABLED: 'true', LIVE_IDP_ENABLED: 'true', READ_POLLING_ENABLED: 'true',
    POST_ENABLED: 'false', REPLY_ENABLED: 'false',
    X_CREDIT_BUDGET_ID:CREDIT_RUN_ID,X_CREDIT_CAP_MICROUSD:'5000000',X_CREDIT_INITIAL_MICROUSD:'0',X_CREDIT_EXPIRES_AT:String(CREDIT_RUN_DEADLINE),
    MAX_X_REQUESTS_DAY: '100', MAX_X_REQUESTS_HOUR: '20',
    ...overrides
  };
  async function outbound(request) {
    const url = new URL(request.url);
    const call = { url, method: request.method, headers: request.headers, body: await request.text() };
    state.calls.push(call);
    if (url.origin === issuer) {
      const custom = await state.onIdp?.(call);
      if (custom) return custom;
    }
    if (url.origin === issuer && url.pathname === '/.well-known/oauth-authorization-server')
      return json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`,
        introspection_endpoint: `${issuer}/introspect`, code_challenge_methods_supported: ['S256'],
        response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], ...state.discovery });
    if (url.origin === issuer && url.pathname === '/introspect')
      return json({ active: new URLSearchParams(call.body).get('token') === 'mock-mcp-token',
        iss: issuer, aud: `${base}/mcp`, sub: 'mock-only-owner',
        exp: state.now+300, scope: state.scope, ...state.identity });
    if (url.origin === 'https://api.x.com') {
      const custom = await state.onX?.(call);
      if (custom) return custom;
      if (url.pathname === '/2/oauth2/token') {
        state.tokens++;
        return json({ token_type: 'bearer', expires_in: 7200, scope: state.xScopes,
          access_token: `mock-access-${state.tokens}`, refresh_token: `mock-refresh-${state.tokens}` });
      }
      if (url.pathname === '/2/users/me') return json({ data: { id: state.userId, username: 'mockowner' } });
      if (url.pathname === '/2/users/4242/mentions') return json({
        data: [{ id: '1002', text: 'Mock mention', author_id: '5050' }], meta: { newest_id: '1002' } });
      if (url.pathname === '/2/users/4242/tweets') return json({
        data: [{ id: '1001', text: 'Mock original post', author_id: '4242' }], meta: { newest_id: '1001' } });
      if (url.pathname === '/2/tweets' && request.method === 'POST') return json({ data: { id: '9001' } }, 201);
    }
    state.unexpected.push(request.url);
    throw new Error('Outbound request denied by local test harness');
  }
  let mf, db;
  async function setTime(seconds) {
    assert(Number.isSafeInteger(seconds)&&seconds>=state.now);
    const response=await mf.dispatchFetch(base+CLOCK_CONTROL_PATH,{method:'POST',body:String(seconds)});
    assert.equal(response.status,204);state.now=seconds;
  }
  async function boot() {
    const options = convertV4MiniflareOptions({
      name: 'local-x-mcp-check', modules: runtimeModules(testFaults),
      compatibilityDate: '2026-10-01', host: '127.0.0.1', port: 0,
      cf: false, log: new Log(LogLevel.ERROR), bindings: {...bindings,
        ...(testFaults.canarySlotAckLoss?{TEST_FAULT_CANARY_ACK:'true'}:{}),
        ...(testFaults.canaryConfigurationRace?{TEST_FAULT_CANARY_CONFIG:'true'}:{})},
      d1Databases: { DB: 'local-only-x-mcp-check' }, resourcePersistencePath: persistence,
      outboundService: outbound
    });
    options.telemetry = { enabled: false };
    options.handleStructuredLogs = line => state.logs.push(line);
    mf = new Miniflare(options);
    await mf.ready;
    await setTime(state.now);
    db = await mf.getD1Database('DB');
  }
  t.after(async () => { await mf?.dispose(); await rm(persistence,{recursive:true,force:true}); assert.deepEqual(state.unexpected, []); });
  await boot();
  // Each whole SQL statement is passed intact; D1 exec's line-oriented parser
  // is unsuitable for this formatted migration.
  for(const file of (await readdir(resolve(root,'migrations'))).filter(v=>v.endsWith('.sql')).sort()) {
    const sql=await readFile(resolve(root,`migrations/${file}`),'utf8');
    for (const part of sql.split(';').map(v => v.trim()).filter(Boolean)) await db.prepare(part).run();
  }
  async function api(path, { method = 'GET', data, raw, auth = false, headers = {} } = {}) {
    return mf.dispatchFetch(`${base}${path}`, { method, redirect: 'manual', headers: {
      ...(data === undefined ? {} : { 'content-type': 'application/json' }),
      ...(auth ? { authorization: `Bearer ${state.bearer}` } : {}), ...headers
    }, ...(data === undefined && raw === undefined ? {} : { body: raw ?? JSON.stringify(data) }) });
  }
  async function mcp(method, params = {}, auth = true) {
    return api('/mcp', { method: 'POST', auth, headers: {
      accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25'
    }, data: { jsonrpc: '2.0', id: 1, method, params } });
  }
  async function call(name, args = {}, auth = true) {
    const response = await mcp('tools/call', { name, arguments: args }, auth);
    return { response, body: await response.json() };
  }
  async function start(mode = 'read') {
    const response = await api('/x/connect', { method: 'POST', auth: true, data: { mode } });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    return { url: new URL(body.authorization_url), cookie: response.headers.get('set-cookie').split(';')[0] };
  }
  async function complete(link) {
    const params = new URLSearchParams({ state: link.url.searchParams.get('state'), code: 'mock-code' });
    return api(`/x/callback?${params}`, { headers: { cookie: link.cookie } });
  }
  async function link(mode = 'read') {
    const pending = await start(mode); const response = await complete(pending);
    assert.equal(response.status, 200, await response.text()); return pending;
  }
  return { state, bindings, api, mcp, call, start, complete, link, setTime, clock:()=>state.now,
    get db() { return db; }, get mf() { return mf; },
    xCalls: () => state.calls.filter(v => v.url.origin === 'https://api.x.com'),
    restart: async () => { await mf.dispose(); await boot(); },
    scheduled: async () => (await mf.getWorker()).scheduled({ cron: '0 */6 * * *', scheduledTime: state.now*1000 })
  };
}

export { json };
