# Pinned text parser and third-party notices

`../src/twitter-text-vendor.mjs` is generated from official `twitter-text` 3.1.0
parsing code, Unicode ranges, URL recognition and `twemoji-parser` emoji tables.
The exact dependency graph and npm integrity values are in `../package-lock.json`.
This bundle runs locally and performs no network operations.

Rebuild from the backend directory with `npm ci --ignore-scripts --no-audit
--no-fund`, then `npm run vendor:rebuild`. The script imports only `parseTweet`,
`extractUrlsWithIndices` and `extractMentions`, tree-shakes/minifies with directly declared,
pinned esbuild 0.28.1 and omits core-js global polyfills for ES2015 functions
already provided natively by workerd and Node. Parser logic is unchanged.

The bundle preserves the upstream source attribution, Copyright 2018 Twitter, Inc.,
and explicitly identifies its bundling modifications. The upstream LICENSE file
also retains its original Copyright 2011 Twitter, Inc. notice.

Retained notices apply independently of the project's MIT license:

- twitter-text: Apache-2.0, `twitter-text-LICENSE`
- twemoji-parser: MIT, `twemoji-parser-LICENSE.md`
- punycode: MIT, `punycode-LICENSE-MIT.txt`
- @babel/runtime: MIT, `babel-runtime-LICENSE`

Upstream: https://github.com/twitter/twitter-text/tree/v3.1.0
