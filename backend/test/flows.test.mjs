import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, rejectsCode, response, accidentalNetwork } from './helpers.mjs';
import { basicAuth, digest, open, seal } from '../src/security.mjs';
import { XConnector } from '../src/x.mjs';

function barrier() {
  let arrive, release;
  return { arrived: new Promise(resolve=>{arrive=resolve;}),
    wait: new Promise(resolve=>{release=resolve;}), arrive:()=>arrive(), release:()=>release() };
}

test('X link uses confidential Basic auth, S256, read-only scopes, exact callback and encrypted storage', async t => {
  const h = harness(t); const link = await h.link();
  assert.equal(link.url.origin,'https://x.com');
  assert.equal(link.url.searchParams.get('code_challenge_method'),'S256');
  assert.equal(link.url.searchParams.get('scope'),'tweet.read users.read offline.access');
  assert.equal(link.url.searchParams.get('redirect_uri'),h.env.X_CALLBACK_URL);
  const exchange = h.state.xCalls[0];
  assert.equal(exchange.options.headers.authorization,basicAuth(h.env.X_CLIENT_ID,h.env.X_CLIENT_SECRET));
  const body = new URLSearchParams(exchange.options.body);
  assert.equal(await digest(body.get('code_verifier')),link.url.searchParams.get('code_challenge'));
  assert.equal(body.get('grant_type'),'authorization_code');
  assert.equal(body.get('client_id'),null);
  assert.equal(body.get('redirect_uri'),h.env.X_CALLBACK_URL);
  assert.equal(h.state.xCalls[1].options.headers.authorization,'Bearer mock-access-1');
  const row = await h.store.account();
  assert.equal(row.x_user_id,'4242');
  assert(!row.encrypted_tokens.includes('mock-access-1'));
  assert(!row.encrypted_tokens.includes('mock-refresh-1'));
  assert.equal((await open(h.env.TOKEN_ENCRYPTION_KEY,row.encrypted_tokens,h.x.context())).refresh_token,'mock-refresh-1');
  assert.equal(h.db.all('SELECT * FROM oauth_states').length,0);
});

test('state stores hashes and encrypted PKCE verifier and requires the browser cookie', async t => {
  const h = harness(t); const link = await h.start();
  const state = link.url.searchParams.get('state');
  const row = h.db.all('SELECT * FROM oauth_states')[0];
  assert.equal(row.state_hash,await digest(state));
  assert(!JSON.stringify(row).includes(state));
  assert(!JSON.stringify(row).includes(link.cookie.split('=')[1]));
  const res = await h.api(`/x/callback?state=${state}&code=mock-code`);
  assert.equal((await res.json()).error,'OAUTH_BROWSER_BINDING_REQUIRED');
  assert.equal(h.state.xCalls.length,0);
  assert.equal(h.db.all('SELECT * FROM oauth_states').length,1);
  const completed = await h.complete(link);
  assert.equal(completed.status,200);
  assert(completed.headers.get('set-cookie').includes('Max-Age=0'));
});

test('X link cookie is Secure, HttpOnly, __Host and SameSite=Lax', async t => {
  const h = harness(t);
  const res = await h.api('/x/connect',{method:'POST',auth:true,data:{}});
  const cookie = res.headers.get('set-cookie');
  for (const value of ['__Host-x-link=','Secure','HttpOnly','SameSite=Lax','Path=/','Max-Age=600']) assert(cookie.includes(value));
  assert(!cookie.includes('Domain='));
});

test('wrong browser cookie cannot consume another transaction', async t => {
  const h = harness(t); const link = await h.start();
  const res = await h.api(`/x/callback?state=${link.url.searchParams.get('state')}&code=mock-code`,{
    headers:{cookie:`__Host-x-link=${'A'.repeat(43)}`} });
  assert.equal((await res.json()).error,'OAUTH_STATE_INVALID_OR_EXPIRED');
  assert.equal(h.db.all('SELECT * FROM oauth_states').length,1);
  assert.equal(h.state.xCalls.length,0);
});

