import test from 'node:test';
import assert from 'node:assert/strict';
import {ownerHarness} from './owner-fixtures.mjs';
import {reconcileOngoing,reconciliationManifest} from '../src/maintenance.mjs';
import {Store} from '../src/storage.mjs';
const path='/owner/maintenance/ongoing-reconcile';
async function setup(t,overrides={}) {
 const h=await ownerHarness(t,{ONGOING_MAINTENANCE_ENABLED:'true',LIVE_X_ENABLED:'false',READ_POLLING_ENABLED:'false',POST_ENABLED:'false',REPLY_ENABLED:'false',SERVICE_WRITE_ENABLED:'false',X_ORIGINAL_POSTS_ENABLED:'false',X_REPOSTS_ENABLED:'false',X_OWN_THREAD_REPLIES_ENABLED:'false',X_ONGOING_OPERATIONS_ENABLED:'false',...overrides});
 await h.seed();h.store=new Store(h.env.DB,()=>h.state.now);
 h.manifest={account_id:h.env.X_EXPECTED_USER_ID,observed_at:h.state.now,cycle_start:h.state.now,cycle_end:Date.parse('2000-01-31T10:00Z')/1000,provider_cycle_month:'2000-01',confirmed_used_micro_usd:0,confirmed_prepaid_micro_usd:4000000,evidence_id:'a'.repeat(64),auto_recharge_off:true,exclusive_billing:true};
 h.env.ONGOING_RECONCILIATION_JSON=JSON.stringify(h.manifest);return h;
}
test('owner form completes generic fresh-account reconciliation without X calls; replay cannot reset it',async t=>{
 const h=await setup(t),session=await h.login();assert(session.html.includes('Apply spending reconciliation'));assert(!session.html.includes('a'.repeat(64)));
 const res=await h.form(path,session);assert.equal(res.status,200,await res.clone().text());assert.deepEqual(await res.json(),{reconciled:true});assert.equal(h.state.xCalls.length,0);
 const before=h.db.all('SELECT * FROM ongoing_credit_state');assert.equal(before[0].prepaid_micro_usd,4000000);
 assert.equal((await h.form(path,session)).status,409);assert.deepEqual(h.db.all('SELECT * FROM ongoing_credit_state'),before);
});
test('reconciliation endpoint denies anonymous, cross-origin, CSRF and caller-supplied amounts',async t=>{
 const h=await setup(t),session=await h.login();
 assert.equal((await h.form(path,{...session,cookie:''})).status,401);
 assert.equal((await h.form(path,session,{}, {origin:'https://other.example.invalid'})).status,403);
 assert.equal((await h.form(path,{...session,csrf:'wrong'})).status,403);
 assert.equal((await h.form(path,session,{confirmed_prepaid_micro_usd:'999999999'})).status,403);
 assert.equal(h.db.all('SELECT * FROM ongoing_credit_state').length,0);assert.equal(h.state.xCalls.length,0);
});
test('maintenance default-off and every activity gate blocks reconciliation',async t=>{
 for(const name of ['LIVE_X_ENABLED','READ_POLLING_ENABLED','POST_ENABLED','REPLY_ENABLED','SERVICE_WRITE_ENABLED','X_ORIGINAL_POSTS_ENABLED','X_REPOSTS_ENABLED','X_OWN_THREAD_REPLIES_ENABLED','X_ONGOING_OPERATIONS_ENABLED']){
  const h=await setup(t,{[name]:'true'});await assert.rejects(reconcileOngoing(h.store,h.env),e=>e.code==='MAINTENANCE_REQUIRES_ACTIVITY_SHUTDOWN');
 }
 const h=await setup(t,{ONGOING_MAINTENANCE_ENABLED:'false'});await assert.rejects(reconcileOngoing(h.store,h.env),e=>e.code==='ONGOING_MAINTENANCE_DISABLED');
});
test('binding mismatch, stale evidence, malformed account, recharge or shared billing cannot initialize',async t=>{
 for(const changed of [{account_id:'9000'},{account_id:null},{observed_at:0},{auto_recharge_off:false},{exclusive_billing:false},{unexpected:'field'}]){
  const h=await setup(t);h.env.ONGOING_RECONCILIATION_JSON=JSON.stringify({...h.manifest,...changed});await assert.rejects(reconcileOngoing(h.store,h.env));assert.equal(h.db.all('SELECT * FROM ongoing_credit_state').length,0);
 }
 const h=await setup(t);h.env.MCP_ALLOWED_SUBJECT='another-owner';await assert.rejects(reconcileOngoing(h.store,h.env));
});
test('legacy reservation carry is automatic and never deletes or classifies old writes',async t=>{
 const h=await setup(t);h.db.sqlite.prepare('INSERT INTO x_credit_budgets VALUES(?,?,?,?,?,?,?)').run('synthetic-old',h.env.X_EXPECTED_USER_ID,5000000,100000,300000,h.state.now-1,h.state.now-86400);
 const before=h.db.all('SELECT * FROM x_credit_budgets');await reconcileOngoing(h.store,h.env);
 assert.deepEqual(h.db.all('SELECT * FROM x_credit_budgets'),before);assert.equal(h.db.all('SELECT * FROM ongoing_legacy_carry')[0].legacy_total_micro_usd,300000);assert.equal(h.db.all('SELECT * FROM ongoing_credit_state')[0].prepaid_micro_usd,3700000);assert.equal(h.db.all('SELECT * FROM ongoing_spend')[0].amount,300000);
});
test('batch failure rolls back all new records and missing or incompatible schema blocks',async t=>{
 const h=await setup(t);const batch=h.store.db.batch.bind(h.store.db);h.store.db.batch=q=>batch([...q,h.store.statement('INSERT INTO absent_table VALUES(1)')]);await assert.rejects(reconcileOngoing(h.store,h.env));assert.equal(h.db.all('SELECT * FROM ongoing_credit_state').length,0);
 const g=await setup(t);g.db.sqlite.exec('DROP TABLE ongoing_maintenance');await assert.rejects(reconcileOngoing(g.store,g.env),e=>e.code==='ONGOING_SCHEMA_MIGRATION_REQUIRED');
});
test('a later confirmed month cannot replenish credit or repeat a prior month',async t=>{
 const h=await setup(t);await reconcileOngoing(h.store,h.env);h.state.now=Date.parse('2000-02-02T12:00Z')/1000;
 h.env.ONGOING_RECONCILIATION_JSON=JSON.stringify({...h.manifest,observed_at:h.state.now,cycle_start:h.state.now,cycle_end:Date.parse('2000-02-29T10:00Z')/1000,provider_cycle_month:'2000-02',confirmed_prepaid_micro_usd:4500000});await reconcileOngoing(h.store,h.env);
 assert.equal(h.db.all('SELECT * FROM ongoing_credit_state')[0].prepaid_micro_usd,4000000);assert.equal(h.db.all('SELECT * FROM ongoing_legacy_carry').length,1);assert.equal(h.db.all('SELECT * FROM ongoing_cycles').length,2);
});
test('calendar month boundary has a conservative UTC intersection, not a private timezone assumption',async t=>{
 const h=await setup(t);assert.equal(reconciliationManifest(h.env,h.state.now).provider_cycle_month,'2000-01');
 for(const patch of [{cycle_start:h.state.now-1},{cycle_end:Date.parse('2000-02-01T00:00Z')/1000}]){h.env.ONGOING_RECONCILIATION_JSON=JSON.stringify({...h.manifest,...patch});assert.throws(()=>reconciliationManifest(h.env,h.state.now));}
});
