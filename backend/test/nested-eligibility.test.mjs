import test from 'node:test';
import assert from 'node:assert/strict';
import { ReplyGuard, MAX_REPLY_ANCESTORS, REPLY_PREFLIGHT_MICROUSD } from '../src/reply-guard.mjs';

function fixture(depth) {
 const now=2000000000,posts=new Map(),calls=[],optouts=new Set();
 const root={id:'100',author_id:'42',conversation_id:'100',referenced_posts:[],edit_history_post_ids:['100'],text:'An original',entities:{mentions:[]},created_at:new Date((now-1000)*1000).toISOString()};posts.set(root.id,root);
 let parent=root;
 for(let i=0;i<depth;i++){
  const id=String(200+i),post={...root,id,author_id:i%2?'42':'60',in_reply_to_user_id:parent.author_id,referenced_posts:[{type:'replied_to',id:parent.id}],edit_history_post_ids:[id],created_at:new Date((now-900+i*100)*1000).toISOString()};posts.set(id,post);parent=post;
 }
 const target={...root,id:'999',author_id:'50',in_reply_to_user_id:parent.author_id,referenced_posts:[{type:'replied_to',id:parent.id}],edit_history_post_ids:['999'],created_at:new Date((now-1)*1000).toISOString()};posts.set(target.id,target);
 const store={async first(sql,account,author){return optouts.has(author)?{author_id:author}:null},async run(sql,account,author){optouts.add(author)}};
 const guard=new ReplyGuard({SERVICE_X_ACCOUNT_ID:'42'},store,()=>now);let scans=0;guard.catchUp=async()=>{scans++};
 const x={async request(path,options){calls.push({path,options});const id=new URL(path,'https://example.invalid').pathname.split('/').at(-1),data=posts.get(id);assert(data);return {data,includes:{posts:[],users:[{id:data.author_id,protected:false,username:'participant'}]}}}};
 return {posts,target,root,calls,optouts,guard,verify:()=>guard.verify(x,'synthetic-token',{in_reply_to_post_id:target.id,idempotency_key:'synthetic-key'}),scans:()=>scans};
}
test('bounded ancestry accepts depths zero through four with fresh lookups and correct root',async()=>{
 assert.equal(MAX_REPLY_ANCESTORS,4);assert.equal(REPLY_PREFLIGHT_MICROUSD,360000);
 for(let depth=0;depth<=4;depth++){
  const f=fixture(depth),r=await f.verify();assert.equal(r.root,'100');assert.equal(f.calls.length,depth+2);assert.equal(f.scans(),1);
  assert(f.calls.every(c=>c.options.creditMicroUsd===15000));
 }
 const f=fixture(5);await assert.rejects(f.verify(),e=>e.code==='REPLY_ANCESTRY_LIMIT');assert.equal(f.calls.length,6);assert.equal(f.scans(),0);
});
test('nested eligibility cannot escape root or accept conflicting ancestry',async()=>{
 for(const mutate of [f=>f.root.author_id='90',f=>f.posts.get('200').conversation_id='90',f=>f.posts.get('200').referenced_posts=[{type:'quoted',id:'100'}],f=>f.target.in_reply_to_user_id='90',f=>f.posts.get('200').referenced_posts=[{type:'replied_to',id:'999'}],f=>f.target.created_at='123']){
  const f=fixture(1);mutate(f);await assert.rejects(f.verify());assert.equal(f.scans(),0);
 }
});
test('fresh parent username/ID proof permits that participant only; nested STOP persists',async()=>{
 const good=fixture(1);good.target.text='@participant Thanks';good.target.entities={mentions:[{id:'60'}]};await good.verify();
 const bad=fixture(1);bad.target.text='@intruder Thanks';bad.target.entities={mentions:[{id:'60'}]};await assert.rejects(bad.verify(),e=>e.code==='MULTIPARTY_REPLY_NOT_SUPPORTED');
 const stop=fixture(2);stop.target.text='STOP';await assert.rejects(stop.verify(),e=>e.code==='REPLY_AUTHOR_OPTED_OUT');assert(stop.optouts.has('50'));
});

test('target cannot also be the conversation root, even if a second lookup would contradict it',async()=>{
 const f=fixture(1);f.target.conversation_id=f.target.id;
 await assert.rejects(f.verify(),e=>e.code==='REPLY_ANCESTRY_INVALID');
 assert.equal(f.calls.length,1);assert.equal(f.scans(),0);
});