test('expired state, duplicate parameters and replay fail without token exchange', async t => {
  const h = harness(t); const first = await h.start();
  const duplicate = await h.api(`/x/callback?state=${first.url.searchParams.get('state')}&state=bad&code=mock`,{headers:{cookie:first.cookie}});
  assert.equal((await duplicate.json()).error,'OAUTH_PARAMETERS_INVALID');
  h.state.now += 600;
  assert.equal((await (await h.complete(first)).json()).error,'OAUTH_STATE_INVALID_OR_EXPIRED');
  assert.equal(h.state.xCalls.length,0);
  const valid = await h.link();
  const count = h.state.xCalls.length;
  assert.equal((await (await h.complete(valid)).json()).error,'OAUTH_STATE_INVALID_OR_EXPIRED');
  assert.equal(h.state.xCalls.length,count);
});

test('authorization denial consumes state and never exposes provider error text', async t => {
  const h = harness(t); const link = await h.start();
  const res = await h.complete(link,{error:'access_denied',error_description:'mock-private-error'});
  assert.equal((await res.json()).error,'X_AUTHORIZATION_DECLINED_OR_INVALID');
  assert.equal(h.db.all('SELECT * FROM oauth_states').length,0);
  assert.equal(h.state.xCalls.length,0);
  assert(!h.state.logs.join(' ').includes('mock-private-error'));
});

test('simultaneous callback replay exchanges a code only once', async t => {
  const h = harness(t); const link = await h.start();
  const responses = await Promise.all([h.complete(link),h.complete(link)]);
  assert.deepEqual(responses.map(v=>v.status).sort(),[200,400]);
  assert.equal(h.state.xCalls.filter(v=>new URL(v.url).pathname==='/2/oauth2/token').length,1);
});

test('second authorization start invalidates the first transaction', async t => {
  const h = harness(t); const first = await h.start(); const second = await h.start();
  assert.notEqual(first.url.searchParams.get('state'),second.url.searchParams.get('state'));
  assert.equal((await (await h.complete(first)).json()).error,'OAUTH_STATE_INVALID_OR_EXPIRED');
  assert.equal((await h.complete(second)).status,200);
});

test('verified wrong X user never becomes linked', async t => {
  const h = harness(t); h.state.userId='4343'; const link = await h.start();
  const res = await h.complete(link);
  assert.equal(res.status,403);
  assert.equal((await res.json()).error,'X_ACCOUNT_BINDING_MISMATCH');
  assert.equal(await h.store.account(),null);
});

for (const [name, scopes] of [
  ['DM scope','tweet.read users.read offline.access dm.read'],
  ['follow scope','tweet.read users.read offline.access follows.write'],
  ['unrequested write','tweet.read users.read offline.access tweet.write'],
  ['missing read','users.read offline.access']
]) test(`grant rejects ${name}`, async t => {
  const h = harness(t); h.state.xScopes=scopes;
  const link = await h.start();
  assert.equal((await (await h.complete(link)).json()).error,'X_SCOPE_MISMATCH');
  assert.equal(await h.store.account(),null);
});

test('missing refresh token and invalid expiry are rejected', async t => {
  const h = harness(t);
  for (const change of [{refresh_token:null},{expires_in:0},{token_type:'mac'}]) {
    h.state.onX = url=>new URL(url).pathname==='/2/oauth2/token' ? response({access_token:'mock-access',refresh_token:'mock-refresh',token_type:'bearer',expires_in:7200,scope:h.state.xScopes,...change}) : undefined;
    const link = await h.start();
    assert.notEqual((await h.complete(link)).status,200);
    assert.equal(await h.store.account(),null);
  }
});

test('actual callback must be configured exactly before creating state', async t => {
  const h = harness(t); h.env.X_CALLBACK_URL = `${h.cfg.base}/other`;
  const res = await h.api('/x/connect',{method:'POST',auth:true,data:{}});
  assert.equal((await res.json()).error,'EXACT_X_CALLBACK_REQUIRED');
  assert.equal(h.db.all('SELECT * FROM oauth_states').length,0);
});

