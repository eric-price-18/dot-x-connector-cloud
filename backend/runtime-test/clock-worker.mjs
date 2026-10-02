// TEST ONLY ENTRY POINT. Never used by Wrangler or imported by production code.
// The local harness advances time explicitly; no real wall-clock wait is needed.
import { createWorker } from '../src/worker.mjs';
import { RUNTIME_NOW, CLOCK_CONTROL_PATH } from './clock-fixture.mjs';
let now=RUNTIME_NOW;
const worker=createWorker({clock:()=>now});
export default {
  async fetch(request,env,ctx) {
    if(new URL(request.url).pathname===CLOCK_CONTROL_PATH) {
      const next=Number(await request.text());
      if(request.method!=='POST'||!Number.isSafeInteger(next)||next<now)
        return new Response('Invalid synthetic test clock',{status:400});
      now=next;
      return new Response(null,{status:204});
    }
    return worker.fetch(request,env,ctx);
  },
  scheduled(event,env,ctx) {return worker.scheduled(event,env,ctx);}
};
