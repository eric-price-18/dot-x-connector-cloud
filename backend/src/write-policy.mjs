// Requires a reviewed code change after prior written explicit approval from X,
// plus opt-in, opt-out and one-reply-per-interaction controls. Env cannot enable it.
export const REPLY_DEPLOYMENT_APPROVED = false;
export const WRITE_PATH = '/service/write/mcp';
export const WRITE_AUDIENCE = 'https://backend.example.invalid'+WRITE_PATH;
export const WRITE_NAMES = new Set(['x_create_original_post','x_repost','x_reply','x_get_write_status']);
export const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const POST_ID = /^[1-9][0-9]{0,18}$/;
export const exactKeys = (value, keys) => value && typeof value==='object' && !Array.isArray(value)
  && Object.keys(value).length===keys.length && keys.every(key=>Object.hasOwn(value,key));
export const writeScope = operation => operation==='x_get_write_status'?'x:write:status':operation==='x_reply'?'x:reply':'x:write';