test('expired token refresh rotates once across separate connector instances', async t => {
  const h = harness(t); await h.seed({expires:h.state.now});
  const other = new XConnector(h.env,h.cfg,h.store,h.xFetch,h.clock);
  const results = await Promise.allSettled([h.x.tokens(),other.tokens()]);
  assert.equal(results.filter(v=>v.status==='fulfilled').length,1);
  assert.equal(results.filter(v=>v.status==='rejected').length,1);
  assert.equal(h.state.xCalls.filter(v=>new URL(v.url).pathname==='/2/oauth2/token').length,1);
  const row = await h.store.account();
  assert.equal(row.version,2);
  assert.equal(row.refresh_status,'idle');
  assert.equal((await h.x.tokens()).refresh_token,'mock-refresh-1');
  assert.equal(h.state.xCalls.length,2);
});

test('lost refresh response blocks rotating-token reuse across later requests', async t => {
  const h = harness(t); await h.seed({expires:h.state.now});
  h.state.onX = () => { throw new Error('mock timeout'); };
  await rejectsCode(h.x.tokens(),'X_REQUEST_UNCERTAIN');
  assert.equal((await h.store.account()).refresh_status,'reconnect');
  h.state.now += 86400;
  await rejectsCode(h.x.tokens(),'REFRESH_IN_PROGRESS_OR_RECONNECT_REQUIRED');
  assert.equal(h.state.xCalls.length,1);
});

test('crashed refresh marker never automatically expires', async t => {
  const h = harness(t); await h.seed({expires:h.state.now});
  await h.store.claimRefresh(1); h.state.now += 7*86400;
  await rejectsCode(h.x.tokens(),'REFRESH_IN_PROGRESS_OR_RECONNECT_REQUIRED');
  assert.equal(h.state.xCalls.length,0);
});

test('refresh verifies user identity and fails closed on a changed X user', async t => {
  const h = harness(t); await h.seed({expires:h.state.now}); h.state.userId='4343';
  await rejectsCode(h.x.tokens(),'X_ACCOUNT_BINDING_MISMATCH');
  assert.equal((await h.store.account()).refresh_status,'reconnect');
});

test('refresh cannot escalate scopes, and missing refresh scope retains the grant', async t => {
  const h = harness(t); await h.seed({expires:h.state.now});
  h.state.xScopes += ' tweet.write';
  await rejectsCode(h.x.tokens(),'X_SCOPE_MISMATCH');
  await h.seed({expires:h.state.now});
  h.state.onX = url=>new URL(url).pathname==='/2/oauth2/token' ? response({token_type:'bearer',expires_in:7200,access_token:'mock-rotated'}) : undefined;
  const tokens = await h.x.tokens();
  assert.equal(tokens.refresh_token,'mock-seeded-refresh');
  assert(!tokens.scopes.includes('tweet.write'));
});

test('reauthorization fences a stale refresh without damaging the new grant', async t => {
  const h = harness(t); await h.seed({expires:h.state.now}); const gate=barrier();
  h.state.onX = async url => {
    if (new URL(url).pathname==='/2/oauth2/token') { gate.arrive(); await gate.wait; }
  };
  const refreshing = h.x.tokens();
  await gate.arrived;
  await h.seed();
  gate.release();
  await rejectsCode(refreshing,'REFRESH_SUPERSEDED_RECONNECT_REQUIRED');
  const row = await h.store.account();
  assert.equal(row.version,2); assert.equal(row.refresh_status,'idle');
  assert.equal((await h.x.tokens()).access_token,'mock-seeded-access');
});

test('a late authorization callback cannot overwrite a newer grant', async t => {
  const h = harness(t); const first=await h.start(); const gate=barrier(); let block=true;
  h.state.onX = async url => {
    if (new URL(url).pathname==='/2/oauth2/token' && block) { block=false; gate.arrive(); await gate.wait; }
  };
  const firstResult = h.complete(first);
  await gate.arrived;
  const second=await h.start();
  assert.equal((await h.complete(second)).status,200);
  gate.release();
  assert.equal((await (await firstResult).json()).error,'ACCOUNT_BINDING_MISMATCH');
  assert.equal((await h.store.account()).version,1);
});

