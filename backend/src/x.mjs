import { ongoing } from './ongoing.mjs';
import { assert, basicAuth, digest, enabled, open, randomValue, responseJson, SafeError, seal, xConfiguration } from './security.mjs';
import { cachedRead } from './reads.mjs';
import { REPLY_DEPLOYMENT_APPROVED } from './write-policy.mjs';
import { validatePostText, isPostId } from './write-validation.mjs';

const READ_SCOPES = ['tweet.read', 'users.read', 'offline.access'];
const COOKIE = '__Host-x-link';

export class XConnector {
  constructor(env, cfg, store, xFetch, clock) {
    this.env = env; this.cfg = cfg; this.store = store; this.xFetch = xFetch; this.clock = clock;
    xConfiguration(env, cfg);
  }
  context(kind = 'account') {
    return `${kind}:primary:${this.cfg.issuer}:${this.env.MCP_ALLOWED_SUBJECT}:${this.env.X_EXPECTED_USER_ID}`;
  }
  bind(account) {
    assert(account && account.issuer === this.cfg.issuer && account.subject === this.env.MCP_ALLOWED_SUBJECT
      && account.x_user_id === this.env.X_EXPECTED_USER_ID, 'ACCOUNT_NOT_LINKED_OR_BINDING_MISMATCH', 403);
  }

  async request(path, { method = 'GET', token, body, records = 0, write = false, oauth = false, grantVersion, creditMicroUsd } = {}) {
    await this.store.reserveX(this.env, records, write, creditMicroUsd);
    const creditAttempt=this.store.creditAttempt;
    try {
      if(write) {
        const current=await this.store.account();this.bind(current);
        assert(Number.isSafeInteger(grantVersion) && current.version===grantVersion && current.refresh_status==='idle',
          'X_GRANT_SUPERSEDED',409);
      }
      this.store.checkCreditWindow(this.env);
    } catch(error) {if(ongoing(this.env))await this.store.releaseUnattemptedCredit(creditAttempt);throw error;}
    const headers = { accept: 'application/json', authorization: oauth
      ? basicAuth(this.env.X_CLIENT_ID, this.env.X_CLIENT_SECRET) : `Bearer ${token}` };
    if (body) headers['content-type'] = oauth ? 'application/x-www-form-urlencoded' : 'application/json';
    let response;
    try {
      this.store.markCreditDispatched(creditAttempt);
      response = await this.xFetch(`https://api.x.com${path}`, {
        method, headers, body: body ? (oauth ? body.toString() : JSON.stringify(body)) : undefined,
        // Never follow redirects with credentials; non-2xx is rejected below.
        redirect: 'manual', signal: AbortSignal.timeout(8000)
      });
    } catch (error) {
      if (error instanceof SafeError) throw error;
      throw new SafeError('X_REQUEST_UNCERTAIN', 502);
    }
    if (response.status === 429) {
      const raw = Number(response.headers.get('x-rate-limit-reset'));
      await this.store.setCooldown(Number.isFinite(raw) && raw > this.clock() ? raw : this.clock()+900);
      throw new SafeError('X_RATE_LIMITED', 429);
    }
    assert(response.status !== 401, 'X_RECONNECT_REQUIRED', 409);
    assert(response.ok, 'X_UPSTREAM_REJECTED', 502);
    const result=await responseJson(response);
    if(ongoing(this.env)&&!result.errors)await this.store.resolveCredit(creditAttempt);
    return result;
  }

  tokenSet(data, requested, previous) {
    assert(typeof data.access_token === 'string' && data.access_token.length > 0 && data.access_token.length <= 8192
      && typeof data.token_type === 'string' && data.token_type.toLowerCase() === 'bearer'
      && Number.isSafeInteger(data.expires_in) && data.expires_in >= 120 && data.expires_in <= 86400,
    'X_TOKEN_RESPONSE_INVALID', 502);
    const scopes = typeof data.scope === 'string' ? data.scope.split(/\s+/) : previous?.scopes;
    assert(scopes?.length && READ_SCOPES.every(s => scopes.includes(s)) && requested.every(s => scopes.includes(s))
      && scopes.every(s => requested.includes(s)), 'X_SCOPE_MISMATCH', 403);
    const refresh = data.refresh_token ?? previous?.refresh_token;
    assert(typeof refresh === 'string' && refresh.length > 0 && refresh.length <= 8192,
      'X_REFRESH_TOKEN_REQUIRED', 502);
    return { access_token: data.access_token, refresh_token: refresh, scopes };
  }

