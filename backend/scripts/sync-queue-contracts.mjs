// Offline deterministic public contract synchronization; no deployment or credentials.
import {readFileSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {queueFrontendContract} from './queue-frontend-contract.mjs';
import {QUEUE_TOOLS,QUEUE_AUDIENCE} from '../src/reply-queue-policy.mjs';
const check=process.argv[2]==='--check';
assert(process.argv.length<=3&&[undefined,'--check'].includes(process.argv[2]));
const write=(target,bytes)=>check?assert.equal(readFileSync(target,'utf8'),bytes,'Generated contract differs: '+target):writeFileSync(target,bytes);
const policy=JSON.stringify(queueFrontendContract(),null,2)+'\n';
write(new URL('../../docs/reply-queue-contract.json',import.meta.url),policy);
write(new URL('../../frontend/lib/reply-queue-policy.json',import.meta.url),policy);
for(const name of ['reply-queue-send-policy.json','reply-queue-send-output-policy.json','reply-queue-claim-output-policy.json']){
 const bytes=readFileSync(new URL('../contracts/'+name,import.meta.url),'utf8'),contract=JSON.parse(bytes);
 if(name==='reply-queue-send-policy.json'){
  assert.equal(contract.endpoint.audience,QUEUE_AUDIENCE);
  for(const tool of contract.tools)assert.deepEqual(tool.inputSchema,QUEUE_TOOLS.find(item=>item.name===tool.name).inputSchema);
 }
 write(new URL('../../frontend/lib/'+name,import.meta.url),bytes);
}
console.log(check?'PASS: public backend/frontend contracts match.':'Synchronized public backend/frontend contracts.');