test('scheduled read polling caches encrypted mentions/posts and MCP reads make no X calls', async t => {
  const h = harness(t,{READ_POLLING_ENABLED:'true'}); await h.seed();
  const before = h.db.queries;
  const polled = await h.worker.scheduled({},h.env,{});
  assert.equal(polled.mentions.received,1);
  assert.equal(polled.posts.received,1);
  assert(h.db.queries-before<50,'poll must fit free-tier D1 query limit');
  assert.equal(h.state.xCalls.length,2);
  const rows = h.db.all('SELECT * FROM snapshots');
  assert(!JSON.stringify(rows).includes('Mock mention'));
  const mention = await h.call('x_read_mentions');
  assert.equal(mention.body.result.structuredContent.records[0].text,'Mock mention');
  assert.equal(mention.body.result.structuredContent.stale,false);
  assert(!Object.hasOwn(mention.body.result.structuredContent.records[0],'seen_at'));
  assert.equal(h.state.xCalls.length,2);
  assert.equal(accidentalNetwork.length,0);
});

test('disabled scheduled polling is a zero-query, zero-network no-op', async t => {
  const h = harness(t);
  assert.deepEqual(await h.worker.scheduled({},h.env,{}),{skipped:'READ_POLLING_DISABLED'});
  assert.equal(h.db.queries,0);
  assert.equal(h.state.xCalls.length+h.state.idpCalls.length,0);
});

test('overlapping polls are rejected and release the claim after completion', async t => {
  const h = harness(t,{READ_POLLING_ENABLED:'true'}); await h.seed(); const gate=barrier(); let block=true;
  h.state.onX = async () => { if (block) { block=false; gate.arrive(); await gate.wait; } };
  const poll = h.x.poll(); await gate.arrived;
  await rejectsCode(h.x.poll(),'POLL_IN_PROGRESS');
  gate.release(); await poll;
  assert.equal(h.state.xCalls.length,2);
  assert.equal(h.db.all("SELECT * FROM cooldowns WHERE name='poll'")[0].until_at,0);
});

test('pagination retains the old since_id until the final bounded page', async t => {
  const h = harness(t); await h.seed(); const tokens=await h.x.tokens();
  await h.x.pollKind('mentions',tokens);
  h.state.mentions={data:[{id:'1010',text:'New page'}],meta:{newest_id:'1010',next_token:'mock-page-2'}};
  await h.x.pollKind('mentions',tokens);
  const second=await open(h.env.TOKEN_ENCRYPTION_KEY,h.db.all("SELECT * FROM snapshots WHERE kind='mentions'")[0].encrypted_payload,h.x.context('snapshot:mentions'));
  assert.equal(second.since_id,'1002'); assert.equal(second.highwater,'1010');
  h.state.mentions={data:[{id:'1009',text:'Older page'}],meta:{newest_id:'1009'}};
  await h.x.pollKind('mentions',tokens);
  const request=new URL(h.state.xCalls.at(-1).url);
  assert.equal(request.searchParams.get('pagination_token'),'mock-page-2');
  assert.equal(request.searchParams.get('since_id'),'1002');
  assert.equal(request.searchParams.get('max_results'),'5');
  const final=await open(h.env.TOKEN_ENCRYPTION_KEY,h.db.all("SELECT * FROM snapshots WHERE kind='mentions'")[0].encrypted_payload,h.x.context('snapshot:mentions'));
  assert.equal(final.since_id,'1010'); assert.equal(final.next_token,undefined);
  assert.deepEqual(final.records.map(v=>v.id),['1010','1009','1002']);
});

test('cache is bounded to 20 records and ages out even while empty polls continue', async t => {
  const h = harness(t,{MAX_X_REQUESTS_HOUR:'20'}); h.state.now-=20*86400; await h.seed(); const tokens=await h.x.tokens();
  for (let page=0;page<5;page++) {
    h.state.mentions={data:Array.from({length:5},(_,n)=>({id:String(2000+page*5+n),text:'Mock post'})),meta:{newest_id:String(2000+page*5+4)}};
    await h.x.pollKind('mentions',tokens);
  }
  assert.equal((await h.x.cached('mentions')).records.length,20);
  h.state.now+=7*86400;
  h.state.mentions={meta:{result_count:0}};
  await h.x.pollKind('mentions',tokens);
  assert.equal((await h.x.cached('mentions')).records.length,0);
  h.state.now+=8*86400;
  assert.equal((await h.x.cached('mentions')).fetched_at,null);
});