  async verifyUser(token) {
    const user = await this.request('/2/users/me', { token });
    assert(user.data?.id === this.env.X_EXPECTED_USER_ID, 'X_ACCOUNT_BINDING_MISMATCH', 403);
  }

  async start(identity, mode = 'read', includeWriteConsent = false) {
    assert(['read', 'post', 'reply', 'both'].includes(mode), 'INVALID_LINK_MODE');
    // Only the owner browser route can opt into a separately approved grant.
    // This never enables a send operation or changes the owner's MCP scopes.
    assert(typeof includeWriteConsent === 'boolean' && (!includeWriteConsent
      || (enabled(this.env.OWNER_X_WRITE_CONSENT_ENABLED) && identity.scopes.includes('x:read'))),
    'X_WRITE_CONSENT_DISABLED_OR_UNAUTHORIZED', 403);
    if (mode === 'post' || mode === 'both') assert(enabled(this.env.POST_ENABLED) && identity.scopes.includes('x:post'), 'POST_DISABLED_OR_UNAUTHORIZED', 403);
    if (mode === 'reply' || mode === 'both') assert(REPLY_DEPLOYMENT_APPROVED && enabled(this.env.REPLY_ENABLED) && identity.scopes.includes('x:reply'), 'REPLY_DISABLED_OR_UNAUTHORIZED', 403);
    const state = randomValue();
    const cookie = randomValue();
    const verifier = randomValue(48);
    const hash = await digest(state);
    const scopes = mode === 'read' && !includeWriteConsent ? READ_SCOPES : [...READ_SCOPES, 'tweet.write'];
    const account = await this.store.account();
    if (account) this.bind(account);
    // One pending transaction for this single owner; a second start invalidates the first.
    const encrypted = await seal(this.env.TOKEN_ENCRYPTION_KEY,
      { verifier, issuer: identity.issuer, subject: identity.subject, scopes, account_version: account?.version ?? 0 }, `state:${hash}`);
    await this.store.db.batch([
      this.store.statement('DELETE FROM oauth_states'),
      this.store.statement(`INSERT INTO oauth_states(state_hash,cookie_hash,encrypted_payload,expires_at) VALUES(?,?,?,?)`,
        hash, await digest(cookie), encrypted, this.clock()+600)
    ]);
    const url = new URL('https://x.com/i/oauth2/authorize');
    url.search = new URLSearchParams({ response_type: 'code', client_id: this.env.X_CLIENT_ID,
      redirect_uri: this.env.X_CALLBACK_URL, scope: scopes.join(' '), state,
      code_challenge: await digest(verifier), code_challenge_method: 'S256' }).toString();
    return { authorization_url: url.href,
      cookie: `${COOKIE}=${cookie}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600` };
  }

  async callback(request) {
    const url = new URL(request.url);
    const state = url.searchParams.get('state');
    const code = url.searchParams.get('code');
    const matches = (request.headers.get('cookie') ?? '').split(';').map(v => v.trim().split('='))
      .filter(([name]) => name === COOKIE);
    assert(state && /^[A-Za-z0-9_-]{43}$/.test(state) && matches.length === 1
      && /^[A-Za-z0-9_-]{43}$/.test(matches[0][1]), 'OAUTH_BROWSER_BINDING_REQUIRED');
    assert(url.searchParams.getAll('state').length === 1 && url.searchParams.getAll('code').length <= 1
      && url.searchParams.getAll('error').length <= 1, 'OAUTH_PARAMETERS_INVALID');
    const hash = await digest(state);
    const encrypted = await this.store.consumeState(hash, await digest(matches[0][1]));
    const payload = await open(this.env.TOKEN_ENCRYPTION_KEY, encrypted, `state:${hash}`);
    assert(payload.issuer === this.cfg.issuer && payload.subject === this.env.MCP_ALLOWED_SUBJECT,
      'OWNER_BINDING_MISMATCH', 403);
    assert(!url.searchParams.has('error') && typeof code === 'string' && code.length > 0 && code.length <= 2048,
      'X_AUTHORIZATION_DECLINED_OR_INVALID');
    const data = await this.request('/2/oauth2/token', { method: 'POST', oauth: true,
      body: new URLSearchParams({ grant_type: 'authorization_code', code,
        redirect_uri: this.env.X_CALLBACK_URL, code_verifier: payload.verifier }) });
    const tokens = this.tokenSet(data, payload.scopes);
    await this.verifyUser(tokens.access_token);
    await this.store.saveAccount(payload.issuer, payload.subject, this.env.X_EXPECTED_USER_ID,
      await seal(this.env.TOKEN_ENCRYPTION_KEY, tokens, this.context()), this.clock()+data.expires_in, payload.account_version);
    return { linked: true, x_user_id: this.env.X_EXPECTED_USER_ID, scopes: tokens.scopes };
  }

