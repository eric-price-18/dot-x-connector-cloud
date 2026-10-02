import { serviceFixture } from './service-fixtures.mjs';
import { harness } from './helpers.mjs';
import { WRITE_AUDIENCE, WRITE_PATH, writeScope } from '../src/write-policy.mjs';

export const key = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
export const writeScopes=['tweet.read','users.read','offline.access','tweet.write'];
export async function writeFixture(now) {
  const f=await serviceFixture(now);
  async function request(name,args,claims={},options={}) {
    const raw=options.raw??f.body(name,args);
    return f.request(raw,{claims:{aud:WRITE_AUDIENCE,path:WRITE_PATH,scope:writeScope(name),operation:name,
      idempotency_key:args.idempotency_key,...(name==='x_reply'?{in_reply_to_post_id:args.in_reply_to_post_id}:{}),...claims}},
      {url:WRITE_AUDIENCE,...options});
  }
  return {...f,request,env:{...f.env,SERVICE_WRITE_ENABLED:'true',X_WRITE_STATUS_ENABLED:'true',
    X_ORIGINAL_POSTS_ENABLED:'true',X_REPOSTS_ENABLED:'true',POST_ENABLED:'true',LIVE_X_ENABLED:'true',
    SERVICE_X_ACCOUNT_ID:'4242',X_EXPECTED_USER_ID:'4242',MAX_WRITES_DAY:'10',MAX_REPOSTS_DAY:'2'}};
}
export async function writeHarness(t,overrides={}) {
  const base=new URL(WRITE_AUDIENCE).origin;
  const h=harness(t,{PUBLIC_BASE_URL:base,X_CALLBACK_URL:base+'/x/callback'});
  const f=await writeFixture(h.clock());Object.assign(h.env,f.env,overrides);
  const call=async(name,args,claims={},options={})=>{
    const response=await h.worker.fetch(await f.request(name,args,claims,options),h.env);
    const body=await response.json();return {response,body,receipt:body.result?.structuredContent};
  };
  const status=(idempotency_key,claims={})=>call('x_get_write_status',{idempotency_key},claims);
  const sends=()=>h.state.xCalls.filter(v=>v.options.method==='POST'&&!v.url.endsWith('/oauth2/token'));
  return {...h,f,call,status,sends};
}
