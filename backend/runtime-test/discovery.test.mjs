import { runtimeModules } from './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';

test('workerd: public example configuration runs without D1/secrets and denies every active operation without egress',async t=>{
  const config=JSON.parse((await readFile(resolve(root,'wrangler.jsonc'),'utf8')).replace(/^\s*\/\/.*$/gm,''));
  let outbound=0;
  const options=convertV4MiniflareOptions({name:'local-discovery-check',
    modules:runtimeModules({productionCreditPolicy:true}),
    compatibilityDate:config.compatibility_date,host:'127.0.0.1',port:0,cf:false,
    log:new Log(LogLevel.ERROR),bindings:config.vars,
    outboundService:()=>{outbound++;throw new Error('No egress permitted');}
  });
  options.telemetry={enabled:false};
  const mf=new Miniflare(options);t.after(async()=>{await mf.dispose();assert.equal(outbound,0);});
  await mf.ready;
  const call=(path,method='GET',message)=>mf.dispatchFetch(`${config.vars.PUBLIC_BASE_URL}${path}`,{method,redirect:'manual',
    headers:{accept:'application/json, text/event-stream','content-type':'application/json',authorization:'Bearer mock-only-token'},
    ...(message?{body:JSON.stringify(message)}:{})});
  const meta=await call('/.well-known/oauth-protected-resource/mcp');assert.equal(meta.status,200);
  assert.equal((await meta.json()).resource,`${config.vars.PUBLIC_BASE_URL}/mcp`);
  for(const method of ['initialize','ping','tools/list']) {
    const res=await call('/mcp','POST',{jsonrpc:'2.0',id:1,method,params:method==='initialize'?{protocolVersion:'2025-11-25'}:{}});
    assert.equal(res.status,200);
    const body=await res.json();
    if(method==='tools/list')assert.equal(body.result.tools.length,3);
  }
  for(const name of ['x_connection_status','x_read_mentions','x_read_posts']) {
    const res=await call('/mcp','POST',{jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:{}}});
    assert.equal(res.status,503);assert.equal((await res.json()).result.isError,true);
  }
  for(const [path,method] of [['/owner','GET'],['/owner/login','POST'],['/owner/callback','GET'],
    ['/owner/connect','POST'],['/x/connect','POST'],['/x/callback','GET'],['/admin/poll','POST']])
    assert.equal((await call(path,method)).status,503);
  assert.equal((await call('/health')).status,200);
});
