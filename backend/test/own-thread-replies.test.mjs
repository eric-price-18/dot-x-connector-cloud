import test from 'node:test';
import assert from 'node:assert/strict';
import { replyHarness,replyArgs } from './reply-fixtures.mjs';
import { key } from './write-fixtures.mjs';
import { optOutSignal } from '../src/reply-guard.mjs';

const run=h=>h.call('x_reply',replyArgs());
test('own-thread reply is exact-text single-target and independent of original post enablement',async t=>{
 const h=await replyHarness(t);const r=await run(h);assert.equal(r.receipt.state,'succeeded',JSON.stringify(r.body));
 assert.equal(r.receipt.code,'reply_succeeded');assert.equal(h.sends().length,1);
 assert.deepEqual(JSON.parse(h.sends()[0].options.body),{text:replyArgs().text,reply:{in_reply_to_tweet_id:'1002'}});
 assert.equal(h.data.lookupCalls,2);assert.equal(h.state.xCalls.length,4);
 assert.deepEqual((await run(h)).receipt,r.receipt);assert.equal(h.state.xCalls.length,4);
 const credit=h.db.all('SELECT used_micro_usd FROM x_credit_budgets')[0];assert.equal(credit.used_micro_usd,255000);
});

test('reply parent-author proof does not depend on optional in_reply_to_user_id default',async t=>{
 const h=await replyHarness(t);delete h.data.target.in_reply_to_user_id;
 assert.equal((await run(h)).receipt.state,'succeeded');
});

for(const [label,modify] of [
 ['other-root-author',d=>d.root.author_id='999'],['nested-target',d=>d.target.referenced_posts[0].id='777'],
 ['self-target',d=>d.target.author_id='4242'],['root-is-reply',d=>d.root.referenced_posts=[{id:'800',type:'replied_to'}]],
 ['root-conversation-mismatch',d=>d.root.conversation_id='800'],['target-quote',d=>d.target.referenced_posts.push({id:'888',type:'quoted'})],
 ['target-mention',d=>d.target.entities.mentions=[{id:'777',username:'someone'}]],['root-mention',d=>d.root.entities.mentions=[{id:'777',username:'someone'}]],
 ['hidden-participant',d=>d.target.text='Hello @someone'],['mismatched-reply-author',d=>d.target.in_reply_to_user_id='777'],
 ['edited-target',d=>d.target.edit_history_post_ids.push('1003')],['edited-root',d=>d.root.edit_history_post_ids.push('999')],
 ['missing-edit-proof',d=>delete d.target.edit_history_post_ids],['mixed-dialect',d=>d.target.referenced_tweets=d.target.referenced_posts],
 ['missing-conversation',d=>delete d.target.conversation_id],['missing-author',d=>delete d.target.author_id],
 ['future-target',d=>d.target.created_at='2099-01-01T00:00:00Z'],['old-target',d=>d.target.created_at='1999-01-01T00:00:00Z'],
 ['long-form-target',d=>d.target.note_post={text:'Hidden @participant'}],['sensitive-target',d=>d.target.possibly_sensitive=true],['withheld-root',d=>d.root.withheld={country_codes:['X']}]
])test('own-thread reply rejects '+label+' before mutation',async t=>{
 const h=await replyHarness(t);modify(h.data);const r=await run(h);assert.equal(r.receipt.state,'rejected',JSON.stringify(r.body));assert.equal(h.sends().length,0);
 assert.equal((await h.call('x_reply',replyArgs(2,'Changed reply. Reply STOP to opt out.'))).receipt.state,'rejected');
 assert.equal(h.db.all('SELECT * FROM reply_interactions').length,0);
});

for(const [label,mutate] of [
 ['partial-errors',r=>({...r,errors:[{detail:'no'}]})],['private-author',r=>({...r,includes:{users:[{id:r.data.author_id,protected:true}]}})],
 ['conflicting-author-expansion',r=>({...r,includes:{users:[{id:r.data.author_id,protected:false},{id:r.data.author_id,protected:true}]}})],
 ['missing-author-expansion',r=>({...r,includes:{}})],['extra-reference-expansion',r=>({...r,includes:{...r.includes,posts:Array(4).fill({id:'1'})}})]
])test('own-thread reply fails closed on '+label,async t=>{
 const h=await replyHarness(t);h.data.mutate=mutate;assert.equal((await run(h)).receipt.state,'rejected');assert.equal(h.sends().length,0);
});

