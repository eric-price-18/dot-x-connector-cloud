import { env } from 'cloudflare:workers';
import { handleMcp } from '../../lib/x-mcp.mjs';
export const dynamic = 'force-dynamic';
export const POST = (request: Request) => handleMcp(request, env.DB, env);
export function GET() { return new Response(null, { status: 405, headers: { Allow: 'POST', 'Cache-Control': 'no-store' } }); }
