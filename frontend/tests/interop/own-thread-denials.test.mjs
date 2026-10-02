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
const target=()=>({id:'20001',author_id:'5050',conversation_id:'10001',text:'An interested response',created_at:new Date((now-60)*1000).toISOString(),referenced_posts:[{type:'replied_to',id:'10001'}],edit_history_post_ids:['20001'],entities:{mentions:[]}});
const root=()=>({id:'10001',author_id:'4242',conversation_id:'10001',text:'An original observation',created_at:new Date((now-3600)*1000).toISOString(),referenced_posts:[],edit_history_post_ids:['10001'],entities:{mentions:[]}});
const cases=[
 ['foreign root','reply_root_not_own_original',v=>{v.root.author_id='6060'}],
 ['nested interaction','reply_not_direct_to_own_root',v=>{v.target.referenced_posts[0].id='9999'}],
 ['self interaction','self_reply_not_supported',v=>{v.target.author_id='4242'}],
 ['multiparty mention','multiparty_reply_not_supported',v=>{v.target.text+=' @other';v.target.entities.mentions=[{id:'7070',username:'other'}]}],
 ['protected author','public_reply_author_unverified',v=>{v.protected=true}],
 ['edited interaction','edited_or_unverified_interaction',v=>{v.target.edit_history_post_ids=['19999','20001']}],
 ['legacy safety alias','reply_lookup_dialect_unverified',v=>{v.target.referenced_tweets=v.target.referenced_posts;delete v.target.referenced_posts}],
 ['old interaction','reply_target_not_recent',v=>{v.target.created_at=new Date((now-90000)*1000).toISOString();v.root.created_at=new Date((now-100000)*1000).toISOString()}],
 ['quote root','reply_root_not_own_original',v=>{v.root.referenced_posts=[{type:'quoted',id:'8888'}]}],
 ['nested STOP','reply_author_opted_out',v=>{v.target.text='STOP';v.target.referenced_posts[0].id='9999'}],
 ['fresh mentions STOP','reply_author_opted_out',v=>{v.mentionsStop=true}],
 ['mentions pagination gap','reply_opt_out_scan_incomplete',v=>{v.gap=true}]
];
for(const [label,expected,configure] of cases)test(`actual adapter/backend denies ${label} without reply mutation`,async t=>{
 t.mock.timers.enable({apis:['Date'],now:now*1000});const frontendDb=memoryDb();await initializeFromOwnerClick(frontendDb,{id:'reply-denial-owner'});
 const env={PUBLIC_BASE_URL:'https://backend.example.invalid',X_CALLBACK_URL:'https://backend.example.invalid/x/callback',SERVICE_ENABLED:'true',SERVICE_WRITE_ENABLED:'true',SERVICE_PUBLIC_JWK:frontendDb.row.public_jwk,SERVICE_X_ACCOUNT_ID:'4242',LIVE_X_ENABLED:'true',REPLY_ENABLED:'true',X_OWN_THREAD_REPLIES_ENABLED:'true',X_WRITE_STATUS_ENABLED:'true',X_CREDIT_BUDGET_ID:'example-disabled-budget',X_CREDIT_CAP_MICROUSD:'5000000',X_CREDIT_INITIAL_MICROUSD:'0',X_CREDIT_EXPIRES_AT:String(Date.parse('2000-01-02T08:00:00Z')/1000)};
 const h=harness(t,env);h.state.now=now;await h.seed({scopes:['tweet.read','users.read','offline.access','tweet.write']});const values={target:target(),root:root(),protected:false};configure(values);let pages=0;
 h.state.onX=async(url,init)=>{
  assert.equal(init.method,'GET');const u=new URL(url);
  if(u.pathname==='/2/tweets/20001')return response({data:values.target,includes:{users:[{id:values.target.author_id,protected:values.protected}]}});
  if(u.pathname==='/2/tweets/10001')return response({data:values.root,includes:{users:[{id:values.root.author_id,protected:false}]}});
  if(u.pathname==='/2/users/4242/mentions'){
   pages++;const data=values.mentionsStop?[{id:'30001',author_id:'5050',text:'Please STOP responding',created_at:new Date(now*1000).toISOString()}]:[];
   return response({data,meta:{result_count:data.length,...(values.gap?{next_token:'page'+pages}:{})},...(data.length?{includes:{users:[{id:'5050',protected:false}]}}:{})});
  }
  throw Error('Unexpected lookup '+u.pathname);
 };
 const adapter=createWriteAdapter({db:frontendDb,env:{X_OWN_THREAD_REPLIES_ENABLED:'true'},fetchImpl:async(url,init)=>h.worker.fetch(new Request(url,init),h.env)});
 const args={text:'A bounded reply. Reply STOP to opt out.',in_reply_to_post_id:'20001',idempotency_key:crypto.randomUUID()};
 const result=await adapter.call(owner,'x_reply',args);assert.equal(result.ok,false,JSON.stringify(result));assert.equal(result.value.state,'rejected');assert.equal(result.value.code,expected);assert.ok(h.state.xCalls.every(v=>v.options.method==='GET'));assert.equal(h.state.idpCalls.length,0);
 const before=h.state.xCalls.length;const repeat=await adapter.call(owner,'x_reply',args);assert.equal(repeat.value.state,'rejected');assert.equal(h.state.xCalls.length,before);
 const nextIntent=await adapter.call(owner,'x_reply',{...args,idempotency_key:crypto.randomUUID()});assert.equal(nextIntent.value.state,'rejected');assert.ok(h.state.xCalls.every(v=>v.options.method==='GET'));
 if(label.includes('STOP'))assert.equal(h.db.all('SELECT author_id FROM reply_opt_outs WHERE account_id=?','4242')[0].author_id,'5050');
});

