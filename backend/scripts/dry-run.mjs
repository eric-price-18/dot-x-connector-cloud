import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
if (process.argv.length > 2) throw new Error('Dry-run accepts no arguments');
const config='wrangler.jsonc', outdir='dist/runtime-check';
await mkdir('.tools/wrangler-isolated-home', { recursive: true });
// Inherit only OS execution necessities, never Cloudflare credentials or NODE_OPTIONS.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP)$/i.test(key)));
Object.assign(env, {
  CI: 'true', NO_COLOR: '1', WRANGLER_SEND_METRICS: 'false', DO_NOT_TRACK: '1',
  WRANGLER_SEND_ERROR_REPORTS: 'false', WRANGLER_NO_SKILLS_UPDATE_PROMPTS: 'true',
  CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false',
  XDG_CONFIG_HOME: resolve('.tools/wrangler-config'),
  XDG_CACHE_HOME: resolve('.tools/wrangler-cache'),
  WRANGLER_LOG_PATH: resolve('.tools/wrangler-logs'),
  WRANGLER_CACHE_DIR: resolve('.tools/wrangler-cache')
});
env.PATH = `${dirname(process.execPath)}${process.platform === 'win32' ? ';' : ':'}${env.PATH ?? env.Path ?? ''}`;
const args = ['--require', resolve('scripts/offline-wrangler-guard.cjs'),
  resolve('node_modules/wrangler/bin/wrangler.js'), 'deploy', '--dry-run',
  '--config', config, '--outdir', outdir];
const child = spawn(process.execPath, args, { cwd: root, env, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
let output = '';
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk; process.stdout.write(chunk); });
child.on('error', error => { throw error; });
const status = await new Promise(resolve => child.on('close', resolve));
await writeFile(resolve(outdir, 'dry-run.txt'), output.replace(/\u001b\[[0-9;]*m/g, ''));
process.exitCode = status ?? 1;
