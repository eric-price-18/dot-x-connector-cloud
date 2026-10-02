# Dot X Connector backend

A dependency-free-at-runtime Cloudflare Worker for an owner-bound X connector,
with D1 persistence, encrypted OAuth grants and cached reads. Optional signed
server-to-server tools support original posts, reposts and a tightly constrained
own-thread reply workflow. This source is an inert starting point, not a
configured deployment. No live X request is authorized by these examples.

## Default-deny behavior

- All live-provider, owner-login, write-consent, polling, service, write and reply
  flags are `false`; scheduled triggers are empty, and public Worker previews are off
- One-time mention-canary bindings are absent. There is no recipient, payload
  digest, intent UUID or active canary deadline in the public configuration
- Example origins use reserved `.example.invalid` names. There are no real
  account IDs, client IDs, owner subjects, trust keys, D1 bindings or secrets
- Service issuer, subject and read/write audiences are immutable code pins in
  `src/service.mjs` and `src/write-policy.mjs`, not arbitrary request destinations
- `src/credit-policy.mjs` pins one example budget and a deadline in January 2000.
  The window is already expired. An environment variable cannot create a new
  window, extend that deadline, exceed the five-dollar ceiling or reset the
  durable ledger. A real spending window requires a reviewed source change
- The legacy reply interface remains code-disabled. The separate own-thread
  service requires its explicit operation gates and all of the reply guards
- No DM, arbitrary HTTP, follow, like, delete, quote-post, media-upload or broad
  search tool is exposed

## Local checks

