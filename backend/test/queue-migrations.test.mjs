import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync,readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { migrationStatements } from '../test/migration-statements.mjs';
import { Store } from '../src/storage.mjs';
import { migrateReplyQueue,queueMigrationStatus,QUEUE_MIGRATIONS,QUEUE_SCHEMA_HASHES } from '../src/queue-migrations.mjs';

const source=name=>readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8');
const fingerprint=db=>createHash('sha256').update(JSON.stringify(db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master
 WHERE sql IS NOT NULL AND (name GLOB 'reply_queue_*' OR tbl_name GLOB 'reply_queue_*') ORDER BY type,name`).all()
 .map(row=>[row.type,row.name,row.tbl_name,row.sql.replace(/\s+/g,' ').trim()]))).digest('hex');
function fixture(t,prefix=0) {
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 for(const name of readdirSync(new URL('../migrations/',import.meta.url)).sort())if(name<'0008')db.exec(source(name));
 for(const item of QUEUE_MIGRATIONS.slice(0,prefix)) {
  db.exec(source(item.name));db.prepare('INSERT INTO ongoing_maintenance VALUES(?,?,1)').run('schema-'+item.number,item.sha256);
 }
 db.exec("INSERT INTO accounts(id,issuer,subject,x_user_id,encrypted_tokens,expires_at,updated_at) VALUES('primary','issuer','owner','4242','retained-encrypted-fixture',10000,1)");
 db.exec("INSERT INTO x_credit_budgets VALUES('retained-budget','4242',5000000,100000,250000,10000,1)");
 db.exec("INSERT INTO service_writes VALUES('retained-intent','service','issuer','owner','4242','x_create_original_post','hash','unknown','uncertain',NULL,1,2)");
 let statements=0,failAt=null,loseAck=false;
 const wrapper={prepare(sql){return {bind(...args){return {
  first:async()=>{statements++;return db.prepare(sql).get(...args)??null;},
  all:async()=>{statements++;return {results:db.prepare(sql).all(...args)};},
  run:async()=>{statements++;const result=db.prepare(sql).run(...args);return {meta:{changes:Number(result.changes)}};}
 };}};},async batch(items){
  db.exec('BEGIN');try {let index=0;for(const item of items){if(index++===failAt)throw Error('injected batch fault');await item.run();}db.exec('COMMIT');}
  catch(error){db.exec('ROLLBACK');throw error;}
  if(loseAck)throw Error('injected acknowledgement loss');
 }};
 return {db,store:new Store(wrapper,()=>1000),env:{ONGOING_MAINTENANCE_ENABLED:'true'},
  get statements(){return statements;},fault:n=>{failAt=n;},loseAck:()=>{loseAck=true;}};
}
const rows=(db,table)=>db.prepare(`SELECT * FROM ${table}`).all().map(row=>({...row}));
const retained=db=>Object.fromEntries(['accounts','x_credit_budgets','service_writes','ongoing_spend','ongoing_cycles']
 .map(table=>[table,rows(db,table)]));
const safeError=(code,status)=>error=>error.code===code&&error.status===status;

test('compiled queue migrations match exact reviewed files, SQL semantics and every schema prefix',()=>{
 const compiled=new DatabaseSync(':memory:'),files=new DatabaseSync(':memory:');
 try {
  assert.equal(fingerprint(compiled),QUEUE_SCHEMA_HASHES[0]);
  for(const [index,item] of QUEUE_MIGRATIONS.entries()) {
   assert.equal(item.number,String(index+8).padStart(4,'0'));
   assert.equal(createHash('sha256').update(source(item.name)).digest('hex'),item.sha256);
   assert.deepEqual(item.statements,[...migrationStatements(files,source(item.name))]);
   for(const sql of item.statements)compiled.exec(sql);
   assert.equal(fingerprint(compiled),fingerprint(files));assert.equal(fingerprint(files),QUEUE_SCHEMA_HASHES[index+1]);
  }
  assert.equal(compiled.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
 } finally {compiled.close();files.close();}
});

test('pristine queue initialization is atomic, bounded, hash-journaled and replay never rewrites state',async t=>{
 const f=fixture(t),before=retained(f.db);
 assert.deepEqual(await migrateReplyQueue(f.store,f.env),{migration:'0008+0009+0010+0011',complete:true});
 assert.equal(f.statements,34);assert(f.statements+2<=50); // Owner session + bound account reads.
 assert.deepEqual(retained(f.db),before);
 assert.deepEqual(rows(f.db,'ongoing_maintenance').filter(row=>row.operation>'schema-0007').map(row=>[row.operation,row.evidence_id]),
  QUEUE_MIGRATIONS.map(item=>['schema-'+item.number,item.sha256]));
 const journal=rows(f.db,'ongoing_maintenance');
 await assert.rejects(migrateReplyQueue(f.store,f.env),safeError('REPLY_QUEUE_MIGRATION_ALREADY_COMPLETE',410));
 assert.deepEqual(rows(f.db,'ongoing_maintenance'),journal);assert.deepEqual(retained(f.db),before);
});

test('recognized queue prefixes upgrade while retaining frozen/unknown intents, receipts and service replay records',async t=>{
 for(const prefix of [1,2,3]) {
  const f=fixture(t,prefix);f.db.exec("INSERT INTO reply_queue_accounts(account_id,next_send_at) VALUES('4242',2000)");
  f.db.exec("INSERT INTO reply_queue_items(account_id,target_id,author_id,root_id,state,intent_key,draft,context_ref,created_at,updated_at,revision) VALUES('4242','100','5050','90','unknown','old-intent','old approved text','old-context',100,200,3)");
  f.db.exec("INSERT INTO reply_queue_intents(intent_key,account_id,target_id,author_id,draft,context_ref,dispatch_at,cost_micro_usd,state,receipt_ref,receipt_json,owner_request_ref) VALUES('old-intent','4242','100','5050','frozen text','frozen-context',200,200000,'unknown','old-receipt','{\"status\":\"unknown\"}','old-owner-request')");
  f.db.exec("INSERT INTO reply_queue_publisher_attempts(intent_key,account_id,phase,service_intent_owned,receipt_json,created_at) VALUES('old-intent','4242','may_dispatch',1,'old-proof',200)");
  if(prefix>=2) {
   f.db.exec("INSERT INTO reply_queue_service_bindings VALUES('4242','service','issuer','owner',1)");
   f.db.exec("INSERT INTO reply_queue_service_requests VALUES('old-request','4242','service','issuer','owner','approve','body-hash','completed','old-response',1,2)");
  }
  const tables=['reply_queue_accounts','reply_queue_items','reply_queue_intents','reply_queue_publisher_attempts',
   ...(prefix>=2?['reply_queue_service_bindings','reply_queue_service_requests']:[])];
  const before=Object.fromEntries(tables.map(table=>[table,rows(f.db,table)]));
  await migrateReplyQueue(f.store,f.env);
  for(const table of tables)for(const [index,row] of before[table].entries())
   assert.deepEqual(Object.fromEntries(Object.keys(row).map(key=>[key,rows(f.db,table)[index][key]])),row,table);
  const item=rows(f.db,'reply_queue_items')[0],intent=rows(f.db,'reply_queue_intents')[0];
  if(prefix<3){assert.equal(item.source_created_at,100);assert.equal(item.expires_at,86500);assert.equal(item.source_created_at_known,0);}
  for(const key of ['review_revision','review_claim_token','reviewed_at','expires_at'])assert.equal(intent[key],null);
 }
});

test('unrecognized schema/journal states refuse before any migration writes',async t=>{
 for(const mutate of [
  f=>f.db.exec(source(QUEUE_MIGRATIONS[0].name)), // No adoption of external/untracked schema.
  f=>f.db.prepare('INSERT INTO ongoing_maintenance VALUES(?,?,1)').run('schema-0009',QUEUE_MIGRATIONS[1].sha256),
  f=>f.db.prepare('INSERT INTO ongoing_maintenance VALUES(?,?,1)').run('schema-0008','0'.repeat(64)),
  f=>f.db.prepare('INSERT INTO ongoing_maintenance VALUES(?,?,1)').run('schema-0008',''),
  f=>f.db.exec("CREATE TABLE reply_queue_unknown(value TEXT)"),
 ]) {
  const f=fixture(t);mutate(f);const before=rows(f.db,'ongoing_maintenance'),schema=fingerprint(f.db);
  await assert.rejects(migrateReplyQueue(f.store,f.env),safeError('REPLY_QUEUE_SCHEMA_MISMATCH',409));
  assert.equal(fingerprint(f.db),schema);assert.deepEqual(rows(f.db,'ongoing_maintenance'),before);
 }
 for(const sql of ['DROP INDEX reply_queue_due','ALTER TABLE reply_queue_items ADD COLUMN unknown_column TEXT',
  'CREATE TRIGGER unknown_queue_trigger AFTER INSERT ON reply_queue_items BEGIN SELECT 1; END']) {
  const f=fixture(t,3);f.db.exec(sql);
  await assert.rejects(migrateReplyQueue(f.store,f.env),safeError('REPLY_QUEUE_SCHEMA_MISMATCH',409));
 }
});

test('prerequisites and every activity gate are enforced without altering baseline',async t=>{
 for(const key of ['LIVE_X_ENABLED','READ_POLLING_ENABLED','POST_ENABLED','REPLY_ENABLED','X_ONGOING_OPERATIONS_ENABLED',
  'SERVICE_QUEUE_ENABLED','X_ORIGINAL_POSTS_ENABLED','X_REPOSTS_ENABLED','X_OWN_THREAD_REPLIES_ENABLED']) {
  const f=fixture(t);await assert.rejects(migrateReplyQueue(f.store,{...f.env,[key]:'true'}),safeError('MAINTENANCE_REQUIRES_ACTIVITY_SHUTDOWN',409));assert.equal(f.statements,0);
 }
 const f=fixture(t);await assert.rejects(migrateReplyQueue(f.store,{}),safeError('ONGOING_MAINTENANCE_DISABLED',403));
 f.db.exec("DROP INDEX ongoing_spend_periods");
 await assert.rejects(migrateReplyQueue(f.store,f.env),safeError('ONGOING_SCHEMA_MIGRATION_REQUIRED',409));
 assert.equal(fingerprint(f.db),QUEUE_SCHEMA_HASHES[0]);
});

test('transaction faults roll back all fixed schema and journal writes; a lost acknowledgement cannot reapply',async t=>{
 for(const failAt of [0,10,29]) {
  const f=fixture(t),before=retained(f.db);f.fault(failAt);
  await assert.rejects(migrateReplyQueue(f.store,f.env),/injected batch fault/);
  assert.deepEqual(await queueMigrationStatus(f.store),{prefix:0,complete:false});assert.deepEqual(retained(f.db),before);
  f.fault(null);assert.equal((await migrateReplyQueue(f.store,f.env)).complete,true);
 }
 const f=fixture(t);f.loseAck();
 await assert.rejects(migrateReplyQueue(f.store,f.env),safeError('REPLY_QUEUE_MIGRATION_ALREADY_COMPLETE',410));
 assert.deepEqual(await queueMigrationStatus(f.store),{prefix:4,complete:true});
 await assert.rejects(migrateReplyQueue(f.store,f.env),safeError('REPLY_QUEUE_MIGRATION_ALREADY_COMPLETE',410));
});
