import { parseTweet, extractUrlsWithIndices } from './twitter-text-vendor.mjs';
import { assert } from './security.mjs';
import { canaryMentionAuthorization, hasExactSingleMention } from './canary-mention.mjs';
import { WRITE_NAMES, UUID_V4, exactKeys } from './write-policy.mjs';

// X documents IDs as decimal strings of 1–19 digits; never use Number.
// https://docs.x.com/x-api/users/repost-post
export const isPostId = value => typeof value==='string' && /^[1-9][0-9]{0,18}$/.test(value);
export function validatePostText(text,{canaryHandle}={}) {
  assert(typeof text==='string' && text.trim() && text.length<=4096 && text===text.normalize('NFC')
    && !/[\uD800-\uDFFF\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(text), 'INVALID_POST_TEXT');
  const parsed=parseTweet(text);
  assert(parsed.valid && parsed.weightedLength<=280,'POST_TEXT_EXCEEDS_LIMIT');
  assert(!/[@＠]/u.test(text)||(canaryHandle&&hasExactSingleMention(text,canaryHandle)),'MENTIONS_NOT_SUPPORTED');
  for(const entity of extractUrlsWithIndices(text)) {
    const url=new URL(/^https?:\/\//i.test(entity.url)?entity.url:'https://'+entity.url);
    const host=url.hostname.toLowerCase().replace(/\.$/,'');
    assert(host!=='t.co' && !host.endsWith('.t.co'),'QUOTE_LINKS_NOT_SUPPORTED');
    let path;try{path=decodeURIComponent(url.pathname);}catch{path=url.pathname;}
    assert(!((host==='x.com'||host.endsWith('.x.com')||host==='twitter.com'||host.endsWith('.twitter.com'))
      && /\/(?:status|statuses)\/\d+(?:[/?#]|$)/i.test(path)), 'QUOTE_LINKS_NOT_SUPPORTED');
  }
  return text;
}
export function validateWriteArguments(name,args,options={}) {
  assert(WRITE_NAMES.has(name),'UNKNOWN_WRITE_TOOL');
  const fields=name==='x_repost'?['post_id','idempotency_key']:name==='x_get_write_status'?['idempotency_key']:
    name==='x_reply'?['text','in_reply_to_post_id','idempotency_key']:['text','idempotency_key'];
  assert(exactKeys(args,fields) && typeof args.idempotency_key==='string' && UUID_V4.test(args.idempotency_key),'INVALID_WRITE_ARGUMENTS');
  if(name==='x_repost') assert(isPostId(args.post_id),'INVALID_POST_ID');
  if(name==='x_reply') assert(isPostId(args.in_reply_to_post_id),'INVALID_REPLY_TARGET');
  if('text' in args) validatePostText(args.text,name==='x_create_original_post'?options:{});
  return Object.fromEntries(fields.map(key=>[key,args[key]]));
}

export async function validateConfiguredWriteArguments(name,args,env,nowSeconds) {
  const canary=await canaryMentionAuthorization(name,args,env,nowSeconds);
  return validateWriteArguments(name,args,canary?{canaryHandle:canary.handle}:{});
}
