// Connector-only wrapper: preserve the generated platform worker and its trusted authentication.
import {handleSetup} from '../lib/setup-api.mjs';
type Handler<E,C>={fetch(request:Request,env:E,ctx:C):Promise<Response>|Response};
export function withConnectorSetup<E extends {DB?:D1Database},C>(worker:Handler<E,C>):Handler<E,C> {
 return {async fetch(request,env,ctx){
  const response=new URL(request.url).pathname==='/api/service-setup'
   ?await handleSetup(request,env.DB):await worker.fetch(request,env,ctx);
  const headers=new Headers(response.headers);
  headers.set('X-Frame-Options','DENY');
  headers.append('Content-Security-Policy',"frame-ancestors 'none'");
  headers.set('Referrer-Policy','no-referrer');
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
 }};
}
