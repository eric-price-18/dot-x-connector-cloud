import { writeHarness,writeScopes,key } from './write-fixtures.mjs';
import { response } from './helpers.mjs';
export const replyArgs=(n=1,text='Thanks for the thoughtful question. Reply STOP to opt out.',target='1002')=>({text,in_reply_to_post_id:target,idempotency_key:key(n)});
export function replyData(now) {
 const common={entities:{mentions:[]}};
 const target={...common,id:'1002',author_id:'5050',conversation_id:'1001',in_reply_to_user_id:'4242',
  referenced_posts:[{type:'replied_to',id:'1001'}],edit_history_post_ids:['1002'],text:'Can you explain this?',created_at:new Date((now-60)*1000).toISOString()};
 const root={...common,id:'1001',author_id:'4242',conversation_id:'1001',referenced_posts:[],edit_history_post_ids:['1001'],
  text:'A public original post',created_at:new Date((now-120)*1000).toISOString()};
 return {target,root,mentions:{data:[],meta:{result_count:0}},mutate:null,lookupCalls:0};
}
export const lookupResponse=post=>({data:post,includes:{users:[{id:post.author_id,protected:false}],posts:[]}});
export async function replyHarness(t,changes={}) {
 const h=await writeHarness(t,{REPLY_ENABLED:'true',X_OWN_THREAD_REPLIES_ENABLED:'true',POST_ENABLED:'false',
  MAX_X_REQUESTS_DAY:'100',MAX_X_REQUESTS_HOUR:'20',MAX_REPLIES_DAY:'2',...changes});await h.seed({scopes:writeScopes});
 const data=replyData(h.clock());
 h.state.onX=(url,options)=>{
  const u=new URL(url);let result;
  if(options.method==='GET'&&u.pathname==='/2/tweets/'+data.target.id) {data.lookupCalls++;result=lookupResponse(data.target);}
  else if(options.method==='GET'&&u.pathname==='/2/tweets/'+data.root.id){data.lookupCalls++;result=lookupResponse(data.root);}
  else if(u.pathname==='/2/users/4242/mentions')result=typeof data.mentions==='function'?data.mentions(u):data.mentions;
  else return undefined;
  return response(data.mutate?data.mutate(result,u):result);
 };
 return {...h,data};
}
