# Third-party components

Inventory for the pinned dependency lockfiles included in this source export.

The root MIT license applies to original project code and documentation. The generated parser and any included third-party code remain subject to the upstream terms listed below.

## Bundled parser

The backend includes a generated parser bundle from `twitter-text` 3.1.0, licensed under Apache-2.0. Preserve `backend/vendor/twitter-text-LICENSE` and the upstream copyright notices, including Copyright 2018 Twitter, Inc. from the parser source headers. The generator also incorporates code from `twemoji-parser`, `punycode` and Babel runtime; retain their MIT license files.

Keep the generator script, pinned dependency versions, bundle header and a description of the changes: selected exports, minification/tree shaking, and omitted ES2015 polyfills provided natively by the target runtime. Do not label this generated bundle as solely original MIT code.

- Upstream source: https://github.com/twitter/twitter-text/tree/v3.1.0
- Upstream license: https://github.com/twitter/twitter-text/blob/v3.1.0/LICENSE

## Installed dependencies

The frontend installs `twitter-text` 3.1.0 (Apache-2.0) and `zod` 3.25.76 (MIT) from npm rather than copying their source. Other runtime/development packages retain their own licenses in the installed packages. Do not commit `node_modules`.

## Platform starter

This export intentionally excludes platform starter source. Generate a supported starter separately. If any explicitly licensed starter adapter or shadcn asset is later included, preserve the corresponding OpenAI or shadcn MIT notice and document its scope. The presence of one licensed file does not establish a license for the entire starter.
