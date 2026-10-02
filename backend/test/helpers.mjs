import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createWorker } from '../src/worker.mjs';
import { Store } from '../src/storage.mjs';
import { XConnector } from '../src/x.mjs';
import { b64url, configuration, seal } from '../src/security.mjs';

// All identities, keys, IDs and historical timestamps below are synthetic test-only values.
// Any accidental real fetch fails locally; all allowed provider calls are injected below.
export const accidentalNetwork = [];
globalThis.fetch = async (url) => {
  accidentalNetwork.push(String(url));
  throw new Error('Real network is forbidden in this test suite');
};

export class SQLiteD1 {
  constructor() {
    this.sqlite = new DatabaseSync(':memory:');
    for(const file of readdirSync(new URL('../migrations/',import.meta.url)).filter(v=>v.endsWith('.sql')).sort())
      this.sqlite.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
    this.queries = 0;
    this.beforeQuery = null;
  }
  prepare(sql) {
    const db = this;
    let args = [];
    return {
      bind(...values) { args = values; return this; },
      async first() {
        db.queries++;
        db.beforeQuery?.(sql, args);
        return db.sqlite.prepare(sql).get(...args) ?? null;
      },
      async run() {
        db.queries++;
        db.beforeQuery?.(sql, args);
        const value = db.sqlite.prepare(sql).run(...args);
        return { success: true, meta: { changes: Number(value.changes) } };
      }
    };
  }
  async batch(statements) {
    this.sqlite.exec('BEGIN');
    try {
      const rows = [];
      for (const statement of statements) rows.push(await statement.run());
      this.sqlite.exec('COMMIT');
      return rows;
    } catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
  all(sql, ...args) { return this.sqlite.prepare(sql).all(...args); }
  close() { this.sqlite.close(); }
}

const response = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json', ...headers }
});
export { response };

