import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createWorker } from '../src/worker.mjs';
import { configuration, publicConfiguration } from '../src/security.mjs';
import { accidentalNetwork } from './helpers.mjs';

const deployment=JSON.parse(readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8').replace(/^\s*\/\/.*$/gm,''));
const env=deployment.vars;
const worker=createWorker({logger:()=>{}});
const request=(path,method='GET',message,bindings=env,headers={})=>worker.fetch(new Request(`${env.PUBLIC_BASE_URL}${path}`,{
  method,headers:{accept:'application/json, text/event-stream','content-type':'application/json',...headers},
  ...(message?{body:JSON.stringify(message)}:{})
}),bindings);
const rpc=(method,params={},headers={},bindings=env)=>request('/mcp','POST',{jsonrpc:'2.0',id:1,method,params},bindings,headers);

test('discovery deployment serves public metadata with no secrets, database, algorithm or owner subject',async()=>{
  assert.equal(env.MCP_ALLOWED_SUBJECT,undefined); assert.equal(env.MCP_JWT_ALG,undefined);
  assert.equal(deployment.d1_databases,undefined);
  for(const path of ['/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/mcp']) {
    const res=await request(path); assert.equal(res.status,200);
    assert.deepEqual(await res.json(),{resource:`${env.PUBLIC_BASE_URL}/mcp`,authorization_servers:[env.MCP_ISSUER],
      scopes_supported:['x:read'],bearer_methods_supported:['header']});
  }
  assert.equal((await request('/health')).status,200);
});

test('public initialize, ping and catalog need only canonical origin and issuer',async()=>{
  const minimal={PUBLIC_BASE_URL:env.PUBLIC_BASE_URL,MCP_ISSUER:env.MCP_ISSUER};
  assert.equal(publicConfiguration(minimal).resource,`${env.PUBLIC_BASE_URL}/mcp`);
  assert.throws(()=>configuration(minimal));
  for(const [method,params] of [['initialize',{protocolVersion:'2025-11-25'}],['ping',{}],['tools/list',{}]]) {
    const res=await rpc(method,params,{},minimal); assert.equal(res.status,200);
    const body=await res.json(); assert(body.result);
    if(method==='tools/list')assert.deepEqual(body.result.tools.map(t=>t.name),['x_connection_status','x_read_mentions','x_read_posts']);
  }
});

test('all authenticated read tools fail closed on absent owner or JWT algorithm without egress',async()=>{
  for(const missing of ['MCP_ALLOWED_SUBJECT','MCP_JWT_ALG']) {
    const bindings={...env,MCP_ALLOWED_SUBJECT:'mock-only-owner',MCP_JWT_ALG:'RS256'};
    delete bindings[missing];
    for(const name of ['x_connection_status','x_read_mentions','x_read_posts']) {
      const res=await rpc('tools/call',{name,arguments:{}},{authorization:'Bearer mock-only-token'},bindings);
      assert.equal(res.status,503); assert.equal((await res.json()).result.isError,true);
    }
  }
  assert.deepEqual(accidentalNetwork,[]);
});

test('deployment owner, X and admin routes reject requests with missing auth configuration and disabled gates',async()=>{
  for(const [path,method] of [['/owner','GET'],['/owner/login','POST'],['/owner/callback','GET'],
    ['/owner/connect','POST'],['/x/connect','POST'],['/x/callback','GET'],['/admin/poll','POST']]) {
    assert.equal((await request(path,method,undefined,env,{authorization:'Bearer mock-only-token'})).status,503);
  }
  assert.deepEqual(await worker.scheduled({},env,{}),{skipped:'READ_POLLING_DISABLED'});
  assert.deepEqual(accidentalNetwork,[]);
});

test('public configuration still validates canonical URLs and rejects foreign browser origins',async()=>{
  for(const changes of [{PUBLIC_BASE_URL:'http://unsafe.invalid'},{MCP_ISSUER:'http://unsafe.invalid'},
    {PUBLIC_BASE_URL:`${env.PUBLIC_BASE_URL}/path`},{MCP_ISSUER:`${env.MCP_ISSUER}?query=bad`}]) {
    assert.equal((await request('/.well-known/oauth-protected-resource/mcp','GET',undefined,{...env,...changes})).status,503);
  }
  assert.equal((await request('/.well-known/oauth-protected-resource/mcp','GET',undefined,env,{origin:'https://foreign.example.invalid'})).status,403);
});
