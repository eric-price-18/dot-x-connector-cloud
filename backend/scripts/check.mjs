import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { CREDIT_RUN_ID, CREDIT_RUN_DEADLINE, CREDIT_MAX_MICROUSD } from '../src/credit-policy.mjs';
import { SERVICE } from '../src/service.mjs';
import { REPLY_DEPLOYMENT_APPROVED, WRITE_AUDIENCE } from '../src/write-policy.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const gates=['ONGOING_MAINTENANCE_ENABLED','X_ONGOING_OPERATIONS_ENABLED','LIVE_X_ENABLED','LIVE_IDP_ENABLED','READ_POLLING_ENABLED','POST_ENABLED','REPLY_ENABLED',
  'OWNER_LOGIN_ENABLED','SERVICE_ENABLED','SERVICE_WRITE_ENABLED','X_ORIGINAL_POSTS_ENABLED',
  'X_REPOSTS_ENABLED','X_OWN_THREAD_REPLIES_ENABLED','X_WRITE_STATUS_ENABLED','OWNER_X_WRITE_CONSENT_ENABLED'];
for(const name of ['wrangler.jsonc','config/oauth.example.json']) {
  const config=JSON.parse(readFileSync(resolve(root,name),'utf8'));
  assert.equal(config.main,name==='wrangler.jsonc'?'src/worker.mjs':'../src/worker.mjs','Only the production Worker may be an example entry point');
  for(const key of gates) assert.equal(config.vars[key],'false',`${key} must remain disabled in ${name}`);
  assert.deepEqual(config.triggers.crons,[]);
  assert.equal(config.workers_dev,false);assert.equal(config.preview_urls,false);
  assert.equal(config.observability.enabled,false);
  assert.equal(config.observability.logs.enabled,false);assert.equal(config.observability.logs.invocation_logs,false);
  assert.equal(config.observability.traces.enabled,false);
  assert(!config.account_id && !config.d1_databases && !config.routes,'Examples must not provision or name live infrastructure');
  for(const [key,value] of Object.entries(config.vars)) {
    assert(!/SECRET|ENCRYPTION_KEY|ALLOWED_SUBJECT|CLIENT_ID|PUBLIC_JWK|X_EXPECTED_USER_ID|SERVICE_X_ACCOUNT_ID|X_CREDIT_|X_CANARY_/.test(key),`Live binding ${key} is not allowed in examples`);
    if(key.endsWith('_ENABLED'))assert.equal(value,'false');
    if(typeof value==='string' && value.startsWith('https://'))assert(new URL(value).hostname.endsWith('.example.invalid'));
  }
}
assert.equal(SERVICE.issuer,'https://frontend.example.invalid');
assert.equal(SERVICE.subject,'dot-x-connector:example-deployment');
assert.equal(SERVICE.audience,'https://backend.example.invalid/service/mcp');
assert.equal(WRITE_AUDIENCE,'https://backend.example.invalid/service/write/mcp');
assert.equal(REPLY_DEPLOYMENT_APPROVED,false);
assert.equal(CREDIT_RUN_ID,'example-disabled-budget');
assert.equal(CREDIT_RUN_DEADLINE,Date.parse('2000-01-02T08:00:00Z')/1000);
assert.equal(CREDIT_MAX_MICROUSD,5000000);
assert(CREDIT_RUN_DEADLINE < Math.floor(Date.now()/1000),'Public credit window must remain expired');
let modules=0,runtimeBytes=0;
for(const folder of ['src','test','runtime-test','scripts']) {
  for(const file of readdirSync(resolve(root,folder)).filter(v=>/\.[cm]js$/.test(v))) {
    const path=resolve(root,folder,file);
    const check=spawnSync(process.execPath,['--check',path],{encoding:'utf8',windowsHide:true});
    assert.equal(check.status,0,check.stderr);modules++;
    if(folder==='src') {
      const source=readFileSync(path,'utf8');
      assert(!/(?:from|import)\s*['"](?!\.)/.test(source),'Runtime imports must remain local and dependency-free');
      runtimeBytes+=Buffer.byteLength(source);
    }
  }
}
const db=new DatabaseSync(':memory:');
for(const file of readdirSync(resolve(root,'migrations')).filter(v=>v.endsWith('.sql')).sort())
  db.exec(readFileSync(resolve(root,'migrations',file),'utf8'));
const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(v=>v.name);
assert.deepEqual(tables,['accounts','budgets','canary_mention','cooldowns','oauth_states','ongoing_credit_state','ongoing_cycles','ongoing_legacy_carry','ongoing_maintenance','ongoing_operations','ongoing_spend','owner_login_state','owner_sessions','reply_interactions','reply_opt_out_scans','reply_opt_outs','sends','service_writes','snapshots','x_credit_budgets']);
assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
const sqliteVersion=db.prepare('SELECT sqlite_version() AS version').get().version;db.close();
console.log(`PASS: ${modules} modules parse; ${runtimeBytes} runtime bytes; migrations/integrity (SQLite ${sqliteVersion}); generic trust pins, expired immutable budget, disabled live/write/reply gates and empty schedules verified.`);
