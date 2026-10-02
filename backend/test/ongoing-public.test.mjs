import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync,readdirSync } from 'node:fs';
import { Store } from '../src/storage.mjs';
import { claimOperation,reserveOngoing,periods } from '../src/ongoing.mjs';
import { ownerDiagnostics } from '../src/ongoing-diagnostics.mjs';
import { OwnerLogin } from '../src/owner.mjs';
function fixture(reconciled=true) {
 const db=new DatabaseSync(':memory:');
 for(const n of readdirSync(new URL('../migrations/',import.meta.url)).sort())db.exec(readFileSync(new URL('../migrations/'+n,import.meta.url),'utf8'));
 const wrapper={prepare(sql){return {bind(...a){return {first:async()=>db.prepare(sql).get(...a)??null,run:async()=>{const q=db.prepare(sql);if(/RETURNING|^SELECT/i.test(sql))return {success:true,results:q.all(...a),meta:{changes:0}};return {success:true,meta:{changes:Number(q.run(...a).changes)}}}}}}},async batch(q){db.exec('BEGIN');try{const out=[];for(const s of q)out.push(await s.run());db.exec('COMMIT');return out;}catch(e){db.exec('ROLLBACK');throw e;}}};
 let now=Date.parse('2035-01-02T12:00:00Z')/1000;
 const store=new Store(wrapper,()=>now),env={X_ONGOING_OPERATIONS_ENABLED:'true',MAX_REPLIES_DAY:'10',X_EXPECTED_USER_ID:'42',MCP_ISSUER:'https://identity.example.invalid',MCP_ALLOWED_SUBJECT:'synthetic-owner'};
 if(reconciled){db.prepare('INSERT INTO ongoing_credit_state VALUES(?,?,?,?)').run('42',4000000,0,'synthetic-evidence');db.prepare('INSERT INTO ongoing_cycles VALUES(?,?,?,?,?,?,?)').run('42',now-86400,now+86400*20,0,0,'synthetic-evidence','2035-01');db.prepare("INSERT INTO ongoing_legacy_carry VALUES('42',0,0,0,0,0,0,'2035-01-02','2035-01',1,?)").run(now);}
 return {db,store,env,clock:()=>now,advance:s=>now+=s};
}
test('public ongoing template requires reconciliation and obeys exact daily cap',async()=>{
 const missing=fixture(false);await assert.rejects(reserveOngoing(missing.store,missing.env,1));
 const f=fixture();await reserveOngoing(f.store,f.env,1000000);await assert.rejects(reserveOngoing(f.store,f.env,1));
 f.advance(86400);await reserveOngoing(f.store,f.env,1);
});
test('public calendar is UTC and local month cap is independent of prepaid balance',async()=>{
 assert.equal(periods(Date.parse('2035-01-03T00:00Z')/1000).day,'2035-01-03');
 const f=fixture();f.db.exec('UPDATE ongoing_credit_state SET prepaid_micro_usd=10000000');
 f.db.exec("INSERT INTO ongoing_spend(account_id,day,month,amount,kind,created_at) VALUES('42','2035-01-01','2035-01',5000000,'api',0)");
 await assert.rejects(reserveOngoing(f.store,f.env,1));
});
test('ten reply ceiling is atomic; zero and stricter limits are honored',async()=>{
 for(const cap of ['0','1','5','10','11']){const f=fixture();f.env.MAX_REPLIES_DAY=cap;for(let i=0;i<Math.min(+cap,10);i++){await claimOperation(f.store,f.env,'reply','key'+i);f.advance(900);}await assert.rejects(claimOperation(f.store,f.env,'reply','extra'));}
 const f=fixture();for(let i=0;i<9;i++){await claimOperation(f.store,f.env,'reply','key'+i);f.advance(900);}
 const results=await Promise.allSettled(['a','b'].map(k=>claimOperation(f.store,f.env,'reply',k)));assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
});
test('15-minute spacing crosses day boundary; no historical exemption table',async()=>{
 const f=fixture();await claimOperation(f.store,f.env,'reply','one');f.advance(899);await assert.rejects(claimOperation(f.store,f.env,'reply','two'));f.advance(1);await claimOperation(f.store,f.env,'reply','two');
 assert.equal(f.db.prepare("SELECT name FROM sqlite_master WHERE name='historical_requested_originals'").get(),undefined);
});
test('unknown earlier-cycle attempts retain budget and legacy changes block',async()=>{
 const f=fixture();f.db.exec("INSERT INTO ongoing_spend(account_id,day,month,amount,unresolved_micro_usd,kind,created_at) VALUES('42','2034-12-01','2034-12',5000000,5000000,'api',1)");await assert.rejects(reserveOngoing(f.store,f.env,1));
 const g=fixture();g.db.prepare('INSERT INTO x_credit_budgets VALUES(?,?,?,?,?,?,?)').run('synthetic-old','42',100,0,1,1,0);await assert.rejects(reserveOngoing(g.store,g.env,1));
});
test('full worst-case $0.22 envelope must fit before requests; retained attempts do not refund',async()=>{
 const f=fixture();await reserveOngoing(f.store,f.env,780001);await assert.rejects(reserveOngoing(f.store,f.env,220000));
 const g=fixture();await reserveOngoing(g.store,g.env,220000);assert.equal(g.db.prepare('SELECT amount,unresolved_micro_usd FROM ongoing_spend').get().unresolved_micro_usd,220000);
});
test('owner diagnostics reject foreign binding and reveal only bounded local totals',async()=>{
 const f=fixture();f.store.account=async()=>({issuer:f.env.MCP_ISSUER,subject:f.env.MCP_ALLOWED_SUBJECT,x_user_id:'42'});
 const v=await ownerDiagnostics(f.env,f.store,f.clock);assert.equal(v.reconciled,true);assert.equal(v.reply_preflight_micro_usd,220000);assert(!JSON.stringify(v).includes('synthetic-owner'));assert(!('account_id' in v));
 f.store.account=async()=>({issuer:f.env.MCP_ISSUER,subject:'other',x_user_id:'42'});await assert.rejects(ownerDiagnostics(f.env,f.store,f.clock));
});
test('monitor handler authenticates before any diagnostic query',async()=>{
 let touched=false;const owner={session:async()=>{throw Error('unauthorized')},store:{account:async()=>{touched=true}},env:{},clock:()=>0};
 await assert.rejects(OwnerLogin.prototype.monitor.call(owner,new Request('https://backend.example.invalid/owner/monitor-status')));assert.equal(touched,false);
});

test('ongoing write ceiling permits eleven and preserves stricter configured caps',async()=>{
 for(const cap of ['0','2','11']){
  const f=fixture(),env={...f.env,MAX_WRITES_DAY:cap,MAX_X_REQUESTS_DAY:'100',MAX_X_REQUESTS_HOUR:'20'};
  for(let i=0;i<Number(cap);i++)await f.store.reserveX(env,0,true,1);
  await assert.rejects(f.store.reserveX(env,0,true,1),e=>e.code==='LOCAL_WRITES_DAY_EXHAUSTED');
 }
});
