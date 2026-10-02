import {test} from 'node:test';
import assert from 'node:assert/strict';
import {handleMcp} from '../lib/x-mcp.mjs';
import {initializeFromOwnerClick,SITE_ORIGIN} from '../lib/service-key.mjs';
const owner={'oai-authenticated-user-id':'metadata-owner','oai-authenticated-user-email':'owner@example.invalid'};
const id='01234567-89ab-4cde-8fab-0123456789ab';
const args={idempotency_key:id};
const request=(params,headers=owner)=>new Request(SITE_ORIGIN+'/mcp',{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify({jsonrpc:'2.0',id:88,method:'tools/call',params})});
async function fixture(){let row;const db={prepare(){let values;return {bind(...v){values=v;return this},async run(){const [owner_id,public_jwk,private_jwk,fingerprint,created_at]=values;row={owner_id,public_jwk,private_jwk,fingerprint,created_at}},async first(){return row}}}};await initializeFromOwnerClick(db,{id:'metadata-owner'});return db;}

test('standard tools/call transport metadata is accepted and completely omitted from the signed backend request',async t=>{
 const db=await fixture();let calls=0;
 t.mock.method(globalThis,'fetch',async(url,init)=>{calls++;assert.equal(url,'https://backend.example.invalid/service/write/mcp');assert.deepEqual(JSON.parse(init.body),{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'x_get_write_status',arguments:args}});assert.ok(!init.body.includes('untrusted-metadata'));const claims=JSON.parse(Buffer.from(init.headers.Authorization.split('.')[1],'base64url'));assert.equal(claims.scope,'x:write:status');assert.deepEqual(Object.keys(claims).sort(),['iss','sub','aud','scope','iat','exp','jti','method','path','body_sha256','operation','idempotency_key'].sort());assert.ok(!JSON.stringify(claims).includes('untrusted-metadata'));return Response.json({jsonrpc:'2.0',id:1,result:{structuredContent:{version:1,operation:null,idempotency_key:id,state:'not_found',code:'write_not_found'}}})});
 for(const _meta of [{},{progressToken:'untrusted-metadata'},{progressToken:0},{progressToken:1.5},{'example.com/request':{trace:'untrusted-metadata',array:[1,null,true]},authorization:'untrusted-metadata',proof:'untrusted-metadata',owner:'untrusted-metadata',account:'untrusted-metadata',url:'https://untrusted-metadata.invalid',name:'x_create_original_post',arguments:{text:'untrusted-metadata'},X_ORIGINAL_POSTS_ENABLED:'true'}]){
  const result=await(await handleMcp(request({name:'x_get_write_status',arguments:args,_meta}),db,{X_WRITE_STATUS_ENABLED:'true'})).json();assert.equal(result.id,88);assert.equal(result.error,undefined,JSON.stringify(result));assert.equal(result.result.isError,false);assert.equal(result.result.structuredContent.state,'not_found');
 }
 assert.equal(calls,5);
});
test('malformed metadata, unknown outer fields and unsupported task execution are rejected before signing',async t=>{
 const db=await fixture();let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;throw Error('No transport allowed')});
 for(const _meta of [null,[],true,1,'metadata',{progressToken:null},{progressToken:[]},{progressToken:{}},{progressToken:true}]){const result=await(await handleMcp(request({name:'x_get_write_status',arguments:args,_meta}),db,{X_WRITE_STATUS_ENABLED:'true'})).json();assert.equal(result.error?.code,-32602,JSON.stringify(_meta));}
 for(const extra of [{task:{ttl:1000}},{metadata:{}},{url:'https://invalid.example'},{headers:owner},{owner_id:'metadata-owner'}]){const result=await(await handleMcp(request({name:'x_get_write_status',arguments:args,_meta:{},...extra}),db,{X_WRITE_STATUS_ENABLED:'true'})).json();assert.equal(result.error?.code,-32602);}
 const overflow=request({name:'x_get_write_status',arguments:args,_meta:{progressToken:'OVERFLOW'}});const body=(await overflow.text()).replace('"OVERFLOW"','1e400');const invalid=await(await handleMcp(new Request(SITE_ORIGIN+'/mcp',{method:'POST',headers:overflow.headers,body}),db,{X_WRITE_STATUS_ENABLED:'true'})).json();assert.equal(invalid.error?.code,-32602);
 assert.equal(calls,0);
});
test('metadata cannot supply owner identity, operation arguments, activation flags or relax body limits',async t=>{
 const db=await fixture();let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;throw Error('No transport allowed')});
 const meta={...owner,X_WRITE_STATUS_ENABLED:'true',idempotency_key:id,arguments:args};
 assert.equal((await handleMcp(request({name:'x_get_write_status',arguments:args,_meta:meta},{}),db,{X_WRITE_STATUS_ENABLED:'true'})).status,401);
 const wrong={...owner,'oai-authenticated-user-id':'different-owner'};const wrongOwner=await(await handleMcp(request({name:'x_get_write_status',arguments:args,_meta:meta},wrong),db,{X_WRITE_STATUS_ENABLED:'true'})).json();assert.equal(wrongOwner.result.isError,true);
 for(const input of [{...args,_meta:{}},{},{...args,allow_write:true}]){const result=await(await handleMcp(request({name:'x_get_write_status',arguments:input,_meta:meta}),db,{X_WRITE_STATUS_ENABLED:'true'})).json();assert.equal(result.result.structuredContent.reason,'invalid_write_arguments');}
 const disabled=await(await handleMcp(request({name:'x_get_write_status',arguments:args,_meta:meta}),db,{})).json();assert.equal(disabled.result.structuredContent.reason,'write_disabled');
 const cross={...owner,origin:'https://other.example'};assert.equal((await handleMcp(request({name:'x_get_write_status',arguments:args,_meta:{}},cross),db,{X_WRITE_STATUS_ENABLED:'true'})).status,403);
 assert.equal((await handleMcp(request({name:'x_get_write_status',arguments:args,_meta:{padding:'x'.repeat(8192)}}),db,{X_WRITE_STATUS_ENABLED:'true'})).status,413);assert.equal(calls,0);
});