test('exact opt-out notice is mandatory and no content is silently appended',async t=>{
 const h=await replyHarness(t);const r=await h.call('x_reply',replyArgs(1,'Reply without notice'));
 assert.equal(r.body.result.content[0].text,'REPLY_OPT_OUT_NOTICE_REQUIRED');assert.equal(h.state.xCalls.length,0);
 assert.equal(h.db.all('SELECT * FROM reply_interactions').length,0);
});

test('target STOP persists author opt-out even for edited/nested/private ineligible targets',async t=>{
 const h=await replyHarness(t);h.data.target.text='Please DON’T respond again';h.data.target.edit_history_post_ids.push('1004');
 h.data.target.referenced_posts[0].id='888';h.data.mutate=r=>({...r,includes:{users:[{id:r.data.author_id,protected:true}]}});
 assert.equal((await run(h)).receipt.state,'rejected');assert.equal(h.db.all('SELECT * FROM reply_opt_outs')[0].author_id,'5050');
 assert.equal(h.sends().length,0);
});

test('fresh mentions STOP to our automated reply blocks an older eligible target and persists across keys',async t=>{
 const h=await replyHarness(t);h.data.mentions={data:[{id:'2000',author_id:'5050',text:'STOP',referenced_posts:[{id:'9001',type:'replied_to'}]}],meta:{result_count:1}};
 const r=await run(h);assert.equal(r.receipt.code,'reply_author_opted_out');assert.equal(h.sends().length,0);
 h.data.target={...h.data.target,id:'1003',edit_history_post_ids:['1003']};h.data.mentions={data:[],meta:{result_count:0}};
 assert.equal((await h.call('x_reply',replyArgs(2,replyArgs().text,'1003'))).receipt.code,'reply_author_opted_out');
});

test('known opt-out checked again immediately before dispatch catches concurrent ingestion',async t=>{
 const h=await replyHarness(t);let inserted=false;
 h.db.beforeQuery=sql=>{if(!inserted&&sql.includes("INSERT INTO reply_interactions")){inserted=true;h.db.sqlite.prepare('INSERT INTO reply_opt_outs VALUES(?,?,?,?)').run('4242','5050','2000',h.clock());}};
 assert.equal((await run(h)).receipt.code,'reply_dispatch_claim_denied');assert.equal(h.sends().length,0);
});

test('two-page fresh catch-up sees later-page opt-out and never advances cursor on incomplete pages',async t=>{
 const h=await replyHarness(t);let pages=0;
 h.data.mentions=()=>{pages++;return {data:[{id:String(3000-pages),author_id:pages===2?'5050':'6060',text:pages===2?'unsubscribe':'Hello'}],meta:{result_count:1,next_token:'page'+pages}};};
 assert.equal((await run(h)).receipt.code,'reply_opt_out_scan_incomplete');assert.equal(pages,2);assert.equal(h.sends().length,0);
 const scan=h.db.all('SELECT * FROM reply_opt_out_scans')[0];assert.equal(scan.since_id,null);assert.equal(scan.next_token,'page2');assert.equal(scan.completed_at,0);assert.equal(h.db.all('SELECT * FROM reply_opt_outs').length,1);
});

test('scan errors, mismatched result count, repeated cursor and record budget failure never mutate X',async t=>{
 const h=await replyHarness(t);h.data.mentions={data:[],meta:{result_count:1}};
 assert.equal((await run(h)).receipt.code,'reply_opt_out_scan_invalid');assert.equal(h.sends().length,0);
});

test('concurrent keys/text for one interaction permit at most one durable dispatch',async t=>{
 const h=await replyHarness(t);
 const outcomes=await Promise.all(Array.from({length:8},(_,i)=>h.call('x_reply',replyArgs(i+1,`Reply ${i}. Reply STOP to opt out.`))));
 assert(outcomes.filter(r=>r.receipt.state==='succeeded').length<=1);assert(h.sends().length<=1);assert(h.data.lookupCalls<=16);
 assert(h.db.all('SELECT * FROM reply_interactions').length<=1);
});

