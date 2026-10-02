import { requireChatGPTUser, chatGPTSignOutPath } from './chatgpt-auth';
import SetupPanel from './setup-panel';
import { env } from 'cloudflare:workers';
import { writeEnabled } from '../lib/write-contract.mjs';
export const dynamic = 'force-dynamic';
export default async function Home() {
 const user=await requireChatGPTUser('/');
 if(user.email.trim().toLowerCase()!=='owner@example.invalid')return <main><h1>Owner access only</h1><p>This connection is private.</p></main>;
 const capabilities={posts:writeEnabled('x_create_original_post',env),reposts:writeEnabled('x_repost',env),ownReplies:writeEnabled('x_reply',env)};
 return <main><header><span className="mark">X</span><span>DOT X CONNECTOR</span></header><h1>Your private X connection</h1><p className="lead">Cached reads and separately controlled publishing for the configured account.</p><SetupPanel capabilities={capabilities}/><footer><span>Owner-only · Separate read and write controls</span><a href={chatGPTSignOutPath()}>Sign out</a></footer></main>;
}
