import twitterText from 'twitter-text';

// Server-owned controls. No request parameter, header, or browser preference can enable writes.
export const WRITE_ENDPOINT = 'https://backend.example.invalid/service/write/mcp';
export const WRITE_PATH = '/service/write/mcp';
export const REPLY_OPT_OUT_NOTICE = 'Reply STOP to opt out.';
// Platform policy and any required written approval must be checked before enabling replies.
// Backend-owned eligibility/opt-out/one-interaction checks remain mandatory.
export const MUTATIONS = new Set(['x_create_original_post', 'x_repost', 'x_reply']);
export const WRITE_NAMES = new Set([...MUTATIONS, 'x_get_write_status']);
export const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// Current X API contract: https://docs.x.com/x-api/users/repost-post
// Keep IDs as strings; the documented API domain is 1–19 digits.
export const POST_ID = /^[1-9][0-9]{0,18}$/;
export const isPostId = value => typeof value === 'string' && POST_ID.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

export function writeEnabled(name, env = {}) {
 if (name === 'x_get_write_status') return env.X_WRITE_STATUS_ENABLED === 'true';
 if (name === 'x_create_original_post') return env.X_ORIGINAL_POSTS_ENABLED === 'true';
 if (name === 'x_repost') return env.X_REPOSTS_ENABLED === 'true';
 return name === 'x_reply' && env.X_OWN_THREAD_REPLIES_ENABLED === 'true';
}

export function validateWriteArguments(name, args) {
 return validateArguments(name, args, false);
}

// This single-request exception is server configuration, never an MCP argument or header.
// The backend additionally persists an immutable singleton claim before dispatch.
export const CANARY_DEADLINE = Date.parse('2000-01-02T08:00:00Z')/1000; // Deliberately expired public example, never a current authorization.
export async function validateConfiguredWriteArguments(name, args, env = {}, now = Math.floor(Date.now() / 1000)) {
 let allowed = false;
 if (name === 'x_create_original_post' && object(args) && typeof args.text === 'string' && args.text.length <= 4096) {
  const key = env.X_CANARY_MENTION_IDEMPOTENCY_KEY;
  const hash = env.X_CANARY_MENTION_TEXT_SHA256;
  const expiry = env.X_CANARY_MENTION_EXPIRES_AT;
  const handle = env.X_CANARY_MENTION_HANDLE;
  if (typeof handle === 'string' && /^@[a-z0-9_]{1,15}$/.test(handle) && typeof key === 'string' && UUID_V4.test(key) && args.idempotency_key === key && typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash) && typeof expiry === 'string' && /^[1-9][0-9]{0,9}$/.test(expiry) && Number.isSafeInteger(now) && now >= 0 && now < Number(expiry) && Number(expiry) <= CANARY_DEADLINE) {
   const mentions = twitterText.extractMentions(args.text);
   if (mentions.length === 1 && mentions[0] === handle.slice(1) && new RegExp('(?:^|\\s)' + handle + '(?![A-Za-z0-9_])').test(args.text) && args.text.split('@').length === 2 && !args.text.includes('＠')) {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(args.text));
    allowed = Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, '0')).join('') === hash;
   }
  }
 }
 return validateArguments(name, args, allowed);
}

