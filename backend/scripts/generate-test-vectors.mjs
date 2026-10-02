// Regenerate public, expired, synthetic interoperability vectors. Private keys
// exist only inside serviceFixture() and are never serialized or written.
import { writeFile } from 'node:fs/promises';
import { serviceFixture } from '../test/service-fixtures.mjs';
import { SERVICE } from '../src/service.mjs';
const path=name=>new URL(`../test/${name}`,import.meta.url);
const status={linked:false,reconnect_required:false,polling_enabled:false,post_enabled:false,reply_enabled:false};
for(const [name,now] of [['service-interoperability.json',946684800],['service-frontend-fixture.json',946728000]]) {
  const f=await serviceFixture(now),body=f.body(),proof=await f.token(body);
  const common={test_only:true,description:'Expired synthetic offline fixture; never trust this key in production. Private key discarded.',public_jwk:f.jwk,kid:f.kid,body};
  const vector=name==='service-frontend-fixture.json'?{...common,now,token:proof}:{...common,validation_time:now,
    url:SERVICE.audience,method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-11-25'},proof,
    expected_status:200,expected_body:{jsonrpc:'2.0',id:1,result:{content:[{type:'text',text:JSON.stringify(status)}],structuredContent:status}}};
  await writeFile(path(name),JSON.stringify(vector,null,2)+'\n');
}
console.log('Generated two expired, test-only vectors using fresh ephemeral keys.');
