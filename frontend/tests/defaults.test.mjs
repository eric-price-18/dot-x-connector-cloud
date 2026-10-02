import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SERVICE_BRIDGE_ENABLED,SITE_ORIGIN,ENDPOINT} from '../lib/service-key.mjs';
import {discoverWriteTools,WRITE_NAMES,writeEnabled,CANARY_DEADLINE,validateConfiguredWriteArguments} from '../lib/write-contract.mjs';
test('shipped public frontend is offline and nonfunctional until configured',()=>{
 assert.equal(SERVICE_BRIDGE_ENABLED,false);
 assert.equal(new URL(SITE_ORIGIN).hostname,'frontend.example.invalid');
 assert.equal(new URL(ENDPOINT).hostname,'backend.example.invalid');
 assert.deepEqual(discoverWriteTools(),[]);
 for(const name of WRITE_NAMES)for(const env of [{},{X_ORIGINAL_POSTS_ENABLED:'TRUE',X_REPOSTS_ENABLED:'1',X_OWN_THREAD_REPLIES_ENABLED:true}])assert.equal(writeEnabled(name,env),false);
});

test('public mention canary is expired and cannot authorize a current request',async()=>{
 assert.equal(CANARY_DEADLINE,Date.parse('2000-01-02T08:00:00Z')/1000);
 const text='@test_recipient Synthetic inert example';
 const key='01234567-89ab-4cde-8fab-0123456789ab';
 const hash=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))).toString('hex');
 const args={text,idempotency_key:key};
 const env={X_CANARY_MENTION_HANDLE:'@test_recipient',X_CANARY_MENTION_IDEMPOTENCY_KEY:key,X_CANARY_MENTION_TEXT_SHA256:hash,X_CANARY_MENTION_EXPIRES_AT:String(CANARY_DEADLINE)};
 for(const now of [CANARY_DEADLINE,Date.parse('2035-01-01T00:00:00Z')/1000]){
  assert.equal((await validateConfiguredWriteArguments('x_create_original_post',args,env,now)).ok,false);
  assert.equal((await validateConfiguredWriteArguments('x_create_original_post',args,{...env,X_CANARY_MENTION_EXPIRES_AT:String(now+3600)},now)).ok,false);
 }
});
