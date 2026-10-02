// Local validation only. No network, credentials, account changes or SQL execution.
import {readFile,writeFile,realpath} from 'node:fs/promises';
import {resolve,dirname,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {reconciliationManifest} from '../src/maintenance.mjs';
const [input,output,...extra]=process.argv.slice(2);
if(!input||!output||extra.length)throw Error('Usage: node scripts/prepare-reconciliation.mjs PRIVATE_INPUT.json PRIVATE_OUTPUT.json');
const source=await realpath(fileURLToPath(new URL('../../',import.meta.url)));
const target=resolve(await realpath(dirname(resolve(output))),resolve(output).split(/[\\/]/).at(-1));
const rel=relative(source,target);
if(!rel||(rel.split(/[\\/]/)[0]!=='..'&&!isAbsolute(rel)))throw Error('Keep billing evidence outside the source checkout');
const raw=await readFile(input,'utf8');if(raw.length>=20000)throw Error('Evidence file is too large');
const m=JSON.parse(raw);reconciliationManifest({X_EXPECTED_USER_ID:m.account_id,ONGOING_RECONCILIATION_JSON:raw},Math.floor(Date.now()/1000));
await writeFile(target,JSON.stringify(m)+'\n',{encoding:'utf8',mode:0o600,flag:'wx'});
console.log('Validated private reconciliation file. No network calls or account changes performed.');
