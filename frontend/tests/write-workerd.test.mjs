import {OFFLINE_RUNTIME_OPTIONS} from './offline-runtime.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
test('write adapter executes in workerd, validates emoji, signs, and never follows redirects',async()=>{
 const bundle=await build({stdin:{contents:`import {createWriteAdapter} from './lib/write-service-adapter.mjs';import {initializeFromOwnerClick} from './lib/service-key.mjs';export default {async fetch(){let row=null;const db={prepare(sql){let v;return {bind(...a){v=a;return this},async run(){const [owner_id,public_jwk,private_jwk,fingerprint,created_at]=v;row={owner_id,public_jwk,private_jwk,fingerprint,created_at}},async first(){return row}}}};await initializeFromOwnerClick(db,{id:'runtime-owner'});const headers=new Headers({'oai-authenticated-user-id':'runtime-owner','oai-authenticated-user-email':'owner@example.invalid'});return Response.json(await createWriteAdapter({db,env:{X_ORIGINAL_POSTS_ENABLED:'true'}}).call(headers,'x_create_original_post',{text:'🦋 A runtime-only mocked publication.',idempotency_key:'01234567-89ab-4cde-8fab-0123456789ab'}))}}`,resolveDir:process.cwd(),sourcefile:'write-runtime-test.js'},bundle:true,format:'esm',platform:'browser',write:false});
 let redirect=false,calls=0;
 const mf=new Miniflare({...OFFLINE_RUNTIME_OPTIONS,modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-05-15',outboundService:async request=>{
  calls++;assert.equal(request.url,'https://backend.example.invalid/service/write/mcp');
  const proof=request.headers.get('Authorization').slice(7).split('.');const claims=JSON.parse(Buffer.from(proof[1],'base64url'));const body=await request.text();
  assert.equal(claims.body_sha256,Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(body))).toString('base64url'));assert.equal(claims.scope,'x:write');
  if(redirect)return new Response(null,{status:307,headers:{location:'https://must-not-follow.invalid'}});
  return Response.json({jsonrpc:'2.0',id:1,result:{structuredContent:{version:1,operation:'x_create_original_post',idempotency_key:claims.idempotency_key,state:'succeeded',code:'published',post_id:'123'}}});
 }});
 try{const good=await(await mf.dispatchFetch('https://test.invalid')).json();assert.equal(good.ok,true);assert.equal(calls,1);redirect=true;const unknown=await(await mf.dispatchFetch('https://test.invalid')).json();assert.equal(unknown.value.state,'unknown');assert.equal(unknown.safe_to_retry,false);assert.equal(calls,2);}finally{await mf.dispose();}
});