test('known preflight rejection preserves UUID result but permits a later explicitly new intent after recovery',async t=>{
 t.mock.timers.enable({apis:['Date'],now:now*1000});const frontendDb=memoryDb();await initializeFromOwnerClick(frontendDb,{id:'reply-denial-owner'});
 const h=harness(t,{PUBLIC_BASE_URL:'https://backend.example.invalid',X_CALLBACK_URL:'https://backend.example.invalid/x/callback',SERVICE_ENABLED:'true',SERVICE_WRITE_ENABLED:'true',SERVICE_PUBLIC_JWK:frontendDb.row.public_jwk,SERVICE_X_ACCOUNT_ID:'4242',LIVE_X_ENABLED:'true',REPLY_ENABLED:'true',X_OWN_THREAD_REPLIES_ENABLED:'true',X_WRITE_STATUS_ENABLED:'true',X_CREDIT_BUDGET_ID:'example-disabled-budget',X_CREDIT_CAP_MICROUSD:'5000000',X_CREDIT_INITIAL_MICROUSD:'0',X_CREDIT_EXPIRES_AT:String(Date.parse('2000-01-02T08:00:00Z')/1000)});
 h.state.now=now;await h.seed({scopes:['tweet.read','users.read','offline.access','tweet.write']});let failLookup=true,posts=0;
 h.state.onX=async(url,init)=>{const u=new URL(url);if(init.method==='POST'){posts++;assert.equal(JSON.parse(init.body).reply.in_reply_to_tweet_id,'20001');return response({data:{id:'80001'}},201);}
  if(u.pathname==='/2/tweets/20001'&&failLookup)return response({error:'mock lookup unavailable'},503);
  if(u.pathname==='/2/tweets/20001'||u.pathname==='/2/tweets/10001'){const post=u.pathname.endsWith('20001')?target():root();return response({data:post,includes:{users:[{id:post.author_id,protected:false}]}});}
  if(u.pathname==='/2/users/4242/mentions')return response({data:[],meta:{result_count:0}});throw Error('Unexpected mocked path');};
 const adapter=createWriteAdapter({db:frontendDb,env:{X_OWN_THREAD_REPLIES_ENABLED:'true'},fetchImpl:async(url,init)=>h.worker.fetch(new Request(url,init),h.env)});
 const args={text:'A recovered reply. Reply STOP to opt out.',in_reply_to_post_id:'20001',idempotency_key:crypto.randomUUID()};
 const rejected=await adapter.call(owner,'x_reply',args);assert.equal(rejected.value.state,'rejected');assert.equal(posts,0);assert.equal(h.db.all('SELECT * FROM reply_interactions').length,0);
 failLookup=false;const count=h.state.xCalls.length;assert.equal((await adapter.call(owner,'x_reply',args)).value.state,'rejected');assert.equal(h.state.xCalls.length,count);
 const recovered=await adapter.call(owner,'x_reply',{...args,idempotency_key:crypto.randomUUID()});assert.equal(recovered.ok,true,JSON.stringify(recovered));assert.equal(posts,1);assert.equal(h.db.all('SELECT * FROM reply_interactions').length,1);
});

