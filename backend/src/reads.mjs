import { assert, enabled, httpsUrl, open } from './security.mjs';
import { Store } from './storage.mjs';

// Reads cannot construct an X transport, refresh tokens, link accounts or send.
export const READ_TOOLS = Object.freeze(['x_connection_status', 'x_read_mentions', 'x_read_posts']);

export function ownerContext(env, kind = 'account') {
  return `${kind}:primary:${env.MCP_ISSUER}:${env.MCP_ALLOWED_SUBJECT}:${env.X_EXPECTED_USER_ID}`;
}

export function bindOwner(env, account) {
  httpsUrl(env.MCP_ISSUER);
  assert(typeof env.MCP_ALLOWED_SUBJECT === 'string' && env.MCP_ALLOWED_SUBJECT.length > 0
    && /^\d{1,25}$/.test(env.X_EXPECTED_USER_ID ?? ''), 'OWNER_BINDING_CONFIGURATION_REQUIRED', 503);
  assert(account && account.issuer === env.MCP_ISSUER && account.subject === env.MCP_ALLOWED_SUBJECT
    && account.x_user_id === env.X_EXPECTED_USER_ID, 'ACCOUNT_NOT_LINKED_OR_BINDING_MISMATCH', 403);
}

export async function cachedRead(env, store, clock, kind, maxRecordAge = 7*86400) {
  assert(['mentions','posts'].includes(kind), 'INVALID_CACHE_KIND');
  bindOwner(env, await store.account());
  const row = await store.first('SELECT * FROM snapshots WHERE kind=?', kind);
  if (!row || row.fetched_at <= clock()-7*86400)
    return { records: [], fetched_at: null, stale: true, pending_pages: false };
  const data = await open(env.TOKEN_ENCRYPTION_KEY, row.encrypted_payload, ownerContext(env, `snapshot:${kind}`));
  return { records: data.records.filter(v => v.seen_at > clock()-maxRecordAge).map(({seen_at, ...v}) => v),
    fetched_at: new Date(row.fetched_at*1000).toISOString(),
    stale: row.fetched_at <= clock()-7*3600, pending_pages: Boolean(data.next_token) };
}

export async function readTool(name, env, clock) {
  assert(READ_TOOLS.includes(name), 'UNKNOWN_OR_DISABLED_TOOL');
  // No DB means not provisioned, hence no linked account. A present but broken
  // binding or database query must fail rather than masquerade as unlinked.
  const store = env.DB === undefined ? null : new Store(env.DB, clock);
  if (name === 'x_connection_status') {
    const account = store ? await store.account() : null;
    if (account) bindOwner(env, account);
    return { linked: Boolean(account), reconnect_required: account ? account.refresh_status !== 'idle' : false,
      polling_enabled: enabled(env.READ_POLLING_ENABLED), post_enabled: enabled(env.POST_ENABLED),
      reply_enabled: enabled(env.SERVICE_WRITE_ENABLED) && enabled(env.X_OWN_THREAD_REPLIES_ENABLED) && enabled(env.REPLY_ENABLED) };
  }
  assert(store, 'D1_BINDING_REQUIRED', 503);
  return cachedRead(env, store, clock, name === 'x_read_mentions' ? 'mentions' : 'posts');
}
