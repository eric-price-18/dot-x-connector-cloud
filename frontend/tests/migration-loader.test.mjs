import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {migrationStatements} from './fixtures/migration-statements.mjs';
test('migration loader preserves trigger bodies, comments, quoted semicolons and CASE END',()=>{
 const parser=new DatabaseSync(':memory:'),target=new DatabaseSync(':memory:');
 try {
  const source=`-- comment ;\nCREATE TABLE t(id INTEGER,value TEXT); CREATE TABLE counts(n INTEGER); INSERT INTO counts VALUES(0);
  CREATE TRIGGER change AFTER INSERT ON t BEGIN UPDATE counts SET n=n+1; INSERT INTO t VALUES(NEW.id+1,CASE WHEN NEW.value='a;b' THEN 'c;d' ELSE 'none' END); END;
  /* ignored ; */ INSERT INTO t VALUES(1,'a;b');`;
  const statements=[...migrationStatements(parser,source)];assert.equal(statements.length,5);for(const sql of statements)target.exec(sql);
  assert.deepEqual(target.prepare('SELECT * FROM t').all(),parser.prepare('SELECT * FROM t').all());assert.equal(target.prepare('SELECT n FROM counts').get().n,1);
 } finally {parser.close();target.close();}
});