test('bounded opt-out catch-up survives new intents and requires a fresh scan before reply',async t=>{
 t.mock.timers.enable({apis:['Date'],now:now*1000});const frontendDb=memoryDb();await initializeFromOwnerClick(frontendDb,{id:'reply-denial-owner'});
 const h=harness(t,{PUBLIC_BASE_URL:'https://backend.example.invalid',X_CALLBACK_URL:'https://backend.example.invalid/x/callback',SERVICE_ENABLED:'true',SERVICE_WRITE_ENABLED:'true',SERVICE_PUBLIC_JWK:frontendDb.row.public_jwk,SERVICE_X_ACCOUNT_ID:'4242',LIVE_X_ENABLED:'true',REPLY_ENABLED:'true',X_OWN_THREAD_REPLIES_ENABLED:'true',X_WRITE_STATUS_ENABLED:'true',MAX_X_REQUESTS_HOUR:'20',MAX_X_REQUESTS_DAY:'100',X_CREDIT_BUDGET_ID:'example-disabled-budget',X_CREDIT_CAP_MICROUSD:'5000000',X_CREDIT_INITIAL_MICROUSD:'0',X_CREDIT_EXPIRES_AT:String(Date.parse('2000-01-02T08:00:00Z')/1000)});
 h.state.now=now;await h.seed({scopes:['tweet.read','users.read','offline.access','tweet.write']});let posts=0;const scans=[];
 h.state.onX=async(url,init)=>{const u=new URL(url);if(init.method==='POST'){posts++;return response({data:{id:'80002'}},201);}
  if(u.pathname==='/2/tweets/20001'||u.pathname==='/2/tweets/10001'){const post=u.pathname.endsWith('20001')?target():root();return response({data:post,includes:{users:[{id:post.author_id,protected:false}]}});}
  if(u.pathname==='/2/users/4242/mentions'){
   const cursor=u.searchParams.get('pagination_token'),since=u.searchParams.get('since_id');scans.push({cursor,since});
   if(since==='30015')return response({data:[],meta:{result_count:0}});
   const first=cursor==='page2'?30005:cursor==='page1'?30010:30015;const data=Array.from({length:5},(_,i)=>({id:String(first-i),author_id:'6060',text:'An unrelated harmless mention'}));
   return response({data,meta:{result_count:5,...(cursor==='page2'?{}:{next_token:cursor==='page1'?'page2':'page1'})},includes:{users:[{id:'6060',protected:false}]}});
  }throw Error('Unexpected mocked path');};
 const adapter=createWriteAdapter({db:frontendDb,env:{X_OWN_THREAD_REPLIES_ENABLED:'true'},fetchImpl:async(url,init)=>h.worker.fetch(new Request(url,init),h.env)});
 const makeArgs=()=>({text:'A fully caught-up reply. Reply STOP to opt out.',in_reply_to_post_id:'20001',idempotency_key:crypto.randomUUID()});
 assert.equal((await adapter.call(owner,'x_reply',makeArgs())).value.code,'reply_opt_out_scan_incomplete');assert.equal(posts,0);assert.equal(h.db.all('SELECT * FROM reply_interactions').length,0);
 assert.equal((await adapter.call(owner,'x_reply',makeArgs())).value.code,'reply_opt_out_fresh_scan_required');assert.equal(posts,0);
 const sent=await adapter.call(owner,'x_reply',makeArgs());assert.equal(sent.ok,true,JSON.stringify(sent));assert.equal(posts,1);assert.deepEqual(scans,[{cursor:null,since:null},{cursor:'page1',since:null},{cursor:'page2',since:null},{cursor:null,since:'30015'}]);
});
