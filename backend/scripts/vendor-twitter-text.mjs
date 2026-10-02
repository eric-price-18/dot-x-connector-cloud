import { build } from 'esbuild';
import { readFile, copyFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
assert.equal(JSON.parse(await readFile('node_modules/twitter-text/package.json','utf8')).version,'3.1.0');
// Workers/Node natively implement these ES2015 functions. Do not ship global
// core-js 2 polyfills into workerd; parsing logic and Unicode tables are unchanged.
await build({stdin:{contents:"export {default as parseTweet} from 'twitter-text/dist/esm/parseTweet.js'; export {default as extractUrlsWithIndices} from 'twitter-text/dist/esm/extractUrlsWithIndices.js'; export {default as extractMentions} from 'twitter-text/dist/esm/extractMentions.js';",resolveDir:process.cwd()},
 bundle:true,format:'esm',platform:'browser',target:'es2022',minify:true,
 outfile:'src/twitter-text-vendor.mjs',legalComments:'inline',
 banner:{js:'// Generated from official twitter-text 3.1.0. See vendor/README.md. Do not edit.\n// Copyright 2018 Twitter, Inc. Licensed under the Apache License, Version 2.0.\n// https://www.apache.org/licenses/LICENSE-2.0\n// Modified bundle: selected exports, tree shaking/minification, and omitted native ES2015 polyfills.'},
 plugins:[{name:'native-es2015',setup(b){b.onResolve({filter:/^core-js\//},args=>({path:args.path,namespace:'native-es2015'}));b.onLoad({filter:/.*/,namespace:'native-es2015'},()=>({contents:'',loader:'js'}));}}]});
await mkdir('vendor',{recursive:true});
await copyFile('node_modules/twitter-text/LICENSE','vendor/twitter-text-LICENSE');
await copyFile('node_modules/twemoji-parser/LICENSE.md','vendor/twemoji-parser-LICENSE.md');

await copyFile('node_modules/punycode/LICENSE-MIT.txt','vendor/punycode-LICENSE-MIT.txt');
await copyFile('node_modules/@babel/runtime/LICENSE','vendor/babel-runtime-LICENSE');
