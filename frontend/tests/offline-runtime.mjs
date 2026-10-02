// Supported Miniflare controls: no Cloudflare cf.json metadata or telemetry requests.
// The host-side Undici dispatcher additionally rejects every non-loopback connection.
// Worker API requests are separately intercepted by each test's outboundService.
import {MockAgent,setGlobalDispatcher} from 'undici';
process.env.CLOUDFLARE_CF_FETCH_ENABLED = 'false';
process.env.WRANGLER_SEND_METRICS = 'false';
const hostNetwork = new MockAgent();
hostNetwork.disableNetConnect();
hostNetwork.enableNetConnect(host => /^(?:127\.0\.0\.1|localhost|\[::1\])(?::[0-9]+)?$/.test(host));
setGlobalDispatcher(hostNetwork);
export const OFFLINE_RUNTIME_OPTIONS = {cf:false,telemetry:{enabled:false}};
