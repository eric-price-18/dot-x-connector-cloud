import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './helpers.mjs';
import { writeFixture } from '../test/write-fixtures.mjs';
import { ReplyQueueStore } from '../src/reply-queue-store.mjs';
import { periods } from '../src/ongoing.mjs';
import { RUNTIME_NOW } from './clock-fixture.mjs';

async function setup(t,overrides={}) {
  const fixture=await writeFixture(RUNTIME_NOW);
  const h=await runtime(t,{...fixture.env,X_ONGOING_OPERATIONS_ENABLED:'true',
    MAX_X_REQUESTS_DAY:'100',MAX_X_REQUESTS_HOUR:'20',MAX_WRITES_DAY:'11',...overrides});
  const make=(prepaid={remaining:35000,consumed:0,resolved:0},db=h.db)=>{
    const store=new ReplyQueueStore(db,h.clock);store.prepaidCredit=prepaid;return store;
  };
  const buckets=()=>h.db.prepare('SELECT bucket,used FROM budgets ORDER BY bucket').all().then(result=>result.results);
  const day=periods(h.clock()).day,hour=Math.floor(h.clock()/3600);
  t.after(()=>assert.equal(h.xCalls().length,0));
  return {h,make,buckets,day,hour};
}

test('queue prepaid refresh, identity and write account for all three requests and the classified write',async t=>{
  const f=await setup(t),store=f.make();
  for(const [write,amount] of [[false,10000],[false,10000],[true,15000]]) {
    await store.reserveX(f.h.bindings,0,write,amount);
    store.markCreditDispatched();await store.resolveCredit();
  }
  assert.deepEqual(store.prepaidCredit,{remaining:0,consumed:35000,resolved:35000});
  assert.deepEqual(await f.buckets(),[
    {bucket:`requests:day:${f.day}`,used:3},{bucket:`requests:hour:${f.hour}`,used:3},{bucket:`writes:day:${f.day}`,used:1}
  ]);
});

test('a denied last quota bucket rolls back preceding inserts and updates atomically',async t=>{
  for(const existing of [false,true])await t.test(existing?'existing buckets':'new buckets',async t=>{
    const f=await setup(t),store=f.make();
    if(existing)await store.reserveX(f.h.bindings,0,false,10000);
    await f.h.db.prepare('INSERT INTO budgets VALUES(?,?,?)').bind(`writes:day:${f.day}`,11,f.h.clock()+86400).run();
    const before=await f.buckets(),credit={...store.prepaidCredit};
    await assert.rejects(store.reserveX(f.h.bindings,0,true,15000),error=>error.code==='LOCAL_WRITES_DAY_EXHAUSTED');
    assert.deepEqual(await f.buckets(),before);assert.deepEqual(store.prepaidCredit,credit);
  });
});

test('active cooldown and zero quota leave all buckets and prepaid dollars unchanged',async t=>{
  for(const cooldown of [false,true])await t.test(cooldown?'cooldown':'zero quota',async t=>{
    const f=await setup(t,cooldown?{}:{MAX_WRITES_DAY:'0'}),store=f.make();
    if(cooldown)await f.h.db.prepare("INSERT INTO cooldowns VALUES('x',?)").bind(f.h.clock()+900).run();
    await assert.rejects(store.reserveX(f.h.bindings,0,true,15000),error=>error.code===(cooldown?'X_RATE_LIMIT_COOLDOWN':'LOCAL_WRITES_DAY_EXHAUSTED'));
    assert.deepEqual(await f.buckets(),[]);assert.deepEqual(store.prepaidCredit,{remaining:35000,consumed:0,resolved:0});
  });
});

test('concurrent queue reservations share the last write slot without partially charging rejected requests',async t=>{
  const f=await setup(t,{MAX_WRITES_DAY:'1'}),stores=Array.from({length:4},()=>f.make());
  const outcomes=await Promise.allSettled(stores.map(store=>store.reserveX(f.h.bindings,0,true,15000)));
  assert.equal(outcomes.filter(result=>result.status==='fulfilled').length,1);
  assert.deepEqual(await f.buckets(),[
    {bucket:`requests:day:${f.day}`,used:1},{bucket:`requests:hour:${f.hour}`,used:1},{bucket:`writes:day:${f.day}`,used:1}
  ]);
  assert.equal(stores.reduce((sum,store)=>sum+store.prepaidCredit.consumed,0),15000);
});

test('concurrent stages cannot spend the same prepaid room twice',async t=>{
  const f=await setup(t),prepaid={remaining:10000,consumed:0,resolved:0};
  const outcomes=await Promise.allSettled(Array.from({length:4},()=>f.make(prepaid).reserveX(f.h.bindings,0,false,10000)));
  assert.equal(outcomes.filter(result=>result.status==='fulfilled').length,1);
  assert.deepEqual(prepaid,{remaining:0,consumed:10000,resolved:0});
  assert.deepEqual(await f.buckets(),[{bucket:`requests:day:${f.day}`,used:1},{bucket:`requests:hour:${f.hour}`,used:1}]);
});

test('lost acknowledgement rejects dispatch while keeping committed quotas pessimistic',async t=>{
  const f=await setup(t),wrap=statement=>({
    bind:(...values)=>wrap(statement.bind(...values)),first:(...args)=>statement.first(...args),
    all:async(...args)=>{await statement.all(...args);throw Error('synthetic lost acknowledgement');}
  });
  const db={prepare:sql=>wrap(f.h.db.prepare(sql)),batch:values=>f.h.db.batch(values)},store=f.make(undefined,db);
  await assert.rejects(store.reserveX(f.h.bindings,0,true,15000),error=>error.code==='LOCAL_REQUEST_RESERVATION_REJECTED');
  assert.equal(store.creditAttempt,undefined);await store.releaseUnattemptedCredit();
  assert.deepEqual(await f.buckets(),[
    {bucket:`requests:day:${f.day}`,used:1},{bucket:`requests:hour:${f.hour}`,used:1},{bucket:`writes:day:${f.day}`,used:1}
  ]);
  assert.deepEqual(store.prepaidCredit,{remaining:35000,consumed:0,resolved:0});
});

test('without a prepaid envelope the original atomic reconciliation requirement still applies',async t=>{
  const f=await setup(t),store=new ReplyQueueStore(f.h.db,f.h.clock);
  await assert.rejects(store.reserveX(f.h.bindings,0,true,15000),error=>error.code==='LOCAL_REQUEST_RESERVATION_REJECTED');
  assert.deepEqual(await f.buckets(),[]);assert.equal(store.creditAttempt,undefined);
});
