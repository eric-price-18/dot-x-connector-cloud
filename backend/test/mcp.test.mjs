import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, accidentalNetwork } from './helpers.mjs';
import { toolsFor } from '../src/worker.mjs';

test('protected-resource metadata advertises the canonical MCP audience and read-only consent', async t => {
  const h=harness(t);
  for (const path of ['/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/mcp']) {
    const res=await h.api(path); const body=await res.json();
    assert.equal(body.resource,h.cfg.resource);
    assert.deepEqual(body.authorization_servers,[h.cfg.issuer]);
    assert.deepEqual(body.scopes_supported,['x:read']);
    assert.equal(res.headers.get('cache-control'),'no-store');
  }
  assert.equal(h.state.idpCalls.length+h.state.xCalls.length,0);
});

test('stateless Streamable HTTP initializes, negotiates versions, pings and lists tools', async t => {
  const h=harness(t);
  for (const version of ['2025-11-25','2025-06-18','2025-03-26','unknown-future-version']) {
    const res=await h.mcp('initialize',{protocolVersion:version},{auth:false});
    const body=await res.json();
    assert.equal(body.result.protocolVersion,['2025-11-25','2025-06-18'].includes(version)?version:'2025-11-25');
    assert.equal(body.result.capabilities.tools.listChanged,false);
    assert.equal(res.headers.get('mcp-session-id'),null);
  }
  assert.deepEqual((await (await h.mcp('ping')).json()).result,{});
  const list=(await (await h.mcp('tools/list',{}, {auth:false})).json()).result.tools;
  assert.deepEqual(list.map(v=>v.name),['x_connection_status','x_read_mentions','x_read_posts']);
  for (const tool of list) {
    assert.deepEqual(tool.securitySchemes,[{type:'oauth2',scopes:['x:read']}]);
    assert.deepEqual(tool._meta.securitySchemes,tool.securitySchemes);
    assert.equal(tool.annotations.readOnlyHint,true);
  }
  assert.equal(h.state.idpCalls.length+h.state.xCalls.length,0);
});

test('accepted initialized and cancellation notifications return an empty 202', async t => {
  const h=harness(t);
  for (const method of ['notifications/initialized','notifications/cancelled']) {
    const res=await h.api('/mcp',{method:'POST',data:{jsonrpc:'2.0',method},headers:{accept:'application/json, text/event-stream'}});
    assert.equal(res.status,202); assert.equal(await res.text(),'');
  }
});

test('GET SSE and DELETE session endpoints explicitly return 405', async t => {
  const h=harness(t);
  for (const method of ['GET','DELETE']) {
    const res=await h.api('/mcp',{method,headers:{accept:'text/event-stream'}});
    assert.equal(res.status,405); assert.equal(res.headers.get('allow'),'POST');
  }
});

test('missing bearer challenges with resource discovery and tool-level OAuth metadata', async t => {
  const h=harness(t); const {response,body}=await h.call('x_connection_status',{}, {auth:false});
  assert.equal(response.status,401);
  const challenge=response.headers.get('www-authenticate');
  assert(challenge.includes(`${h.cfg.base}/.well-known/oauth-protected-resource/mcp`));
  assert(challenge.includes('scope="x:read"'));
  assert.deepEqual(body.result._meta['mcp/www_authenticate'],[challenge]);
  assert.equal(h.state.idpCalls.length+h.state.xCalls.length,0);
});

test('a query-string bearer token is not accepted as authentication', async t => {
  const h=harness(t);
  const res=await h.api('/mcp?access_token=mock-mcp-token',{method:'POST',
    headers:{accept:'application/json, text/event-stream'},data:{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'x_connection_status'}}});
  assert.equal(res.status,401);
  assert.equal(h.state.idpCalls.length,0);
});

test('unknown methods, disabled tools and invalid arguments return JSON-RPC errors with request IDs', async t => {
  const h=harness(t);
  assert.deepEqual(await (await h.mcp('does/not/exist',{}, {id:'request-a'})).json(),
    {jsonrpc:'2.0',id:'request-a',error:{code:-32601,message:'METHOD_NOT_FOUND'}});
  const disabled=await h.call('x_create_post',{text:'no',idempotency_key:'mock-disabled-key'});
  assert.equal(disabled.body.error.code,-32602);
  for (const args of [{user_id:'different-account'},{access_token:'mock-injected'},[],null]) {
    const res=await h.call('x_read_mentions',args);
    assert.equal(res.body.error.code,-32602); assert.equal(res.body.id,1);
  }
  assert.equal(h.state.xCalls.length,0);
});

