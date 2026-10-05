# Private frontend modules

The `lib/` modules implement owner checks, CSRF-protected one-time key initialization, signed backend requests, MCP discovery, exact write validation and conservative receipts. They can be tested without a Site or account.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run test:core
npm test
```

The complete test command additionally checks the sibling `../backend` package. It first tests the unchanged public default-off module, then copies custom source and tests to a temporary directory. Only that offline fixture copy enables the read bridge. The distributed source stays disabled. Host connections are limited to loopback, provider requests are mocked, and temporary files are removed afterwards. A test fixture is never deployment configuration.

## Optional Sites frontend

Create a fresh, unregistered supported starter in a separate directory using your platform's normal workflow. No platform starter source is redistributed here. Apply the custom overlay with:

```sh
node scripts/apply-sites-overlay.mjs /path/to/fresh-starter
```

The script refuses a registered Site and an unsupported Worker shape. It copies only custom modules, page/schema examples and the setup wrapper, plus their scoped MIT notice as `LICENSE.dot-x-connector` without replacing any starter license. It preserves the starter's authentication and connector context, adds D1/MCP declarations, and adds the pinned text-parser and schema-validator dependencies. It does not register, publish, sign in or enable live requests.

In the generated starter, first run `npm install --package-lock-only --ignore-scripts --no-audit --no-fund` to synchronize its changed lockfile. Then use the starter's supported dependency installer, typecheck and build workflow. A clean installer using `npm ci` must not run against an out-of-date lockfile. Once that unconfigured starter is built, run:

```sh
node scripts/check-sites-overlay.mjs /path/to/built-starter
```

This offline smoke check verifies the actual built setup route, owner denials, security headers and default read-only discovery. Its owner headers are synthetic local test inputs. In production, only the hosting platform may supply authenticated identity headers; exposing this handler directly to arbitrary public headers is unsafe.

See [starter integration](../docs/starter-integration.md) and [configuration](../docs/configuration.md) before adapting the examples. The generated full Site is outside this repository and keeps its own source identity, dependencies and platform licenses.

The default-off queue bridge adds eight signed operations and a durable processor-state adapter. Its owner workflow and migration setup are documented in [reply queue setup](../docs/reply-queue.md). The overlay includes `skills/x-reply-queue/SKILL.md`; skill presence grants no permission to enable activity or schedule tasks.

For a new owner, complete [onboarding](../docs/onboarding.md) and adopt the
[operator workflows](../docs/operator-workflows.md) explicitly. The supplied
`aggregateQueueReadiness` and `reconcileReplyQueueProcessor` helpers need an
owner-platform adapter; no scheduler registration is included. Visual DM
discovery and its conditional PIN alerts are separate operator procedures,
not capabilities of this frontend's MCP tools.
