import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {migrationStatements} from './sql-fixtures.mjs';

test('migration splitter preserves trigger statements, CASE endings and quoted semicolons',()=>{
  const sql=`-- A comment containing ; END;
    CREATE TABLE inputs(value TEXT);
    CREATE TABLE audit(value TEXT);
    /* A second comment; */ CREATE TRIGGER record_input AFTER INSERT ON inputs BEGIN
      INSERT INTO audit VALUES(CASE WHEN NEW.value='go' THEN 'first; -- literal' ELSE 'unused' END);
      INSERT INTO audit VALUES('second; it''s literal');
    END;
    -- trailing comment;
  `;
  const statements=migrationStatements(sql);assert.equal(statements.length,3);
  const db=new DatabaseSync(':memory:');
  try {
    for(const statement of statements)db.exec(statement);
    db.prepare('INSERT INTO inputs VALUES(?)').run('go');
    assert.deepEqual(db.prepare('SELECT value FROM audit').all().map(row=>row.value),['first; -- literal',"second; it's literal"]);
    assert.throws(()=>migrationStatements('CREATE TABLE unfinished(value TEXT)'),/Incomplete/);
  } finally {db.close();}
});
