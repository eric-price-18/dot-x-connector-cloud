// Offline runtime check of an unconfigured, locally built starter overlay.
import {Miniflare} from 'miniflare';
import {readFile,readdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
assert.ok(process.argv[2],'Usage: node scripts/check-sites-overlay.mjs /path/to/built-starter');
const target=path.resolve(process.argv[2]);
process.chdir(target);
const at=relative=>path.join(target,relative);
import {MockAgent,setGlobalDispatcher} from 'undici';
const network=new MockAgent();network.disableNetConnect();network.enableNetConnect(host=>/^(?:127\.0\.0\.1|localhost|\[::1\])(?::[0-9]+)?$/.test(host));setGlobalDispatcher(network);
const mf=new Miniflare({cf:false,telemetry:{enabled:false},modules:[{type:'ESModule',path:at('dist/server/index.js')},...(await readdir(at('dist/server'),{recursive:true})).filter(f=>f!=='index.js'&&/\.m?js$/.test(f)).map(f=>({type:'ESModule',path:at('dist/server/'+f)}))],compatibilityDate:'2026-05-15',compatibilityFlags:['nodejs_compat'],d1Databases:{DB:'offline-overlay'},outboundService:()=>{throw Error('Unexpected outbound request')}});
try {
 const db=await mf.getD1Database('DB');for(const sql of (await readFile(at('drizzle/0000_dazzling_bromley.sql'),'utf8')).split(';').filter(s=>s.trim()))await db.prepare(sql).run();
 const request=async(path,init={})=>mf.dispatchFetch('https://frontend.example.invalid'+path,init);
 const setup=await request('/api/service-setup');assert.equal(setup.status,401);assert.equal(setup.headers.get('x-frame-options'),'DENY');assert.equal(setup.headers.get('referrer-policy'),'no-referrer');
 const headers={'oai-authenticated-user-email':'owner@example.invalid','oai-authenticated-user-id':'test-only-owner'};
 const own=await request('/api/service-setup',{headers});assert.equal(own.status,200);assert.equal((await own.json()).initialized,false);
 const wrong=await request('/api/service-setup',{headers:{...headers,'oai-authenticated-user-email':'other@example.invalid'}});assert.equal(wrong.status,403);
 const discovery=await request('/mcp',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})});assert.equal(discovery.status,200);const tools=(await discovery.json()).result.tools;assert.equal(tools.length,3);assert.ok(tools.every(t=>t.annotations.readOnlyHint));
 console.log('Built clean-starter overlay smoke passed: setup route/auth denials/security headers/default-off MCP discovery; no outbound requests.');
} finally {await mf.dispose();await network.close();}