test('reply ambiguity consumes interaction forever, even with a new UUID and changed text',async t=>{
 const h=await replyHarness(t);const old=h.state.onX;h.state.onX=(url,options)=>{
  if(options.method==='POST'&&new URL(url).pathname==='/2/tweets')throw Error('lost send response');return old(url,options);
 };
 assert.equal((await run(h)).receipt.state,'unknown');
 assert.equal((await h.call('x_reply',replyArgs(2,'Different text. Reply STOP to opt out.'))).receipt.code,'reply_interaction_already_claimed');assert.equal(h.sends().length,1);
});

test('opt-out parser catches obvious case, unicode and apostrophe variants conservatively',()=>{
 for(const text of ['STOP','unsubscribe','OPT OUT','please opt me out','do not reply','Do  not reply','Do\nnot reply','Please do not ever reply to me','never respond to me','do not send me replies','don’t respond','ＤＯ ＮＯＴ ＣＯＮＴＡＣＴ','no more replies','leave me alone','s\u200bt\u200bo\u200bp'])assert(optOutSignal(text),text);
 assert(!optOutSignal('Thanks for explaining'));
});

test('bounded catch-up resumes persisted cursor, requires fresh rescan, then permits a new explicit attempt',async t=>{
 const h=await replyHarness(t,{MAX_X_REQUESTS_HOUR:'20'});let pages=0;
 h.data.mentions=u=>{
  pages++;
  const cursor=u.searchParams.get('pagination_token');
  if(!cursor&&!u.searchParams.has('since_id'))return {data:[{id:'3000',author_id:'6060',text:'Hello'}],meta:{result_count:1,next_token:'page2'}};
  if(cursor==='page2')return {data:[{id:'2999',author_id:'6060',text:'Hello'}],meta:{result_count:1,next_token:'page3'}};
  if(cursor==='page3')return {data:[{id:'2998',author_id:'6060',text:'Hello'}],meta:{result_count:1}};
  assert.equal(u.searchParams.get('since_id'),'3000');return {data:[],meta:{result_count:0}};
 };
 assert.equal((await run(h)).receipt.code,'reply_opt_out_scan_incomplete');
 assert.equal((await h.call('x_reply',replyArgs(2))).receipt.code,'reply_opt_out_fresh_scan_required');
 assert.equal(h.db.all('SELECT * FROM reply_interactions').length,0);assert.equal(h.sends().length,0);
 assert.equal((await h.call('x_reply',replyArgs(3))).receipt.state,'succeeded');assert.equal(pages,4);assert.equal(h.sends().length,1);
 // Consumed prior UUIDs stay immutable even though a later explicit intent succeeded.
 assert.equal((await run(h)).receipt.code,'reply_opt_out_scan_incomplete');
});

test('crashed scan lease can recover while a stale generation cannot commit or authorize dispatch',async t=>{
 const h=await replyHarness(t);const {ReplyGuard}=await import('../src/reply-guard.mjs');
 await h.store.run('INSERT INTO reply_opt_out_scans(account_id,generation,locked_until,completed_at) VALUES(?,?,?,?)','4242',9,h.clock()-1,0);
 let changed=false;
 h.data.mentions=()=>{if(!changed){changed=true;h.db.sqlite.prepare('UPDATE reply_opt_out_scans SET generation=generation+1,since_id=?,locked_until=0').run('4000');}return {data:[],meta:{result_count:0}};};
 const r=await run(h);assert.equal(r.receipt.code,'reply_opt_out_scan_superseded');assert.equal(h.sends().length,0);
 const row=h.db.all('SELECT * FROM reply_opt_out_scans')[0];assert.equal(row.generation,11);assert.equal(row.since_id,'4000');
 h.data.mentions={data:[],meta:{result_count:0}};
 assert.equal((await h.call('x_reply',replyArgs(2))).receipt.state,'succeeded');
});

test('same-key concurrent reply calls spend once and publish once',async t=>{
 const h=await replyHarness(t);const results=await Promise.all(Array.from({length:10},()=>run(h)));
 assert.equal(results.filter(r=>r.receipt.state==='succeeded').length,1);assert.equal(h.sends().length,1);assert.equal(h.state.xCalls.length,4);
});
