import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateWriteArguments,validateConfiguredWriteArguments,CANARY_DEADLINE,discoverWriteTools} from '../lib/write-contract.mjs';
import {fixedWriteRequest} from '../lib/write-service-key.mjs';
import {createWriteAdapter} from '../lib/write-service-adapter.mjs';
import {initializeFromOwnerClick} from '../lib/service-key.mjs';
const NOW=Date.parse('2000-01-02T03:00:00Z')/1000;
const KEY='01234567-89ab-4cde-8fab-0123456789ab';
const INPUT={text:'@test_recipient A single mocked canary. 🦋',idempotency_key:KEY};
const hash=async text=>Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))).toString('hex');
const config=async(input=INPUT)=>({X_ORIGINAL_POSTS_ENABLED:'true',X_CANARY_MENTION_HANDLE:'@test_recipient',X_CANARY_MENTION_IDEMPOTENCY_KEY:input.idempotency_key,X_CANARY_MENTION_TEXT_SHA256:await hash(input.text),X_CANARY_MENTION_EXPIRES_AT:String(CANARY_DEADLINE)});
const valid=(input,env,now=NOW,name='x_create_original_post')=>validateConfiguredWriteArguments(name,input,env,now);
const owner=new Headers({'oai-authenticated-user-id':'canary-owner','oai-authenticated-user-email':'owner@example.invalid'});
async function fixture(){let row;const db={prepare(){let values;return {bind(...v){values=v;return this},async run(){const [owner_id,public_jwk,private_jwk,fingerprint,created_at]=values;row={owner_id,public_jwk,private_jwk,fingerprint,created_at}},async first(){return row}}}};await initializeFromOwnerClick(db,{id:'canary-owner'});return db;}

