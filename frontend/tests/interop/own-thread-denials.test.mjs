import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createWriteAdapter} from '../../lib/write-service-adapter.mjs';
import {initializeFromOwnerClick} from '../../lib/service-key.mjs';
const backend=fileURLToPath(new URL('../../../backend/',import.meta.url));
const {harness,response}=await import(pathToFileURL(path.join(backend,'test/helpers.mjs')).href);
const now=Date.parse('2000-01-02T02:00:00Z')/1000;
const owner=new Headers({'oai-authenticated-user-id':'reply-denial-owner','oai-authenticated-user-email':'owner@example.invalid'});
function memoryDb(){let row=null;return {get row(){return row},prepare(){let v;return {bind(...a){v=a;return this},async run(){const [owner_id,public_jwk,private_jwk,fingerprint,created_at]=v;row={owner_id,public_jwk,private_jwk,fingerprint,created_at}},async first(){return row}}}}}
async function fixture(t) {
 t.mock.timers.enable({apis:['Date'],now:now*1000});const frontendDb=memoryDb();await initializeFromOwnerClick(frontendDb,{id:'reply-denial-owner'});
 const env={PUBLIC_BASE_URL:'https://backend.example.invalid',X_CALLBACK_URL:'https://backend.example.invalid/x/callback',SERVICE_ENABLED:'true',SERVICE_WRITE_ENABLED:'true',SERVICE_PUBLIC_JWK:frontendDb.row.public_jwk,SERVICE_X_ACCOUNT_ID:'4242',LIVE_X_ENABLED:'true',REPLY_ENABLED:'true',X_OWN_THREAD_REPLIES_ENABLED:'true',X_WRITE_STATUS_ENABLED:'true',X_CREDIT_BUDGET_ID:'example-disabled-budget',X_CREDIT_CAP_MICROUSD:'5000000',X_CREDIT_INITIAL_MICROUSD:'0',X_CREDIT_EXPIRES_AT:String(Date.parse('2000-01-02T08:00:00Z')/1000)};
 const h=harness(t,env);h.state.now=now;await h.seed({scopes:['tweet.read','users.read','offline.access','tweet.write']});
 const args={text:'A useful café thought: “yes” 😀',in_reply_to_post_id:'20001',in_reply_to_author_id:'5050',idempotency_key:crypto.randomUUID()};
 const make=fetchImpl=>createWriteAdapter({db:frontendDb,env:{X_OWN_THREAD_REPLIES_ENABLED:'true',X_WRITE_STATUS_ENABLED:'true'},fetchImpl:fetchImpl??(async(url,init)=>h.worker.fetch(new Request(url,init),h.env))});
 return {h,args,make,adapter:make()};
}
test('actual adapter signs all four browser assertions and backend performs exactly one unchanged publish',async t=>{
 const {h,args,adapter}=await fixture(t);const r=await adapter.call(owner,'x_reply',args);assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.value.state,'succeeded');assert.equal(h.state.xCalls.length,1);
 assert.deepEqual(JSON.parse(h.state.xCalls[0].options.body),{text:args.text,reply:{in_reply_to_tweet_id:args.in_reply_to_post_id}});assert.equal(h.db.all('SELECT root_id FROM reply_interactions')[0].root_id,null);
 assert.equal((await adapter.call(owner,'x_reply',args)).value.post_id,r.value.post_id);assert.equal(h.state.xCalls.length,1);
});
test('actual adapter rejects missing author and server rejects self and stored opt-outs without provider calls',async t=>{
 const {h,args,adapter}=await fixture(t);const missing={...args};delete missing.in_reply_to_author_id;assert.equal((await adapter.call(owner,'x_reply',missing)).ok,false);
 assert.equal((await adapter.call(owner,'x_reply',{...args,in_reply_to_author_id:'4242'})).value.code,'self_reply_not_supported');
 h.db.sqlite.prepare('INSERT INTO reply_opt_outs VALUES(?,?,?,?)').run('4242','5050','9999',now);
 assert.equal((await adapter.call(owner,'x_reply',{...args,idempotency_key:crypto.randomUUID()})).value.code,'reply_author_opted_out');assert.equal(h.state.xCalls.length,0);
});
test('author mutation after signing fails body proof before local/provider effects',async t=>{
 const {h,args,make}=await fixture(t);const adapter=make(async(url,init)=>{const b=JSON.parse(init.body);b.params.arguments.in_reply_to_author_id='6060';return h.worker.fetch(new Request(url,{...init,body:JSON.stringify(b)}),h.env)});
 assert.equal((await adapter.call(owner,'x_reply',args)).ok,false);assert.equal(h.state.xCalls.length,0);assert.equal(h.db.all('SELECT * FROM service_writes').length,0);
});
test('late local opt-out still prevents atomic dispatch without a paid scan',async t=>{
 const {h,args,adapter}=await fixture(t);let inserted=false;h.db.beforeQuery=sql=>{if(!inserted&&sql.includes('INSERT INTO reply_interactions')){inserted=true;h.db.sqlite.prepare('INSERT INTO reply_opt_outs VALUES(?,?,?,?)').run('4242','5050','20001',now)}};
 assert.equal((await adapter.call(owner,'x_reply',args)).value.code,'reply_dispatch_claim_denied');assert.equal(h.state.xCalls.length,0);
});
test('unknown browser reply remains immutable and status lookup makes no provider call',async t=>{
 const {h,args,adapter}=await fixture(t);h.state.onX=()=>response({},201);assert.equal((await adapter.call(owner,'x_reply',args)).value.state,'unknown');assert.equal(h.state.xCalls.length,1);
 assert.equal((await adapter.call(owner,'x_reply',args)).value.state,'unknown');assert.equal((await adapter.call(owner,'x_get_write_status',{idempotency_key:args.idempotency_key})).value.state,'unknown');assert.equal(h.state.xCalls.length,1);
});
