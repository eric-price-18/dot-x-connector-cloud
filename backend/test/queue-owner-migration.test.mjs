import test from 'node:test';
import assert from 'node:assert/strict';
import {ownerHarness} from './owner-fixtures.mjs';
const path='/owner/maintenance/reply-queue-migrate';
async function setup(t){
 const h=await ownerHarness(t,{ONGOING_MAINTENANCE_ENABLED:'true'});
 for(const row of h.db.all("SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'reply_queue_*'"))h.db.sqlite.exec('DROP TABLE '+row.name);
 const prepare=h.db.prepare.bind(h.db);
 h.db.prepare=sql=>{let args=[];const statement=prepare(sql),bind=statement.bind;
  statement.bind=(...v)=>{args=v;bind.call(statement,...v);return statement;};
  statement.all=async()=>({results:h.db.all(sql,...args)});return statement;};
 await h.seed();return h;
}
test('fixed queue migration route requires existing owner, origin and exact CSRF form; no caller SQL',async t=>{
 const h=await setup(t),session=await h.login();
 assert.match(session.html,/Apply reviewed queue migration/);
 for(const headers of [{cookie:''},{origin:'https://untrusted.invalid'}])assert.equal((await h.form(path,session,{},headers)).status,headers.cookie===''?401:403);
 assert.equal((await h.form(path,session,{csrf:'wrong'})).status,403);
 assert.equal((await h.form(path,session,{sql:'DROP TABLE accounts'})).status,403);
 assert.equal(h.db.all("SELECT name FROM sqlite_master WHERE name GLOB 'reply_queue_*'").length,0);
 const result=await h.form(path,session);assert.equal(result.status,200,await result.clone().text());assert.deepEqual(await result.json(),{migration:'0008+0009+0010+0011',complete:true});
 assert.equal(h.db.all("SELECT operation FROM ongoing_maintenance WHERE operation GLOB 'schema-*'").length,4);
 assert.equal((await h.form(path,session)).status,410);
 assert.equal(h.state.xCalls.length,0);
});
test('queue migration route refuses account mismatch and enabled service without mutation',async t=>{
 const h=await setup(t),session=await h.login();h.env.SERVICE_QUEUE_ENABLED='true';
 assert.equal((await h.form(path,session)).status,409);h.env.SERVICE_QUEUE_ENABLED='false';
 h.db.sqlite.exec("UPDATE accounts SET x_user_id='5050'");assert.equal((await h.form(path,session)).status,403);
 assert.equal(h.db.all("SELECT name FROM sqlite_master WHERE name GLOB 'reply_queue_*'").length,0);assert.equal(h.state.xCalls.length,0);
});
