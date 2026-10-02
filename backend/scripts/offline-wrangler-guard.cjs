// Loaded only by the local dry-run child process, never by the deployed Worker.
const { syncBuiltinESMExports } = require('node:module');
const os = require('node:os');
const net = require('node:net');
const tls = require('node:tls');
const path = require('node:path');
os.homedir = () => path.resolve('.tools/wrangler-isolated-home');
const denied = () => { throw new Error('Network is disabled for this Wrangler dry-run'); };
globalThis.fetch = async () => denied();
net.Socket.prototype.connect = denied;
net.connect = net.createConnection = denied;
tls.connect = denied;
syncBuiltinESMExports();
