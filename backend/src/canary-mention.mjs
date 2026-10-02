import { extractMentions } from './twitter-text-vendor.mjs';
import { assert } from './security.mjs';
import { UUID_V4 } from './write-policy.mjs';
import { CREDIT_RUN_DEADLINE } from './credit-policy.mjs';

// A server-operator provisioned one-time exception, never a caller allowlist.
// No production recipient, payload, key or default activation is bundled here.
export function hasExactSingleMention(text,handle) {
  if(typeof text!=='string'||typeof handle!=='string'||!/^@[a-z0-9_]{1,15}$/.test(handle)
    ||text.includes('＠')||(text.match(/@/g)??[]).length!==1)return false;
  const i=text.indexOf(handle);
  const mentions=extractMentions(text);
  return mentions.length===1&&mentions[0]===handle.slice(1)&&i>=0&&(i===0||/\s/u.test(text[i-1]))
    &&(i+handle.length===text.length||!/[a-zA-Z0-9_]/u.test(text[i+handle.length]));
}
export async function canaryMentionAuthorization(name,args,env,now) {
  if(typeof args?.text!=='string'||!/[@＠]/u.test(args.text))return null;
  assert(name==='x_create_original_post','MENTIONS_NOT_SUPPORTED');
  const key=env.X_CANARY_MENTION_IDEMPOTENCY_KEY,hash=env.X_CANARY_MENTION_TEXT_SHA256,
    deadline=env.X_CANARY_MENTION_EXPIRES_AT,handle=env.X_CANARY_MENTION_HANDLE;
  assert(typeof key==='string'&&UUID_V4.test(key)&&typeof hash==='string'&&/^[a-f0-9]{64}$/.test(hash)
    &&typeof deadline==='string'&&/^[1-9][0-9]{0,9}$/.test(deadline)
    &&Number.isSafeInteger(Number(deadline))&&Number(deadline)<=CREDIT_RUN_DEADLINE
    &&typeof handle==='string'&&/^@[a-z0-9_]{1,15}$/.test(handle),'CANARY_MENTION_NOT_CONFIGURED',403);
  assert(Number.isFinite(now)&&now<Number(deadline),'CANARY_MENTION_EXPIRED',403);
  assert(args.idempotency_key===key&&args.text===args.text.normalize('NFC')
    &&hasExactSingleMention(args.text,handle),'CANARY_MENTION_INTENT_MISMATCH',403);
  const actual=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(args.text))),
    value=>value.toString(16).padStart(2,'0')).join('');
  assert(actual===hash,'CANARY_MENTION_INTENT_MISMATCH',403);
  return {key,hash,handle,expires:Number(deadline)};
}