test('partial X read does not advance the cursor or replace cached data', async t => {
  const h = harness(t); await h.seed(); const tokens=await h.x.tokens();
  await h.x.pollKind('mentions',tokens);
  const before=h.db.all('SELECT * FROM snapshots')[0].encrypted_payload;
  h.state.mentions={data:[{id:'2000',text:'partial'}],errors:[{detail:'private upstream error'}],meta:{newest_id:'2000'}};
  await rejectsCode(h.x.pollKind('mentions',tokens),'X_PARTIAL_OR_INVALID_READ');
  assert.equal(h.db.all('SELECT * FROM snapshots')[0].encrypted_payload,before);
});

test('429 sets persistent cooldown; no automatic retries occur', async t => {
  const h = harness(t); await h.seed();
  h.state.onX=()=>response({detail:'private'},429,{'x-rate-limit-reset':String(h.state.now+900)});
  await rejectsCode(h.x.pollKind('mentions',await h.x.tokens()),'X_RATE_LIMITED');
  await rejectsCode(h.x.pollKind('posts',await h.x.tokens()),'X_RATE_LIMIT_COOLDOWN');
  assert.equal(h.state.xCalls.length,1);
  h.state.now+=901; h.state.onX=null;
  await h.x.pollKind('posts',await h.x.tokens());
  assert.equal(h.state.xCalls.length,2);
});

test('atomic concurrent budgets never exceed their limit', async t => {
  const h = harness(t);
  const outcomes=await Promise.allSettled(Array.from({length:12},()=>h.store.reserve('test',1,3,h.state.now+100)));
  assert.equal(outcomes.filter(v=>v.status==='fulfilled').length,3);
  assert.equal(h.db.all("SELECT * FROM budgets WHERE bucket='test'")[0].used,3);
});

test('monthly record budget reserves maximum page size before any X request', async t => {
  const h = harness(t,{MAX_READ_RECORDS_MONTH:'4'}); await h.seed();
  await rejectsCode(h.x.pollKind('mentions',await h.x.tokens()),'LOCAL_BUDGET_EXHAUSTED');
  assert.equal(h.state.xCalls.length,0);
});

test('zero and invalid request budgets fail closed', async t => {
  const h = harness(t,{MAX_X_REQUESTS_DAY:'0'}); await h.seed();
  await rejectsCode(h.x.pollKind('mentions',await h.x.tokens()),'LOCAL_BUDGET_EXHAUSTED');
  h.env.MAX_X_REQUESTS_DAY='unlimited';
  await rejectsCode(h.x.pollKind('mentions',await h.x.tokens()),'INVALID_BUDGET_CONFIGURATION');
  assert.equal(h.state.xCalls.length,0);
});

test('hour and day budget periods reset by UTC clock', async t => {
  const h = harness(t,{MAX_X_REQUESTS_DAY:'2',MAX_X_REQUESTS_HOUR:'1'}); h.state.now-=2*86400; await h.seed();
  const tokens=await h.x.tokens();
  await h.x.pollKind('mentions',tokens);
  await rejectsCode(h.x.pollKind('posts',tokens),'LOCAL_BUDGET_EXHAUSTED');
  h.state.now+=86400;
  await h.x.pollKind('posts',tokens);
  assert.equal(h.state.xCalls.length,2);
});

test('expired-token polling including refresh fits the 50-query D1 free-tier ceiling', async t => {
  const h=harness(t,{READ_POLLING_ENABLED:'true'}); await h.seed({expires:h.state.now});
  const before=h.db.queries;
  await h.worker.scheduled({},h.env,{});
  assert(h.db.queries-before<50);
  assert.equal(h.state.xCalls.length,4);
});

test('X and MCP bearer tokens never cross the provider boundary', async t => {
  const h=harness(t,{READ_POLLING_ENABLED:'true'}); await h.link();
  await h.worker.scheduled({},h.env,{}); await h.call('x_read_mentions');
  for (const call of h.state.xCalls) assert(!JSON.stringify(call).includes('mock-mcp-token'));
  for (const call of h.state.idpCalls) {
    const content=JSON.stringify(call);
    assert(!content.includes('mock-access-')); assert(!content.includes('mock-refresh-'));
    assert(!content.includes(h.env.X_CLIENT_SECRET));
  }
});