test('parse errors and invalid envelopes return valid JSON-RPC error objects', async t => {
  const h=harness(t);
  for (const [raw,code] of [['{broken',-32700],['[]',-32600],['null',-32600],['{"jsonrpc":"1.0","id":1,"method":"ping"}',-32600]]) {
    const res=await h.mcp('ping',{}, {raw});
    const body=await res.json();
    assert.equal(res.status,400); assert.equal(body.jsonrpc,'2.0'); assert.equal(body.id,null); assert.equal(body.error.code,code);
  }
  const invalidParams=await h.mcp('ping',[],{id:'bad-params'});
  assert.equal((await invalidParams.json()).error.code,-32602);
});

test('unsupported protocol, missing Accept types, content type and oversize bodies are rejected', async t => {
  const h=harness(t);
  const cases=[
    [{headers:{'mcp-protocol-version':'invalid'}},400],
    [{headers:{accept:'application/json'}},406],
    [{headers:{'content-type':'text/plain'}},415],
    [{raw:'x'.repeat(17000)},413]
  ];
  for (const [options,status] of cases) assert.equal((await h.mcp('ping',{},options)).status,status);
  assert.equal((await h.mcp('ping',{}, {headers:{'mcp-protocol-version':''}})).status,400);
  const noVersion=await h.api('/mcp',{method:'POST',data:{jsonrpc:'2.0',id:1,method:'ping'},headers:{accept:'application/json, text/event-stream'}});
  assert.equal(noVersion.status,200);
});

test('canonical origin and browser Origin are checked before authorization', async t => {
  const h=harness(t);
  for (const origin of ['https://attacker.invalid','null','']) {
    const res=await h.mcp('ping',{}, {headers:{origin}});
    assert.equal(res.status,403);
  }
  const wrongHost=new Request('https://wrong.invalid/mcp',{method:'POST'});
  assert.equal((await h.worker.fetch(wrongHost,h.env)).status,403);
  h.env.MCP_ALLOWED_ORIGINS='https://approved.example.invalid';
  assert.equal((await h.mcp('ping',{}, {headers:{origin:h.env.MCP_ALLOWED_ORIGINS}})).status,200);
  h.env.MCP_ALLOWED_ORIGINS='*';
  assert.equal((await h.mcp('ping',{}, {headers:{origin:'*'}})).status,503);
  assert.equal(h.state.idpCalls.length,0);
});

test('write schemas and flags are independent, with explicit permission and side-effect metadata', () => {
  for (const [env,name,scope] of [
    [{POST_ENABLED:'true'},'x_create_post','x:post']
  ]) {
    const tools=toolsFor(env); assert.equal(tools.length,4);
    const write=tools.find(v=>v.name===name);
    assert.deepEqual(write.securitySchemes,[{type:'oauth2',scopes:[scope]}]);
    assert.equal(write.annotations.readOnlyHint,false); assert.equal(write.annotations.destructiveHint,true);
    assert.equal(write.inputSchema.additionalProperties,false);
  }
  assert.equal(toolsFor({POST_ENABLED:true,REPLY_ENABLED:'TRUE'}).length,3);
});

test('scope enforcement rejects post permission for reply and read permission for post', async t => {
  const h=harness(t,{POST_ENABLED:'true',REPLY_ENABLED:'true'});
  const post=await h.call('x_create_post',{text:'Mock text',idempotency_key:'mock-scope-key-001'});
  assert.equal(post.response.status,403);
  assert(post.response.headers.get('www-authenticate').includes('scope="x:post"'));
  h.state.mcpScopes='x:read x:post';
  const reply=await h.call('x_reply_to_post',{text:'Mock reply',idempotency_key:'mock-scope-key-002',in_reply_to_post_id:'1002'});
  assert.equal(reply.body.error.message,'UNKNOWN_OR_DISABLED_TOOL');
  assert.equal(h.state.xCalls.length,0);
});

test('admin polling requires authentication and still respects the polling flag', async t => {
  const h=harness(t); await h.seed();
  assert.equal((await h.api('/admin/poll',{method:'POST'})).status,401);
  const disabled=await h.api('/admin/poll',{method:'POST',auth:true});
  assert.equal((await disabled.json()).error,'READ_POLLING_DISABLED');
  assert.equal(h.state.xCalls.length,0);
});

test('no DM, XChat, follow, arbitrary proxy or home timeline tool/route exists', async t => {
  const h=harness(t,{POST_ENABLED:'true',REPLY_ENABLED:'true'});
  assert.deepEqual(toolsFor(h.env).map(v=>v.name),['x_connection_status','x_read_mentions','x_read_posts','x_create_post']);
  for (const path of ['/dm','/xchat','/following','/proxy','/oauth/authorize','/oauth/token']) assert.equal((await h.api(path)).status,404);
  assert.equal(accidentalNetwork.length,0);
});
