# Verification record

Local source-export verification, 2 October 2026, Linux with Node 24.19.0. These are offline tests of this reusable source, not a claim that any reader's deployment or provider account has been verified.

## Passed

- Clean dependency installation with both pinned package lockfiles
- Backend syntax/configuration (67 modules), six empty-schema migrations and integrity checks
- Backend Node suite: 451 passed, zero failed or skipped
- Backend workerd/local D1 suite: 100 passed, zero failed or skipped
- Backend Wrangler dry-run with network denial and telemetry disabled
- Prior-release evidence reused for the unchanged bundled parser: rebuilt byte-for-byte from pinned dependencies
- Frontend shipped-defaults regression: two passed
- Frontend/core and cross-package suite: 75 passed, zero failed or skipped
- Actual MCP-ingress frontend/backend dual-workerd pipeline with real local D1 and mocked X
- Optional MCP transport metadata accepted, validated and stripped before signing; malformed metadata and attempted authority overrides denied
- Native-shaped status-only ingress with every mutation/live-X gate off and zero mocked X/identity-provider calls
- Prior-release evidence reused for unchanged frontend modules: fresh supported-starter TypeScript and full production build
- Prior-release built-overlay smoke evidence reused: setup routing, anonymous/other-owner rejection, security headers and default read-only MCP discovery, with outbound requests denied
- Source-tree review for credentials, account/deployment identifiers, encoded fixture claims, runtime artifacts and private provenance

Backend workerd fixtures use an explicit synthetic 2035 clock and advance it directly for expiry tests. Historical Node and cross-package cases use a fixed 2000 clock. Test clock controls and in-memory credit fixtures are never production entrypoints. The frontend suite's temporary test copy enables its read bridge only inside that copy. It tests the distributed default-off module separately. Public example service endpoints are reserved domains. Backend test vectors are newly generated, expired synthetic proofs with discarded private keys.

- Generic reconciliation tests cover the real owner login/form path, CSRF and origin denial, exact account binding, shutdown/default-off gates, schema checks, D1 atomicity, replay, full legacy carry and no credit replenishment. The local validator smoke verifies restrictive output permissions and rejects overwrite or in-source output.

## Nested/ongoing candidate boundary

The local adaptation additionally covers four intermediate ancestors, same-ID target/root rejection before a second lookup, fresh parent evidence, classified $0.175/$0.36 preflight reservations, atomic five-attempt ceiling, 900-second spacing, missing reconciliation, conservative unresolved liabilities, and owner-only local diagnostics. No live X call or deployment was used to verify this candidate. Private deployment results and the private candidate's test counts are not this source's evidence.

Reconciliation uses the shipped owner form and local validator with administrator-supplied evidence. The template provides no automatic dashboard import, private historical exclusions or activated budget records. UTC calendar defaults and conservative mutation reservations deliberately avoid private operational assumptions. Paid polling and all gates remain disabled.

## Pricing/accounting parity follow-up

Offline coverage additionally verifies atomic request-quota and money reservations under concurrency; no partial charges after known local denial; no release of historical, dispatched, unknown or ambiguously committed liabilities; and release only of the current invocation's provably unattempted call. Lookup/STOP responses reject unrequested expansions. Plain text with sentence-ending punctuation uses the lower reservation; encoded, disguised and Unicode URL ambiguity keeps the higher one.

The existing grant-replacement regression remains intact. The public adaptation checks the grant both before and after awaited budget reservation; a real-D1 trigger test rotates it during reservation and proves zero dispatch while an existing unknown liability remains unchanged. No live reply-success claim follows from these tests.

## Reproducibility

Run `npm run install:all` and `npm test` from the repository root. Root tests include standalone backend checks and frontend/backend interoperability. Installation needs registry access or a populated cache; tests require a local workerd process and loopback permissions.

The overlay helper was tested against a fresh supported starter using vinext 1.0.0-beta.5, Vite 8.0.13 and Next 16.3.4. The helper fails if the expected Worker shape changes. A different starter needs review and a fresh build. No hosted CI workflow is shipped. The standalone commands do not obtain, register or host the platform starter.

## Limits and observations

- No live X calls, OAuth grants, posts, credit purchases or deployments are part of these tests
- No universal guarantee is made for identity-provider integration, production CPU limits, X entitlement, billing or policy approval
- Backend Miniflare is pinned to an alpha version. One intermediate repeated development run hit a native Node callback assertion; clean-installed full verification and the complete root rerun subsequently passed. Treat a recurring runtime crash as a test-toolchain issue to investigate, never as a skipped pass
- The legacy text-parser dependency includes a deprecated core-js package in its npm dependency graph. The backend's vendored parser omits those global polyfills; the frontend uses the pinned upstream npm package. Dependency upgrades need fresh Unicode and interoperability verification
- No external penetration test or exhaustive dependency vulnerability audit is claimed
- Unknown write results remain unknown. The ledger cannot promise exactly-once delivery across an external network
- The public example spending window is deliberately expired. It requires a reviewed configuration change before any current paid operation