function validateArguments(name, args, allowedCanaryMention) {
 if (!WRITE_NAMES.has(name)) return {ok:false, reason:'unknown_write_tool'};
 const fields = name === 'x_repost' ? ['post_id','idempotency_key'] : name === 'x_get_write_status' ? ['idempotency_key'] : name === 'x_reply' ? ['text','in_reply_to_post_id','idempotency_key'] : ['text','idempotency_key'];
 if (!exact(args, fields) || typeof args.idempotency_key !== 'string' || !UUID_V4.test(args.idempotency_key)) return {ok:false, reason:'invalid_write_arguments'};
 if (name === 'x_repost' && !isPostId(args.post_id)) return {ok:false, reason:'invalid_post_id'};
 if (name === 'x_reply' && !isPostId(args.in_reply_to_post_id)) return {ok:false, reason:'invalid_reply_target'};
 if ('text' in args) {
  // Never trim/normalize a user's intended publication behind their back. NFC is required explicitly.
  if (typeof args.text !== 'string' || !args.text.trim() || args.text.length > 4096 || args.text !== args.text.normalize('NFC') || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069\ud800-\udfff]/u.test(args.text)) return {ok:false, reason:'invalid_post_text'};
  const parsed = twitterText.parseTweet(args.text);
  if (!parsed.valid || parsed.weightedLength > 280) return {ok:false, reason:'post_text_exceeds_limit'};
  // Original-post automation cannot become unsolicited mention/reply automation through its text.
  // Replies carry a server-validated target; text mentions are intentionally unavailable there too.
  if (!allowedCanaryMention && (twitterText.extractMentions(args.text).length || /[@＠]/u.test(args.text))) return {ok:false, reason:'mentions_not_supported'};
  for (const match of twitterText.extractUrlsWithIndices(args.text)) {
   let url;
   try {url = new URL(/^https?:\/\//i.test(match.url) ? match.url : 'https://' + match.url);} catch {return {ok:false,reason:'invalid_post_text'};}
   const host = url.hostname.toLowerCase().replace(/\.$/,'');
   let path; try {path = decodeURIComponent(url.pathname);} catch {return {ok:false,reason:'invalid_post_text'};}
   if (host === 't.co' || ((host === 'x.com' || host.endsWith('.x.com') || host === 'twitter.com' || host.endsWith('.twitter.com')) && /(?:^|\/)(?:status|statuses)\/[0-9]+(?:\/|$)/i.test(path))) return {ok:false, reason:'quote_links_not_supported'};
  }
  if (name === 'x_reply' && !args.text.endsWith(REPLY_OPT_OUT_NOTICE)) return {ok:false,reason:'reply_opt_out_notice_required'};
 }
 const normalized = Object.fromEntries(fields.map(key => [key, args[key]]));
 return {ok:true, args:normalized};
}

const keySchema = {type:'string', pattern:UUID_V4.source, description:'A new lowercase UUID v4 for a new intent. Retain this key after any timeout. Never change it to retry an uncertain publication.'};
const textSchema = {type:'string',minLength:1,maxLength:4096,description:'Exact NFC text, at most 280 X-weighted characters. No general mentions, quote/reply parameters, private information, or identifying the user. A server-configured exact one-time original canary may include only its approved recipient.'};
const postIdSchema = {type:'string',pattern:POST_ID.source,description:'Canonical positive decimal ID, 1–19 digits per X API. Never convert to a JavaScript Number.'};
const descriptors = [
 {name:'x_create_original_post',description:'Publish one low-impact original text post as @example_dot_bot. Requires active server approval. No replies, general mentions, quotes, media, private user information, or commitments. Only a server-configured exact one-time canary may include its approved recipient. On unknown/pending outcome use x_get_write_status; never resend or change the key.',inputSchema:{type:'object',properties:{text:textSchema,idempotency_key:keySchema},required:['text','idempotency_key'],additionalProperties:false}},
 {name:'x_repost',description:'Repost one public post as @example_dot_bot, within the backend daily cap. Review the post first. No quote text or bulk reposting. On unknown/pending outcome use x_get_write_status; never resend or change the key.',inputSchema:{type:'object',properties:{post_id:postIdSchema,idempotency_key:keySchema},required:['post_id','idempotency_key'],additionalProperties:false}},
 {name:'x_reply',description:'Reply as @example_dot_bot only to a person directly replying to one of the account’s original root posts. The backend must verify target/root ownership, honor opt-outs, and permit at most one automated reply per interaction. End exact text with "Reply STOP to opt out." inside the 280-weighted-character limit. No extra mentions, quotes, or unrelated targets. Preserve the original idempotency key; never resend an unknown outcome.',inputSchema:{type:'object',properties:{text:textSchema,in_reply_to_post_id:postIdSchema,idempotency_key:keySchema},required:['text','in_reply_to_post_id','idempotency_key'],additionalProperties:false}},
 {name:'x_get_write_status',description:'Read a durable write receipt by its original idempotency key. Never sends or retries a post and never contacts X. Not-found is not permission to retry an uncertain send.',inputSchema:{type:'object',properties:{idempotency_key:keySchema},required:['idempotency_key'],additionalProperties:false}}
];
export function discoverWriteTools(env = {}) {
 return descriptors.filter(tool => writeEnabled(tool.name, env)).map(tool => ({...tool, annotations:{readOnlyHint:tool.name==='x_get_write_status',destructiveHint:tool.name!=='x_get_write_status',idempotentHint:true,openWorldHint:tool.name!=='x_get_write_status'}}));
}

export function normalizeWriteReceipt(name, args, value) {
 if (!object(value) || !Object.keys(value).every(key => ['version','operation','idempotency_key','state','code','post_id'].includes(key))) return null;
 if (value.version !== 1 || value.idempotency_key !== args.idempotency_key || !['pending','succeeded','rejected','unknown','not_found'].includes(value.state) || typeof value.code !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(value.code)) return null;
 if (value.state === 'not_found') {if (name !== 'x_get_write_status' || value.operation !== null || 'post_id' in value) return null;}
 else if (!MUTATIONS.has(value.operation) || (name !== 'x_get_write_status' && value.operation !== name)) return null;
 if (value.state === 'succeeded') {if (!isPostId(value.post_id)) return null;}
 else if ('post_id' in value) return null;
 if (name === 'x_repost' && value.state === 'succeeded' && value.post_id !== args.post_id) return null;
 return {...value, safe_to_retry:false};
}
