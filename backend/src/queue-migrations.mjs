import { assert, enabled } from './security.mjs';
import { maintenanceGate, RECONCILIATION_SCHEMA } from './maintenance.mjs';
import { QUEUE_MIGRATIONS, QUEUE_SCHEMA_HASHES } from './queue-migration-data.mjs';

export { QUEUE_MIGRATIONS, QUEUE_SCHEMA_HASHES };
const migration='0008+0009+0010+0011';

export function queueMaintenanceGate(env) {
  maintenanceGate(env);
  for(const key of ['SERVICE_QUEUE_ENABLED','X_ORIGINAL_POSTS_ENABLED','X_REPOSTS_ENABLED','X_OWN_THREAD_REPLIES_ENABLED'])
    assert(!enabled(env[key]),'MAINTENANCE_REQUIRES_ACTIVITY_SHUTDOWN',409);
}

// Compare the complete fixed queue namespace, including indexes and triggers.
// ALTER TABLE rewrites table definitions, so every recognized prefix has its
// own fingerprint. Neither caller data nor a database marker selects SQL.
export async function queueMigrationStatus(store) {
  const journal=await store.first("SELECT name FROM sqlite_master WHERE type='table' AND name='ongoing_maintenance'");
  assert(journal,'ONGOING_SCHEMA_MIGRATION_REQUIRED',409);
  // Journal and schema must come from one SQLite read snapshot: a concurrent
  // successful migration cannot otherwise be mistaken for schema tampering.
  const snapshot=(await store.statement(`SELECT 'journal' AS kind,operation AS name,evidence_id AS detail,NULL AS type,NULL AS tbl_name
    FROM ongoing_maintenance WHERE operation IN ('schema-0008','schema-0009','schema-0010','schema-0011')
    UNION ALL SELECT 'schema',name,sql,type,tbl_name FROM sqlite_master
    WHERE sql IS NOT NULL AND (name GLOB 'reply_queue_*' OR tbl_name GLOB 'reply_queue_*' OR name GLOB 'ongoing_*')
    ORDER BY kind,type,name`).all()).results;
  const markers=new Map(snapshot.filter(row=>row.kind==='journal').map(row=>[row.name,row.detail]));
  // Public schema 0006 is applied through the supported D1 migration pipeline.
  // Validate its actual fixed definitions; private deployment markers have no authority.
  const normalize=value=>value.slice(value.indexOf('CREATE ')).replace(/\s+/g,' ').trim();
  for(const sql of RECONCILIATION_SCHEMA) {
    const name=/CREATE (?:TABLE|INDEX) (\w+)/.exec(sql)[1];
    const row=snapshot.find(row=>row.kind==='schema'&&row.name===name);
    assert(row&&normalize(row.detail)===normalize(sql),'ONGOING_SCHEMA_MIGRATION_REQUIRED',409);
  }
  let prefix=0,missing=false;
  for(const item of QUEUE_MIGRATIONS) {
    const operation=`schema-${item.number}`,marker=markers.get(operation);
    if(!markers.has(operation)){missing=true;continue;}
    assert(!missing&&marker===item.sha256,'REPLY_QUEUE_SCHEMA_MISMATCH',409);
    prefix++;
  }
  const canonical=JSON.stringify(snapshot.filter(row=>row.kind==='schema'&&(row.name.startsWith('reply_queue_')||row.tbl_name.startsWith('reply_queue_')))
    .map(row=>[row.type,row.name,row.tbl_name,row.detail.replace(/\s+/g,' ').trim()]));
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical))),
    byte=>byte.toString(16).padStart(2,'0')).join('');
  assert(hash===QUEUE_SCHEMA_HASHES[prefix],'REPLY_QUEUE_SCHEMA_MISMATCH',409);
  return {prefix,complete:prefix===QUEUE_MIGRATIONS.length};
}

export async function migrateReplyQueue(store,env) {
  queueMaintenanceGate(env);
  const before=await queueMigrationStatus(store);
  assert(!before.complete,'REPLY_QUEUE_MIGRATION_ALREADY_COMPLETE',410);
  const statements=[];
  for(const item of QUEUE_MIGRATIONS.slice(before.prefix)) {
    statements.push(...item.statements.map(sql=>store.statement(sql)));
    statements.push(store.statement('INSERT INTO ongoing_maintenance(operation,evidence_id,completed_at) VALUES(?,?,?)',
      `schema-${item.number}`,item.sha256,store.clock()));
  }
  // D1 batch commits the entire fixed suffix and its hash journal atomically.
  // No IF NOT EXISTS adoption, rewrites, resets, refunds or destructive rollback.
  try {await store.db.batch(statements);}
  catch(error) {
    // A concurrent winning migration or lost acknowledgement is a replay, never
    // permission to reset the journal or retry individual ALTER statements.
    let completed=false;try{completed=(await queueMigrationStatus(store)).complete;}catch{}
    assert(!completed,'REPLY_QUEUE_MIGRATION_ALREADY_COMPLETE',410);
    throw error;
  }
  assert((await queueMigrationStatus(store)).complete,'REPLY_QUEUE_SCHEMA_MISMATCH',409);
  return {migration,complete:true};
}