test('mention exception is absent by default and never changes the normal validator or tool argument schema',async()=>{
 assert.equal(validateWriteArguments('x_create_original_post',INPUT).ok,false);
 assert.equal((await valid(INPUT,{})).ok,false);
 assert.equal((await valid(INPUT,await config())).ok,true);
 const base=discoverWriteTools({X_ORIGINAL_POSTS_ENABLED:'true'});assert.deepEqual(discoverWriteTools(await config()),base);
 assert.deepEqual(Object.keys(base[0].inputSchema.properties),['text','idempotency_key']);
 for(const field of ['X_CANARY_MENTION_HANDLE','X_CANARY_MENTION_IDEMPOTENCY_KEY','X_CANARY_MENTION_TEXT_SHA256','X_CANARY_MENTION_EXPIRES_AT']){const env=await config();delete env[field];assert.equal((await valid(INPUT,env)).ok,false,field);}
});
test('exact key, digest, canonical configured handle and unextended deadline are all mandatory',async()=>{
 const env=await config();
 for(const changes of [{X_CANARY_MENTION_HANDLE:'@other'},{X_CANARY_MENTION_HANDLE:'@Test_recipient'},{X_CANARY_MENTION_HANDLE:'test_recipient'},{X_CANARY_MENTION_HANDLE:'@'},{X_CANARY_MENTION_HANDLE:'@'+'a'.repeat(16)},{X_CANARY_MENTION_IDEMPOTENCY_KEY:crypto.randomUUID()},{X_CANARY_MENTION_IDEMPOTENCY_KEY:KEY.toUpperCase()},{X_CANARY_MENTION_TEXT_SHA256:'0'.repeat(64)},{X_CANARY_MENTION_TEXT_SHA256:env.X_CANARY_MENTION_TEXT_SHA256.toUpperCase()},{X_CANARY_MENTION_EXPIRES_AT:String(CANARY_DEADLINE+1)},{X_CANARY_MENTION_EXPIRES_AT:String(NOW)},{X_CANARY_MENTION_EXPIRES_AT:'0'+CANARY_DEADLINE},{X_CANARY_MENTION_EXPIRES_AT:CANARY_DEADLINE},{X_CANARY_MENTION_EXPIRES_AT:'Infinity'}])assert.equal((await valid(INPUT,{...env,...changes})).ok,false,JSON.stringify(changes));
 for(const now of [CANARY_DEADLINE,CANARY_DEADLINE+1,NaN,Infinity,-1,NOW+.5])assert.equal((await valid(INPUT,env,now)).ok,false,String(now));
 assert.equal((await valid({...INPUT,text:INPUT.text+' '},env)).ok,false);assert.equal((await valid({...INPUT,idempotency_key:crypto.randomUUID()},env)).ok,false);
});
test('configured digest cannot bypass mention token, multiplicity, prefix or fullwidth guards',async()=>{
 for(const text of ['@test_recipientx Hello','x@test_recipient Hello','https://example.com/@test_recipient','x-@test_recipient Hello','@test_recipient @other','@test_recipient @test_recipient','@test_recipient ＠other','＠test_recipient Hello','@TEST_RECIPIENT Hello']){const input={...INPUT,text};assert.equal((await valid(input,await config(input))).ok,false,text);}
});
test('a valid exception preserves all original text and exact-object protections',async()=>{
 for(const text of ['@test_recipient '+ 'x'.repeat(281),'@test_recipient e\u0301','@test_recipient \ud800','@test_recipient \u202e','@test_recipient https://x.com/example/status/123','@test_recipient https://t.co/example']){const input={...INPUT,text};assert.equal((await valid(input,await config(input))).ok,false,text);}
 for(const extra of [{allow_mention:true},{recipient:'@test_recipient'},{quote_tweet_id:'1'},{reply:{in_reply_to_tweet_id:'1'}}])assert.equal((await valid({...INPUT,...extra},await config())).ok,false);
 const normal={...INPUT,text:'Normal original posts still work'};assert.equal((await valid(normal,{})).ok,true);assert.equal((await valid(normal,{X_CANARY_MENTION_EXPIRES_AT:'malformed'})).ok,true);
});
test('the exception does not apply to replies, reposts, or status and cannot enable any operation',async t=>{
 t.mock.timers.enable({apis:['Date'],now:NOW*1000});const env=await config();const reply={...INPUT,text:INPUT.text+' Reply STOP to opt out.',in_reply_to_post_id:'123'};
 assert.equal((await valid(reply,await config(reply),NOW,'x_reply')).ok,false);
 for(const name of ['x_repost','x_get_write_status'])assert.equal((await valid(INPUT,env,NOW,name)).ok,false);
 const db=await fixture();delete env.X_ORIGINAL_POSTS_ENABLED;await assert.rejects(()=>fixedWriteRequest(owner,db,'x_create_original_post',INPUT,env));let calls=0;
 const result=await createWriteAdapter({db,env,fetchImpl:async()=>{calls++;throw Error('No egress')}}).call(owner,'x_create_original_post',INPUT);assert.equal(result.reason,'write_disabled');assert.equal(calls,0);
});
test('both adapter and signer enforce operator bindings; signing and transport leave exact text untouched',async t=>{
 t.mock.timers.enable({apis:['Date'],now:NOW*1000});const env=await config();const db=await fixture();let calls=0;
 const proof=await fixedWriteRequest(owner,db,'x_create_original_post',INPUT,env);assert.deepEqual(JSON.parse(proof.body).params.arguments,INPUT);
 await assert.rejects(()=>fixedWriteRequest(owner,db,'x_create_original_post',{...INPUT,text:INPUT.text+' changed'},env));await assert.rejects(()=>fixedWriteRequest(new Headers(),db,'x_create_original_post',INPUT,env));
 const adapter=createWriteAdapter({db,env,fetchImpl:async(url,init)=>{calls++;assert.deepEqual(JSON.parse(init.body).params.arguments,INPUT);return Response.json({jsonrpc:'2.0',id:1,result:{structuredContent:{version:1,operation:'x_create_original_post',idempotency_key:KEY,state:'succeeded',code:'published',post_id:'123'}}})}});
 assert.equal((await adapter.call(owner,'x_create_original_post',INPUT)).value.state,'succeeded');assert.equal(calls,1);
 assert.equal((await adapter.call(owner,'x_create_original_post',{...INPUT,text:INPUT.text+' changed'})).reason,'mentions_not_supported');assert.equal(calls,1);
});
