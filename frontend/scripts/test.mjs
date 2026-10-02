// Run integration fixtures in an isolated copy. The shipped read bridge stays disabled.
import {cp,mkdir,mkdtemp,readFile,writeFile,rm,readdir,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
const source=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const coreOnly=process.argv.includes('--core');
const defaults=spawnSync(process.execPath,['--test','tests/defaults.test.mjs'],{cwd:source,stdio:'inherit'});
if(defaults.status!==0)process.exit(defaults.status??1);
const temporary=await mkdtemp(path.join(tmpdir(),'dot-x-offline-'));
try {
 const fixture=path.join(temporary,'frontend');await mkdir(fixture);
 for(const name of ['lib','tests','package.json'])await cp(path.join(source,name),path.join(fixture,name),{recursive:true});
 // Junctions work without symlink privilege on Windows; this contains installed packages only.
 await symlink(path.join(source,'node_modules'),path.join(fixture,'node_modules'),'junction');
 const keyFile=path.join(fixture,'lib/service-key.mjs');let key=await readFile(keyFile,'utf8');
 assert.ok(key.includes('SERVICE_BRIDGE_ENABLED=false'));
 await writeFile(keyFile,key.replace('SERVICE_BRIDGE_ENABLED=false','SERVICE_BRIDGE_ENABLED=true'));
 const files=(await readdir(path.join(fixture,'tests'))).filter(n=>n.endsWith('.test.mjs')&&n!=='defaults.test.mjs').map(n=>'tests/'+n);
 if(!coreOnly){
  const backend=path.resolve(source,'../backend');
  for(const name of ['src','test','migrations','package.json'])await cp(path.join(backend,name),path.join(temporary,'backend',name),{recursive:true});
  files.push(...(await readdir(path.join(fixture,'tests/interop'))).filter(n=>n.endsWith('.test.mjs')).map(n=>'tests/interop/'+n));
 }
 const run=spawnSync(process.execPath,['--import','./tests/offline-runtime.mjs','--test',...files],{cwd:fixture,stdio:'inherit',env:{...process.env,BACKEND_CANDIDATE_PATH:path.join(temporary,'backend'),CLOUDFLARE_CF_FETCH_ENABLED:'false',WRANGLER_SEND_METRICS:'false'}});
 process.exitCode=run.status??1;
} finally {await rm(temporary,{recursive:true,force:true});}