Use Node 24 or newer. Dependencies are frozen in `package-lock.json`, including
Wrangler 4.146.0, Miniflare 5.20261001.0-alpha and esbuild 0.28.1.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm test
npm run test:runtime
npm run build:dry-run
```

Installing dependencies needs registry access or a populated npm cache. Checks
and tests do not need credentials or a live X/identity-provider account. Runtime
tests also need permission to start local workerd processes and listen on
loopback. The pinned Miniflare is an alpha version; no claim is made that future
or different dependency versions behave identically.

`check` verifies syntax, migration integrity, generic trust pins, disabled
configuration and the expired immutable credit policy. Node tests inject mocked
provider functions and a historical synthetic clock. Workerd tests intercept
all Worker egress with an allowlisted mock service; unknown egress fails.

Workerd application clocks start at the fixed synthetic instant
`2035-01-01T00:00:00Z`. Test-only entry points call `createWorker` with an injected
clock; restart restores its explicitly controlled value, and expiry tests advance
it through a local test-control route rather than sleeping. Canary fault
injection delegates through the same clocked entry point. No runtime fixture
uses the current date, and the production Worker never imports these wrappers.

The helper also replaces only the credit-policy module **in memory** with a
fixed test-only window ending `2035-01-02T00:00:00Z`. It does not edit production
source, add a production bypass or widen the immutable ledger checks. Separate
regressions retain the unmodified expired policy and verify denial at the fixed
future clock. Runtime fixtures use synthetic identities, keys and records;
they are never provisioning material. Crypto keys and OS scheduling remain
nondeterministic; the application's time-dependent decisions use the fixed clock.

The dry-run launches Wrangler with a minimal environment, an isolated home,
telemetry disabled and a preloaded network-denial guard. It only bundles the
inert default configuration. Generated local files under `dist/` and `.tools/`
are ignored and must not be included in a release.

## Security boundaries

Human authentication checks the exact issuer, audience, subject and required
scope. Descope-mode JWT verification requires the signed `access_token` class,
pins the algorithm and provider endpoints, and checks live UserInfo acceptance
on every invocation. ID and refresh JWTs cannot substitute for access tokens.
OAuth token-response transport still independently requires `Bearer`. Owner
login requests `openid x:read` and uses PKCE,
state, an exact callback, encrypted server-side sessions and CSRF protection.
X authorization verifies the expected account ID before storing a grant. Owner
write-scope consent is a separate default-off gate: it can request an exact
`tweet.write` grant but does not enable any operation. Missing or extra granted
scopes fail closed. Owner error pages expose only fixed diagnostic references;
provider contents and claim values remain absent from responses and logs.

Service requests require an ES256 proof against a separately configured public
key. Proofs bind the exact method, path, audience, body digest and short expiry;
write proofs also bind the operation, idempotency key and reply target. Browser
origin headers cannot grant service access. Read proofs may be replayed until
expiry; writes use durable intent and dispatch records to prevent duplicate
execution, including when a response is uncertain.

The credit ledger reserves conservative costs before provider requests. Paid
reads, OAuth calls, refreshes and all mutation types share its fixed total cap.
Reservations are not refunded on errors. Daily/hourly request limits and
operation limits are additional guards. The dollar estimates are implementation
assumptions, not a guarantee of current X billing; verify pricing before any
real deployment and keep reservations conservative.

Own-thread replies require a recent direct response by another public author to
an original root owned by the connector account. They reject nested, edited,
private, sensitive, multi-party and ambiguous records. Visible handle checks
retain an example code pin (`@example_dot_bot`) that must be reviewed alongside
the intended account. A fresh bounded opt-out scan and atomic dispatch claim
provide durable opt-out and one-reply-per-interaction controls. Every reply must
contain the exact opt-out notice. These controls do not establish that an app
has the platform approvals required for automated replies.

## One-time mention canary

The ordinary text validator still rejects mentions. A separate original-post
canary path requires an operator-provisioned exact lowercase handle, NFC text
SHA-256 digest, UUID and unexpired deadline no later than the immutable credit
window. These are not caller-controlled allowlists and are absent by default.
The bundled expired credit policy also prevents activating a canary today.

The canary permits only one exact mention and retains general length, Unicode,
URL and quote restrictions. A global D1 singleton binds the full intent and
owner/account before paid work. Changing configuration, account, recipient or
UUID cannot allocate another slot. Concurrent requests, crashes and lost slot
acknowledgments preserve that reservation; uncertain dispatch remains unknown
and cannot be retried as a fresh send. Deadline checks apply again immediately
before dispatch. This capability does not provide permission to contact anyone.

The regression suite exercises these cases against local D1, plus explicitly
verifies that the unmodified public policy denies synthetic canary activation
at the fixed future clock. Fault-injection wrappers live only in `runtime-test/` and are
never Wrangler entry points.

## Adapting the source

`wrangler.jsonc` is the inert default. `config/oauth.example.json` illustrates
public OAuth endpoint pins with every active gate still disabled. Neither is a
production setup script. Review and provision the following separately:

1. Your Worker origin, frontend service issuer/subject, exact read/write
   audiences and intended account handle; keep the corresponding frontend and
   backend pins identical
2. Your provider's verified discovery, issuer, JWT algorithm, endpoint and
   callback configuration, exact owner subject and intended X account ID
3. A private D1 binding named `DB`, all migrations in order and confidential
   credentials/encryption material delivered through an appropriate secret store
4. A frontend signing key whose matching public key alone is bound to
   `SERVICE_PUBLIC_JWK`; never reuse test fixture keys
5. A reviewed immutable credit window and conservative limits, then only the
   particular live operation gates you intend to authorize

Never commit credentials, production configuration, caches, databases, logs or
signing private keys. Keep the default example configuration disabled. Audit
current provider rules, pricing and necessary approvals independently before
any real use. Local mock coverage is not evidence of live-provider compatibility
or production readiness.

## Parser and licenses

The bundled text parser is generated from twitter-text 3.1.0. It runs locally
without network calls. See `vendor/README.md` and retained upstream licenses.
Custom project code is licensed under the repository's root MIT license;
third-party parser components retain their own Apache-2.0 and MIT terms.

```sh
npm run vendor:rebuild
node scripts/generate-test-vectors.mjs
```

The first command deterministically rebuilds the parser with the pinned tools.
The second replaces the two expired synthetic interoperability vectors using
fresh random ephemeral keys; its output intentionally changes on each run.
Private keys are discarded and never written.