export function harness(t, changes = {}) {
  const state = {
    now: Date.parse('2000-01-01T12:00:00Z') / 1000,
    xCalls: [], idpCalls: [], logs: [], tokenNumber: 0,
    xScopes: 'tweet.read users.read offline.access', userId: '4242',
    mcpScopes: 'x:read', identity: {}, discovery: {}, onX: null, onIdp: null,
    mentions: { data: [{ id: '1002', text: 'Mock mention', author_id: '5050' }], meta: { newest_id: '1002' } },
    posts: { data: [{ id: '1001', text: 'Mock original post', author_id: '4242' }], meta: { newest_id: '1001' } }
  };
  const db = new SQLiteD1();
  t.after(() => db.close());
  const env = {
    DB: db,
    PUBLIC_BASE_URL: 'https://connector.example.invalid',
    MCP_ISSUER: 'https://identity.example.invalid',
    MCP_DISCOVERY_URL: 'https://identity.example.invalid/.well-known/oauth-authorization-server',
    MCP_INTROSPECTION_URL: 'https://identity.example.invalid/introspect',
    MCP_INTROSPECTION_CLIENT_ID: 'mock-only-resource-client',
    MCP_INTROSPECTION_CLIENT_SECRET: 'mock-only-idp-secret',
    MCP_ALLOWED_SUBJECT: 'mock-only-owner',
    SERVICE_X_ACCOUNT_ID: '4242', X_EXPECTED_USER_ID: '4242', X_CLIENT_ID: 'mock-only-x-client', X_CLIENT_SECRET: 'mock-only-x-secret',
    X_CALLBACK_URL: 'https://connector.example.invalid/x/callback',
    TOKEN_ENCRYPTION_KEY: b64url(new Uint8Array(32).fill(7)),
    LIVE_X_ENABLED: 'false', LIVE_IDP_ENABLED: 'false',
    READ_POLLING_ENABLED: 'false', POST_ENABLED: 'false', REPLY_ENABLED: 'false',
    X_CREDIT_BUDGET_ID:'example-disabled-budget',X_CREDIT_CAP_MICROUSD:'5000000',X_CREDIT_INITIAL_MICROUSD:'0',X_CREDIT_EXPIRES_AT:String(Date.parse('2000-01-02T08:00:00Z')/1000),
    ...changes
  };
  const clock = () => state.now;
  const cfg = configuration(env);
  const store = new Store(db, clock);
  const xFetch = async (url, options = {}) => {
    state.xCalls.push({ url, options });
    assert.equal(new URL(url).origin, 'https://api.x.com');
    assert.equal(options.redirect, 'manual');
    assert(options.signal);
    const overridden = await state.onX?.(url, options);
    if (overridden) return overridden;
    const path = new URL(url).pathname;
    if (path === '/2/oauth2/token') {
      state.tokenNumber++;
      return response({ token_type: 'bearer', expires_in: 7200, scope: state.xScopes,
        access_token: `mock-access-${state.tokenNumber}`, refresh_token: `mock-refresh-${state.tokenNumber}` });
    }
    if (path === '/2/users/me') return response({ data: { id: state.userId, username: 'mockowner' } });
    if (path === '/2/users/4242/mentions') return response(state.mentions);
    if (path === '/2/users/4242/tweets') return response(state.posts);
    if (path === '/2/tweets' && options.method === 'POST') return response({ data: { id: String(9000+state.xCalls.length) } }, 201);
    throw new Error('Unrecognized mocked X endpoint');
  };
  const idpFetch = async (url, options = {}) => {
    state.idpCalls.push({ url, options });
    assert.equal(new URL(url).origin, 'https://identity.example.invalid');
    assert.equal(options.redirect, 'manual');
    assert(options.signal);
    const overridden = await state.onIdp?.(url, options);
    if (overridden) return overridden;
    if (url === cfg.discovery) return response({
      issuer: cfg.issuer, authorization_endpoint: `${cfg.issuer}/authorize`, token_endpoint: `${cfg.issuer}/token`,
      introspection_endpoint: cfg.introspection, code_challenge_methods_supported: ['S256'],
      response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
      client_id_metadata_document_supported: true, ...state.discovery
    });
    if (url === cfg.introspection) return response({
      active: new URLSearchParams(options.body).get('token') === 'mock-mcp-token',
      iss: cfg.issuer, aud: cfg.resource, exp: state.now+300, nbf: state.now-1,
      sub: env.MCP_ALLOWED_SUBJECT, scope: state.mcpScopes, token_type: 'Bearer', ...state.identity
    });
    throw new Error('Unrecognized mocked IdP endpoint');
  };
  const deps = { xFetch, idpFetch, clock, logger: line => state.logs.push(line) };
  const worker = createWorker(deps);
  const x = new XConnector(env, cfg, store, xFetch, clock);

  function request(path, { method = 'GET', data, headers = {}, auth = false, raw } = {}) {
    return new Request(`${cfg.base}${path}`, { method, headers: {
      ...(data !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(auth ? { authorization: 'Bearer mock-mcp-token' } : {}), ...headers
    }, ...(data !== undefined || raw !== undefined ? { body: raw ?? JSON.stringify(data) } : {}) });
  }
  async function api(path, options) { return worker.fetch(request(path, options), env); }
  async function mcp(method, params, { auth = true, headers = {}, raw, id = 1 } = {}) {
    return api('/mcp', { method: 'POST', auth, headers: { accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-11-25', ...headers },
    data: { jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, ...(params ? { params } : {}) }, raw });
  }
  async function call(name, args = {}, options) {
    const res = await mcp('tools/call', { name, arguments: args }, options);
    return { response: res, body: await res.json() };
  }
  async function start(mode = 'read') {
    const res = await api('/x/connect', { method: 'POST', auth: true, data: { mode } });
    const data = await res.json();
    assert.equal(res.status, 200, data.error);
    return { url: new URL(data.authorization_url), cookie: res.headers.get('set-cookie').split(';')[0] };
  }
  async function complete(link, extra = {}) {
    const params = new URLSearchParams({ state: link.url.searchParams.get('state'), code: 'mock-authorization-code', ...extra });
    return api(`/x/callback?${params}`, { headers: { cookie: link.cookie } });
  }
  async function link(mode = 'read') {
    const started = await start(mode);
    const res = await complete(started);
    const body = await res.json();
    assert.equal(res.status, 200, body.error);
    return { ...started, body };
  }
  async function seed({ scopes = ['tweet.read','users.read','offline.access'], expires = state.now+7200 } = {}) {
    await store.saveAccount(cfg.issuer, env.MCP_ALLOWED_SUBJECT, env.X_EXPECTED_USER_ID,
      await seal(env.TOKEN_ENCRYPTION_KEY, { access_token: 'mock-seeded-access', refresh_token: 'mock-seeded-refresh', scopes }, x.context()), expires);
  }
  return { state, db, env, cfg, store, x, worker, deps, clock, xFetch, idpFetch, request, api, mcp, call, start, complete, link, seed };
}

export async function rejectsCode(promise, code) {
  await assert.rejects(promise, error => error.code === code);
}