  async tokens({withVersion=false}={}) {
    const account = await this.store.account();
    this.bind(account);
    assert(account.refresh_status === 'idle', 'REFRESH_IN_PROGRESS_OR_RECONNECT_REQUIRED', 409);
    const tokens = await open(this.env.TOKEN_ENCRYPTION_KEY, account.encrypted_tokens, this.context());
    if (account.expires_at > this.clock()+60) return withVersion?{tokens,version:account.version}:tokens;
    const attempt = await this.store.claimRefresh(account.version);
    try {
      const data = await this.request('/2/oauth2/token', { method: 'POST', oauth: true,
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token }) });
      const replacement = this.tokenSet(data, tokens.scopes, tokens);
      await this.verifyUser(replacement.access_token);
      await this.store.finishRefresh(account.version, attempt,
        await seal(this.env.TOKEN_ENCRYPTION_KEY, replacement, this.context()), this.clock()+data.expires_in);
      return withVersion?{tokens:replacement,version:account.version+1}:replacement;
    } catch (error) {
      // Rotating token may be consumed. Do not release the marker and retry it.
      await this.store.failRefresh(account.version, attempt);
      throw error;
    }
  }

  async cached(kind, maxRecordAge = 7*86400) {
    return cachedRead(this.env, this.store, this.clock, kind, maxRecordAge);
  }

  async pollKind(kind, tokens) {
    const row = await this.store.first('SELECT * FROM snapshots WHERE kind=?', kind);
    const previous = row ? await open(this.env.TOKEN_ENCRYPTION_KEY, row.encrypted_payload, this.context(`snapshot:${kind}`)) : {};
    const params = new URLSearchParams({ max_results: '5', 'post.fields': 'created_at' });
    if (previous.since_id) params.set('since_id', previous.since_id);
    if (previous.next_token) params.set('pagination_token', previous.next_token);
    const suffix = kind === 'mentions' ? 'mentions' : 'tweets';
    const data = await this.request(`/2/users/${this.env.X_EXPECTED_USER_ID}/${suffix}?${params}`, {
      token: tokens.access_token, records: 5
    });
    assert(!data.errors && (!data.data || Array.isArray(data.data)), 'X_PARTIAL_OR_INVALID_READ', 502);
    const records = data.data ?? [];
    assert(records.length <= 5 && records.every(v => /^\d{1,25}$/.test(v.id) && typeof v.text === 'string'
      && v.text.length <= 20000 && (!v.author_id || /^\d{1,25}$/.test(v.author_id))), 'X_INVALID_POST_DATA', 502);
    const cursor = data.meta?.newest_id;
    const next = data.meta?.next_token;
    assert((!cursor || /^\d{1,25}$/.test(cursor)) && (!next || (typeof next === 'string' && next.length <= 2048)),
      'X_INVALID_CURSOR', 502);
    const highwater = previous.highwater ?? cursor ?? previous.since_id;
    const incoming = records.map(v => ({ ...v, seen_at: this.clock() }));
    const retained = (previous.records ?? []).filter(v => v.seen_at > this.clock()-7*86400);
    const unique = [...new Map([...retained, ...incoming].map(v => [v.id, {
      id: v.id, text: v.text, ...(v.author_id ? { author_id: v.author_id } : {}),
      ...(typeof v.created_at === 'string' ? { created_at: v.created_at } : {}), seen_at: v.seen_at
    }])).values()].sort((a,b) => BigInt(a.id) > BigInt(b.id) ? -1 : 1).slice(0,20);
    const snapshot = { records: unique, since_id: next ? previous.since_id : highwater,
      ...(next ? { next_token: next, highwater } : {}) };
    await this.store.run(`INSERT INTO snapshots(kind,encrypted_payload,fetched_at) VALUES(?,?,?)
      ON CONFLICT(kind) DO UPDATE SET encrypted_payload=excluded.encrypted_payload,fetched_at=excluded.fetched_at`,
    kind, await seal(this.env.TOKEN_ENCRYPTION_KEY, snapshot, this.context(`snapshot:${kind}`)), this.clock());
    return { kind, received: records.length, pending_pages: Boolean(next) };
  }

  async poll() {
    assert(enabled(this.env.READ_POLLING_ENABLED), 'READ_POLLING_DISABLED', 403);
    // Non-expiring claim prevents overlapping page/cursor updates across Worker instances.
    const claim = await this.store.first(`INSERT INTO cooldowns(name,until_at) VALUES('poll',1)
      ON CONFLICT(name) DO UPDATE SET until_at=1 WHERE cooldowns.until_at=0 RETURNING name`);
    assert(claim, 'POLL_IN_PROGRESS', 409);
    try {
      const tokens = await this.tokens();
      const mentions = await this.pollKind('mentions', tokens);
      const posts = await this.pollKind('posts', tokens);
      await this.store.cleanup();
      return { mentions, posts };
    } finally {
      await this.store.run("UPDATE cooldowns SET until_at=0 WHERE name='poll'");
    }
  }

  async send(kind, args) {
    assert(!ongoing(this.env),'ONGOING_USE_SERVICE_WRITE_ROUTE',403);
    assert(kind === 'post' || kind === 'reply', 'INVALID_SEND_KIND');
    if(kind==='reply') assert(REPLY_DEPLOYMENT_APPROVED,'REPLY_APPROVAL_REQUIRED',403);
    assert(enabled(this.env[kind === 'post' ? 'POST_ENABLED' : 'REPLY_ENABLED']), `${kind.toUpperCase()}_DISABLED`, 403);
    validatePostText(args.text);
    assert(isPostId(this.env.SERVICE_X_ACCOUNT_ID) && this.env.SERVICE_X_ACCOUNT_ID===this.env.X_EXPECTED_USER_ID,
      'VERIFIED_SERVICE_ACCOUNT_REQUIRED',503);
    assert(typeof args.idempotency_key === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(args.idempotency_key),
      'IDEMPOTENCY_KEY_REQUIRED');
    if (kind === 'reply') {
      assert(/^\d{1,25}$/.test(args.in_reply_to_post_id ?? ''), 'REPLY_TARGET_REQUIRED');
      const mentions = await this.cached('mentions', 7*3600);
      assert(!mentions.stale && mentions.records.some(v => v.id === args.in_reply_to_post_id),
        'REPLY_TARGET_NOT_IN_FRESH_MENTIONS', 403);
    }
    const grant = await this.tokens({withVersion:true});
    const tokens=grant.tokens;
    assert(tokens.scopes.includes('tweet.write'), 'X_WRITE_SCOPE_REQUIRED', 403);
    const payload = { text: args.text, ...(kind === 'reply' ? { reply: { in_reply_to_tweet_id: args.in_reply_to_post_id } } : {}) };
    const keyHash = await digest(`${this.context('send')}:${args.idempotency_key}`);
    const payloadHash = await digest(`${this.context('send')}:${JSON.stringify(payload)}`);
    const duplicate = await this.store.reserveSend(keyHash, payloadHash);
    if (duplicate) return duplicate;
    try {
      const current=await this.store.account();this.bind(current);
      assert(current.version===grant.version && current.refresh_status==='idle','X_GRANT_SUPERSEDED',409);
      const result = await this.request('/2/tweets', { method: 'POST', token: tokens.access_token, body: payload, write: true, grantVersion:grant.version });
      assert(!result.errors && isPostId(result.data?.id), 'X_SEND_RESULT_INVALID', 502);
      await this.store.run("UPDATE sends SET status='sent',result_id=? WHERE idempotency_hash=?", result.data.id, keyHash);
      return { id: result.data.id, duplicate: false };
    } catch (error) {
      await this.store.run("UPDATE sends SET status='uncertain' WHERE idempotency_hash=?", keyHash);
      throw error;
    }
  }
}
