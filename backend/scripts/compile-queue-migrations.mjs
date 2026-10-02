// Offline only: compile the four fixed SQL files with SQLite's parser.
// This script never opens D1, reads credentials, deploys, or accesses a network.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync,writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { migrationStatements } from '../test/migration-statements.mjs';

assert(process.argv.length<=3&&[undefined,'--check','--write'].includes(process.argv[2]),
  'Usage: node scripts/compile-queue-migrations.mjs [--check|--write]');
const db=new DatabaseSync(':memory:'),migrations=[];
const schema=()=>createHash('sha256').update(JSON.stringify(db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master
 WHERE sql IS NOT NULL AND (name GLOB 'reply_queue_*' OR tbl_name GLOB 'reply_queue_*') ORDER BY type,name`).all()
 .map(row=>[row.type,row.name,row.tbl_name,row.sql.replace(/\s+/g,' ').trim()]))).digest('hex');
const hashes=[schema()];
try {
 for(const name of ['0008_reply_queue.sql','0009_reply_queue_service.sql','0010_reply_queue_expiry.sql','0011_reply_queue_review.sql']) {
  const sql=readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8');
  migrations.push({number:name.slice(0,4),name,sha256:createHash('sha256').update(sql).digest('hex'),statements:[...migrationStatements(db,sql)]});
  hashes.push(schema());
 }
} finally {db.close();}
const output='// Compiled fixed migration statements. Offline tests pin every statement, file hash,\n'
 +'// and schema-prefix fingerprint to the reviewed migration files.\n'
 +'export const QUEUE_MIGRATIONS='+JSON.stringify(migrations,null,2)+';\n'
 +'export const QUEUE_SCHEMA_HASHES='+JSON.stringify(hashes,null,2)+';\n';
const target=new URL('../src/queue-migration-data.mjs',import.meta.url);
if(process.argv[2]==='--write')writeFileSync(target,output);
else assert.equal(readFileSync(target,'utf8'),output,'Compiled queue migration data differs from reviewed SQL; review changes before regenerating with --write');
console.log(process.argv[2]==='--write'?'Wrote fixed offline queue migration data.':'PASS: exact fixed SQL statements, file hashes and schema fingerprints match.');
