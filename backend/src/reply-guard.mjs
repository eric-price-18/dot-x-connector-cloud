import { assert } from './security.mjs';
import { isPostId } from './write-validation.mjs';

export const MAX_REPLY_ANCESTORS=4;
export const REPLY_PREFLIGHT_MICROUSD=490000+MAX_REPLY_ANCESTORS*60000;
export const OPT_OUT_NOTICE='Reply STOP to opt out.';
export function optOutSignal(text) {
  if(typeof text!=='string')return false;
  const s=text.normalize('NFKC').toLowerCase().replace(/[\u200b-\u200f\ufeff]/g,'').replace(/[’‘`]/g,"'").replace(/\s+/g,' ');
  return /\b(?:stop|unsubscribe|opt(?:\s+me)?[\s-]*out|(?:do not|don't|dont|never)(?:\s+(?:ever|again|automatically|please)){0,3}\s+(?:reply|respond|contact|message|engage|interact)|(?:do not|don't|dont|never)\s+send(?:\s+me)?\s+(?:replies|responses|messages)|no\s+(?:more\s+)?(?:replies|responses|bots)|leave\s+me\s+alone)\b/u.test(s);
}
const noErrors=value=>value?.errors===undefined || (Array.isArray(value.errors)&&value.errors.length===0);
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
function expansionBounds(result,maxPosts,maxUsers) {
  assert(result.includes===undefined||object(result.includes),'REPLY_LOOKUP_INVALID',502);
  for(const [kind,records] of Object.entries(result.includes??{}))
    assert((kind==='posts'||kind==='users')&&Array.isArray(records)&&records.length<=(kind==='posts'?maxPosts:maxUsers),
      'REPLY_EXPANSION_INVALID',502);
}
function references(post) {
  assert(!Object.hasOwn(post,'referenced_tweets')&&!Object.hasOwn(post,'edit_history_tweet_ids'),'REPLY_LOOKUP_DIALECT_UNVERIFIED',502);
  assert(post.referenced_posts===undefined||Array.isArray(post.referenced_posts),'REPLY_LOOKUP_INVALID',502);
  return post.referenced_posts??[];
}
function singleHistory(post) {
  assert(Array.isArray(post.edit_history_post_ids)&&post.edit_history_post_ids.length===1&&post.edit_history_post_ids[0]===post.id,
    'EDITED_OR_UNVERIFIED_INTERACTION',403);
}
function participants(post,account,parentUser) {
  assert(post.entities===undefined||object(post.entities),'REPLY_LOOKUP_INVALID',502);
  const allowed=new Map([[account,'example_dot_bot']]);
  if(parentUser && /^[A-Za-z0-9_]{1,15}$/.test(parentUser.username??''))allowed.set(parentUser.id,parentUser.username.toLowerCase());
  const mentions=post.entities?.mentions??[];
  assert(Array.isArray(mentions)&&mentions.every(v=>object(v)&&allowed.has(v.id)), 'MULTIPARTY_REPLY_NOT_SUPPORTED',403);
  // Visible handles must match fresh identity proof AND a returned mention ID.
  const visible=post.text.match(/[@＠][A-Za-z0-9_]+/g)??[];
  assert(visible.every(v=>v[0]==='@'&&mentions.some(m=>allowed.get(m.id)===v.slice(1).toLowerCase()))
    &&visible.length<=mentions.length,'MULTIPARTY_REPLY_NOT_SUPPORTED',403);
}
function replyParent(post) {
  const refs=references(post);
  assert(refs.length===1&&object(refs[0])&&refs[0].type==='replied_to'&&isPostId(refs[0].id),'REPLY_NOT_DIRECT_TO_OWN_ROOT',403);
  return refs[0].id;
}

export class ReplyGuard {
  constructor(env,store,clock) {this.env=env;this.store=store;this.clock=clock;this.account=env.SERVICE_X_ACCOUNT_ID;this.authors=new Map();}
  async checkUnclaimed(args) {
    assert(!await this.store.first('SELECT target_id FROM reply_interactions WHERE account_id=? AND target_id=?',
      this.account,args.in_reply_to_post_id),'REPLY_INTERACTION_ALREADY_CLAIMED',409);
  }
  async ingest(record) {
    if(record.author_id!==this.account&&optOutSignal(record.text)) {
      await this.store.run(`INSERT INTO reply_opt_outs(account_id,author_id,source_post_id,created_at)
        VALUES(?,?,?,?) ON CONFLICT DO NOTHING`,this.account,record.author_id,record.id,this.clock());
      return true;
    }
    return false;
  }
  async rejectOptOut(author) {
    assert(!await this.store.first('SELECT author_id FROM reply_opt_outs WHERE account_id=? AND author_id=?',this.account,author),
      'REPLY_AUTHOR_OPTED_OUT',403);
  }
  async lookup(x,token,id) {
    const query=new URLSearchParams({'post.fields':'author_id,conversation_id,in_reply_to_user_id,referenced_posts,edit_history_post_ids,created_at,entities,text,possibly_sensitive,withheld,note_post',expansions:'author_id,referenced_posts','user.fields':'protected,username'});
    // One main post, at most three direct references and all four authors.
    // Reserve worst-case standard pricing: 4*$0.005 + 4*$0.010 = $0.060.
    const result=await x.request(`/2/tweets/${id}?${query}`,{token,records:4,creditMicroUsd:60000});
    assert(object(result.data),'REPLY_LOOKUP_INVALID',502);
    const post=result.data;
    assert(post.id===id&&isPostId(post.author_id)&&typeof post.text==='string'&&post.text.length<=20000,'REPLY_LOOKUP_INVALID',502);
    await this.ingest(post);
    assert(noErrors(result),'REPLY_LOOKUP_INVALID',502);expansionBounds(result,3,4);
    assert(post.id===id&&isPostId(post.author_id)&&isPostId(post.conversation_id)&&typeof post.text==='string'
      &&post.text.length<=20000&&typeof post.created_at==='string'&&post.created_at.length<=40&&/^\d{4}-\d{2}-\d{2}T/.test(post.created_at)&&Number.isFinite(Date.parse(post.created_at)), 'REPLY_LOOKUP_INVALID',502);
    const users=result.includes?.users;
    assert(Array.isArray(users)&&users.every(v=>object(v)&&isPostId(v.id)&&typeof v.protected==='boolean')
      &&new Set(users.map(v=>v.id)).size===users.length&&users.filter(v=>v.id===post.author_id).length===1
      &&users.find(v=>v.id===post.author_id).protected===false,'PUBLIC_REPLY_AUTHOR_UNVERIFIED',403);
    assert(post.possibly_sensitive===undefined||typeof post.possibly_sensitive==='boolean','REPLY_LOOKUP_INVALID',502);
    assert(post.possibly_sensitive!==true && post.withheld===undefined,'SENSITIVE_REPLY_NOT_SUPPORTED',403);
    assert(post.note_post===undefined && post.note_tweet===undefined,'LONG_FORM_REPLY_NOT_SUPPORTED',403);
    this.authors.set(post.author_id,users.find(v=>v.id===post.author_id));
    references(post);singleHistory(post);return post;
  }
  async catchUp(x,token) {
    const now=this.clock();
    const state=await this.store.first(`INSERT INTO reply_opt_out_scans
      (account_id,generation,locked_until,completed_at) VALUES(?,1,?,0)
      ON CONFLICT(account_id) DO UPDATE SET generation=reply_opt_out_scans.generation+1,locked_until=excluded.locked_until
      WHERE reply_opt_out_scans.locked_until<=? RETURNING *`,this.account,now+90,now);
    assert(state,'REPLY_OPT_OUT_SCAN_IN_PROGRESS',409);
    const generation=state.generation;
    try {
      assert((!state.since_id||isPostId(state.since_id))&&(!state.highwater||isPostId(state.highwater))
        &&(!state.next_token||(typeof state.next_token==='string'&&state.next_token.length<=2048)),'REPLY_OPT_OUT_SCAN_INVALID',503);
      let cursor=state.next_token??null,newest=state.highwater??state.since_id??null;
      const resumed=Boolean(cursor);
      for(let page=0;page<2;page++) {
        const params=new URLSearchParams({max_results:'5','post.fields':'text,created_at',expansions:'author_id'});
        if(state.since_id)params.set('since_id',state.since_id);
        if(cursor)params.set('pagination_token',cursor);
        const result=await x.request(`/2/users/${this.account}/mentions?${params}`,{token,records:5,creditMicroUsd:75000});
        assert(noErrors(result)&&object(result.meta),'REPLY_OPT_OUT_SCAN_INVALID',502);expansionBounds(result,0,5);
        const rows=result.data??[];
        assert(Array.isArray(rows)&&rows.length<=5&&result.meta.result_count===rows.length&&rows.every(v=>object(v)
          &&isPostId(v.id)&&isPostId(v.author_id)&&typeof v.text==='string'&&v.text.length<=20000),'REPLY_OPT_OUT_SCAN_INVALID',502);
        for(const record of rows) {
          await this.ingest(record);
          if(!newest||BigInt(record.id)>BigInt(newest))newest=record.id;
        }
        const next=result.meta.next_token;
        assert(next===undefined||(typeof next==='string'&&next.length>0&&next.length<=2048),'REPLY_OPT_OUT_SCAN_INVALID',502);
        assert(!next||next!==cursor,'REPLY_OPT_OUT_SCAN_INCOMPLETE',409);
        const complete=!next;
        const saved=await this.store.first(`UPDATE reply_opt_out_scans SET since_id=?,next_token=?,highwater=?,completed_at=?
          WHERE account_id=? AND generation=? AND locked_until>? RETURNING account_id`,
          complete?newest:state.since_id,next??null,complete?null:newest,complete&&!resumed?this.clock():0,
          this.account,generation,this.clock());
        assert(saved,'REPLY_OPT_OUT_SCAN_SUPERSEDED',409);
        if(complete) {
          // A resumed historical scan must finish, then a later bounded fresh
          // scan checks newer mentions before any reply can become eligible.
          assert(!resumed,'REPLY_OPT_OUT_FRESH_SCAN_REQUIRED',409);
          return;
        }
        cursor=next;
      }
      assert(false,'REPLY_OPT_OUT_SCAN_INCOMPLETE',409);
    } finally {
      await this.store.run('UPDATE reply_opt_out_scans SET locked_until=0 WHERE account_id=? AND generation=?',this.account,generation);
    }
  }
  async verify(x,token,args) {
    const target=await this.lookup(x,token,args.in_reply_to_post_id);
    // Ingest STOP before eligibility, including nested or otherwise rejected posts.
    await this.ingest(target);await this.rejectOptOut(target.author_id);
    assert(target.author_id!==this.account,'SELF_REPLY_NOT_SUPPORTED',403);
    assert(target.id!==target.conversation_id,'REPLY_ANCESTRY_INVALID',403);
    replyParent(target);
    const root=await this.lookup(x,token,target.conversation_id);
    assert(root.author_id===this.account&&root.id===root.conversation_id&&references(root).length===0
      &&!root.in_reply_to_user_id,'REPLY_ROOT_NOT_OWN_ORIGINAL',403);
    participants(root,this.account);
    const created=Date.parse(target.created_at)/1000,rootCreated=Date.parse(root.created_at)/1000;
    assert(created<=this.clock()+5&&created>=this.clock()-86400&&rootCreated<=created,'REPLY_TARGET_NOT_RECENT',403);
    let child=target,depth=0;
    const seen=new Set([target.id]);
    while(child.id!==root.id) {
      const parentId=replyParent(child);
      assert(!seen.has(parentId),'REPLY_ANCESTRY_INVALID',403);
      assert(parentId===root.id||depth<MAX_REPLY_ANCESTORS,'REPLY_ANCESTRY_LIMIT',403);
      const parent=parentId===root.id?root:await this.lookup(x,token,parentId);
      if(parentId!==root.id)depth++;
      assert(parent.conversation_id===root.id
        &&(child.in_reply_to_user_id===undefined||child.in_reply_to_user_id===parent.author_id)
        &&Date.parse(parent.created_at)<=Date.parse(child.created_at)
        &&Date.parse(parent.created_at)>=Date.parse(root.created_at),'REPLY_ANCESTRY_INVALID',403);
      participants(child,this.account,this.authors.get(parent.author_id));
      seen.add(parentId);child=parent;
    }
    await this.catchUp(x,token);await this.rejectOptOut(target.author_id);
    return {author:target.author_id,target:target.id,root:root.id,key:args.idempotency_key};
  }
  async claimDispatch(binding,grantVersion,interaction,keyHash,sendHash) {
    // Atomic, permanent dispatch claims are created only after confirmed
    // preflight success. Failed preflight consumes the UUID, not the target.
    const results=await this.store.db.batch([
      this.store.statement(`INSERT INTO reply_interactions(account_id,target_id,idempotency_key,author_id,root_id,created_at)
        SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM accounts WHERE id='primary' AND issuer=? AND subject=? AND x_user_id=?
          AND version=? AND refresh_status='idle' AND expires_at>?)
        AND NOT EXISTS(SELECT 1 FROM reply_opt_outs WHERE account_id=? AND author_id=?)
        AND EXISTS(SELECT 1 FROM reply_opt_out_scans WHERE account_id=? AND next_token IS NULL AND locked_until=0 AND completed_at>=?)
        AND EXISTS(SELECT 1 FROM service_writes WHERE idempotency_key=? AND operation='x_reply' AND state='pending')
        ON CONFLICT DO NOTHING`,
        this.account,interaction.target,interaction.key,interaction.author,interaction.root,this.clock(),
        binding.issuer,binding.subject,binding.account,grantVersion,this.clock(),this.account,interaction.author,
        this.account,this.clock()-30,interaction.key),
      this.store.statement(`INSERT INTO sends(idempotency_hash,payload_hash,status,created_at)
        SELECT ?,?,'pending',? WHERE EXISTS(SELECT 1 FROM reply_interactions WHERE account_id=? AND target_id=? AND idempotency_key=?)
        ON CONFLICT DO NOTHING`,keyHash,sendHash,this.clock(),this.account,interaction.target,interaction.key)
    ]);
    assert(results.length===2&&results.every(r=>r.success!==false&&r.meta?.changes===1),
      'REPLY_DISPATCH_CLAIM_DENIED',409);
  }
}
