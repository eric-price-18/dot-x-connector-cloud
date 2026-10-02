import { RUNTIME_NOW } from './clock-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime,json } from './helpers.mjs';
import { writeFixture,key,writeScopes } from '../test/write-fixtures.mjs';
import { replyData,replyArgs,lookupResponse } from '../test/reply-fixtures.mjs';
import { seal } from '../src/security.mjs';
import { ownerContext } from '../src/reads.mjs';

async function setup(t) {
 const now=RUNTIME_NOW,f=await writeFixture(now);
 const h=await runtime(t,{...f.env,POST_ENABLED:'false',REPLY_ENABLED:'true',X_OWN_THREAD_REPLIES_ENABLED:'true',
  X_CALLBACK_URL:f.env.PUBLIC_BASE_URL+'/x/callback',MAX_REPLIES_DAY:'2'});
 const encrypted=await seal(h.bindings.TOKEN_ENCRYPTION_KEY,{access_token:'runtime-reply-token',refresh_token:'runtime-refresh-token',scopes:writeScopes},ownerContext(h.bindings));
 await h.db.prepare('INSERT INTO accounts(id,issuer,subject,x_user_id,encrypted_tokens,expires_at,updated_at) VALUES(?,?,?,?,?,?,?)')
  .bind('primary',h.bindings.MCP_ISSUER,h.bindings.MCP_ALLOWED_SUBJECT,h.bindings.X_EXPECTED_USER_ID,encrypted,now+7200,now).run();
 const data=replyData(now);
 h.state.onX=call=>{
  if(call.method==='GET'&&call.url.pathname==='/2/tweets/'+data.target.id)return json(lookupResponse(data.target));
  if(call.method==='GET'&&call.url.pathname==='/2/tweets/'+data.root.id)return json(lookupResponse(data.root));
  if(call.url.pathname==='/2/users/4242/mentions')return json(typeof data.mentions==='function'?data.mentions(call.url):data.mentions);
 };
 async function call(args=replyArgs(),name='x_reply') {
  const request=await f.request(name,args);const response=await h.mf.dispatchFetch(request.url,{method:'POST',headers:request.headers,body:await request.arrayBuffer()});
  const body=await response.json();return {body,receipt:body.result?.structuredContent};
 }
 return {...h,data,call,get db(){return h.db;},sends:()=>h.xCalls().filter(v=>v.method==='POST'&&v.url.pathname==='/2/tweets')};
}

test('workerd own-thread: exact reply, permanent target uniqueness and credit reserve survive restart',async t=>{
 const h=await setup(t);const r=await h.call();assert.equal(r.receipt.state,'succeeded',JSON.stringify(r.body));
 assert.deepEqual(JSON.parse(h.sends()[0].body),{text:replyArgs().text,reply:{in_reply_to_tweet_id:'1002'}});
 assert.equal((await h.db.prepare('SELECT used_micro_usd FROM x_credit_budgets').first()).used_micro_usd,395000);
 await h.restart();assert.deepEqual((await h.call()).receipt,r.receipt);
 const before=h.xCalls().length;assert.equal((await h.call(replyArgs(2,'Another reply. Reply STOP to opt out.'))).receipt.code,'reply_interaction_already_claimed');
 assert.equal(h.xCalls().length,before);assert.equal(h.sends().length,1);
});

test('workerd own-thread: persisted opt-out from STOP to automated reply blocks later direct-root interaction',async t=>{
 const h=await setup(t);h.data.mentions={data:[{id:'2000',author_id:'5050',text:'Do not ever reply to me',referenced_posts:[{type:'replied_to',id:'9001'}]}],meta:{result_count:1}};
 assert.equal((await h.call()).receipt.code,'reply_author_opted_out');await h.restart();
 h.data.mentions={data:[],meta:{result_count:0}};h.data.target={...h.data.target,id:'1003',edit_history_post_ids:['1003']};
 assert.equal((await h.call(replyArgs(2,replyArgs().text,'1003'))).receipt.code,'reply_author_opted_out');assert.equal(h.sends().length,0);
});

test('workerd own-thread: bounded catch-up resumes after restart, fresh rescan is required before dispatch',async t=>{
 const h=await setup(t);let pages=0;
 h.data.mentions=url=>{
  pages++;const cursor=url.searchParams.get('pagination_token');
  if(!cursor&&!url.searchParams.has('since_id'))return {data:[{id:'3000',author_id:'6060',text:'Hello'}],meta:{result_count:1,next_token:'page2'}};
  if(cursor==='page2')return {data:[{id:'2999',author_id:'6060',text:'Hello'}],meta:{result_count:1,next_token:'page3'}};
  if(cursor==='page3')return {data:[{id:'2998',author_id:'6060',text:'Hello'}],meta:{result_count:1}};
  assert.equal(url.searchParams.get('since_id'),'3000');return {data:[],meta:{result_count:0}};
 };
 assert.equal((await h.call()).receipt.code,'reply_opt_out_scan_incomplete');await h.restart();
 assert.equal((await h.call(replyArgs(2))).receipt.code,'reply_opt_out_fresh_scan_required');assert.equal(h.sends().length,0);
 assert.equal((await h.call(replyArgs(3))).receipt.state,'succeeded');assert.equal(pages,4);assert.equal(h.sends().length,1);
});

test('workerd own-thread: same-key concurrent calls claim once before paid validation',async t=>{
 const h=await setup(t);const results=await Promise.all(Array.from({length:10},()=>h.call()));
 assert.equal(results.filter(r=>r.receipt.state==='succeeded').length,1);assert.equal(h.sends().length,1);assert.equal(h.xCalls().length,4);
});

test('workerd own-thread: unknown dispatch keeps interaction tombstone across restart and new keys',async t=>{
 const h=await setup(t),before=h.state.onX;
 h.state.onX=call=>call.method==='POST'&&call.url.pathname==='/2/tweets'?json({},201):before(call);
 assert.equal((await h.call()).receipt.state,'unknown');await h.restart();
 assert.equal((await h.call(replyArgs(2,'Different reply. Reply STOP to opt out.'))).receipt.code,'reply_interaction_already_claimed');assert.equal(h.sends().length,1);
});

test('workerd own-thread: wrong-root/multiparty/edit proof rejection leaves target retryable only under new explicit intent',async t=>{
 const h=await setup(t);h.data.root.author_id='777';const r=await h.call();assert.equal(r.receipt.code,'reply_root_not_own_original');
 assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM reply_interactions').first()).n,0);
 h.data.root.author_id='4242';assert.equal((await h.call()).receipt.code,'reply_root_not_own_original');
 assert.equal((await h.call(replyArgs(2))).receipt.state,'succeeded');assert.equal(h.sends().length,1);
});

test('workerd own-thread: expired crash lease recovers; a newer generation fences stale scanner',async t=>{
 const h=await setup(t),now=RUNTIME_NOW;
 await h.db.prepare('INSERT INTO reply_opt_out_scans(account_id,generation,locked_until,completed_at) VALUES(?,?,?,0)').bind('4242',9,now-1).run();
 let entered=false;const before=h.state.onX;
 h.state.onX=async call=>{
  if(!entered&&call.url.pathname==='/2/users/4242/mentions'){
   entered=true;await h.db.prepare("UPDATE reply_opt_out_scans SET generation=generation+1,since_id='4000',locked_until=0").run();
  }
  return before(call);
 };
 assert.equal((await h.call()).receipt.code,'reply_opt_out_scan_superseded');assert.equal(h.sends().length,0);
 assert.equal((await h.call(replyArgs(2))).receipt.state,'succeeded');
});
