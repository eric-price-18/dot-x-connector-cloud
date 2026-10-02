import { RUNTIME_NOW } from './clock-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime,json } from './helpers.mjs';
import { writeFixture,key,writeScopes } from '../test/write-fixtures.mjs';
import { replyData,replyArgs,lookupResponse } from '../test/reply-fixtures.mjs';
import { seal } from '../src/security.mjs';
import { ownerContext } from '../src/reads.mjs';

async function setup(t,overrides={}) {
 const now=RUNTIME_NOW,f=await writeFixture(now);
 const h=await runtime(t,{...f.env,POST_ENABLED:'false',REPLY_ENABLED:'true',X_OWN_THREAD_REPLIES_ENABLED:'true',
  X_CALLBACK_URL:f.env.PUBLIC_BASE_URL+'/x/callback',READ_POLLING_ENABLED:'false',MAX_REPLIES_DAY:'5',MAX_WRITES_DAY:'6',X_ONGOING_OPERATIONS_ENABLED:'true',...overrides});
 const encrypted=await seal(h.bindings.TOKEN_ENCRYPTION_KEY,{access_token:'runtime-reply-token',refresh_token:'runtime-refresh-token',scopes:writeScopes},ownerContext(h.bindings));
 await h.db.prepare('INSERT INTO accounts(id,issuer,subject,x_user_id,encrypted_tokens,expires_at,updated_at) VALUES(?,?,?,?,?,?,?)')
  .bind('primary',h.bindings.MCP_ISSUER,h.bindings.MCP_ALLOWED_SUBJECT,h.bindings.X_EXPECTED_USER_ID,encrypted,now+7200,now).run();
 await h.db.prepare('INSERT INTO x_credit_budgets VALUES(?,?,?,?,?,?,?)').bind(h.bindings.X_CREDIT_BUDGET_ID,'4242',5000000,0,0,Number(h.bindings.X_CREDIT_EXPIRES_AT),now).run();
 await h.db.prepare('INSERT INTO ongoing_credit_state VALUES(?,?,?,?)').bind('4242',4000000,0,'a'.repeat(64)).run();
 await h.db.prepare('INSERT INTO ongoing_cycles VALUES(?,?,?,?,?,?,?)').bind('4242',now-86400,now+30*86400,0,0,'a'.repeat(64),'2035-01').run();
 await h.db.prepare("INSERT INTO ongoing_legacy_carry VALUES('4242',0,0,0,0,0,0,'2034-12-31','2034-12',1,?)").bind(now).run();
 h.state.xScopes=writeScopes.join(' ');
 const data=replyData(now);
 h.state.onX=call=>{
  if(call.method==='GET'&&call.url.pathname==='/2/tweets/'+data.target.id)return json(lookupResponse(data.target));
  if(call.method==='GET'&&call.url.pathname==='/2/tweets/'+data.root.id)return json(lookupResponse(data.root));
  if(call.url.pathname==='/2/users/4242/mentions')return json(typeof data.mentions==='function'?data.mentions(call.url):data.mentions);
 };
 async function call(args=replyArgs(),name='x_reply') {
  const request=await f.request(name,args,{iat:h.state.now,exp:h.state.now+45});const response=await h.mf.dispatchFetch(request.url,{method:'POST',headers:request.headers,body:await request.arrayBuffer()});
  const body=await response.json();return {body,receipt:body.result?.structuredContent};
 }
 return {...h,data,call,get mf(){return h.mf;},get db(){return h.db;},sends:()=>h.xCalls().filter(v=>v.method==='POST'&&v.url.pathname==='/2/tweets')};
}

test('workerd ongoing: full envelope reserved before reads, cooldown and restart claims',async t=>{
 const h=await setup(t);const r=await h.call();assert.equal(r.receipt.state,'succeeded',JSON.stringify(r.body));
 assert.equal((await h.db.prepare('SELECT SUM(amount) AS n FROM ongoing_spend').first()).n,395000);
 await h.restart();assert.deepEqual((await h.call()).receipt,r.receipt);
 h.data.target={...h.data.target,id:'1003',edit_history_post_ids:['1003']};const before=h.xCalls().length;
 assert.equal((await h.call(replyArgs(2,replyArgs().text,'1003'))).receipt.code,'ongoing_operation_limit_or_cooldown');
 assert.equal(h.xCalls().length,before);
});
test('workerd ongoing: insufficient full envelope causes zero paid preflight calls',async t=>{
 const h=await setup(t);await h.db.prepare('UPDATE x_credit_budgets SET used_micro_usd=600000').run();
 assert.equal((await h.call()).receipt.code,'ongoing_spend_cap_or_reconciliation');assert.equal(h.xCalls().length,0);
});

test('workerd nested: four intermediate parents require fresh lookups, owned root and full reservation',async t=>{
 const h=await setup(t),parents=new Map();h.data.root.created_at=new Date((RUNTIME_NOW-1000)*1000).toISOString();let parent=h.data.root;
 for(let i=0;i<4;i++) {
  const id=String(7000+i),p={...h.data.root,id,author_id:i%2?'4242':'6060',conversation_id:h.data.root.id,
   in_reply_to_user_id:parent.author_id,referenced_posts:[{type:'replied_to',id:parent.id}],edit_history_post_ids:[id],
   created_at:new Date((RUNTIME_NOW-600+i*60)*1000).toISOString()};parents.set(id,p);parent=p;
 }
 h.data.target.referenced_posts=[{type:'replied_to',id:parent.id}];h.data.target.in_reply_to_user_id=parent.author_id;
 const original=h.state.onX;h.state.onX=call=>{const p=parents.get(call.url.pathname.split('/').at(-1));return p?json(lookupResponse(p)):original(call)};
 const r=await h.call();assert.equal(r.receipt.state,'succeeded',JSON.stringify(r.body));assert.equal(h.sends().length,1);
 for(const id of parents.keys())assert.equal(h.xCalls().filter(c=>c.url.pathname==='/2/tweets/'+id).length,1);
 const row=await h.db.prepare('SELECT amount,unresolved_micro_usd FROM ongoing_spend').first();assert.equal(row.amount,635000);assert.equal(row.unresolved_micro_usd,0);
});

test('workerd ongoing: retained full envelope blocks a second direct reply even below five-count ceiling',async t=>{
 const h=await setup(t);assert.equal((await h.call()).receipt.state,'succeeded');await h.setTime(RUNTIME_NOW+900);
 h.data.target={...h.data.target,id:'1003',edit_history_post_ids:['1003'],created_at:new Date((RUNTIME_NOW+899)*1000).toISOString()};
 const before=h.xCalls().length;assert.equal((await h.call(replyArgs(2,replyArgs().text,'1003'))).receipt.code,'ongoing_spend_cap_or_reconciliation');assert.equal(h.xCalls().length,before);
});

test('workerd nested: same-ID target/root rejects before second lookup and mutation',async t=>{
 const h=await setup(t);h.data.target.conversation_id=h.data.target.id;
 const r=await h.call();assert.equal(r.receipt.code,'reply_ancestry_invalid');assert.equal(h.sends().length,0);
 assert.equal(h.xCalls().filter(c=>c.url.pathname.startsWith('/2/tweets/')).length,1);
});
