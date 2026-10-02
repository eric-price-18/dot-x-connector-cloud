# Verification record

Local source-export verification, 2 October 2026, Linux with Node 24.19.0. These are offline tests of this reusable source, not a claim that any reader's deployment or provider account has been verified.

## Passed

- Clean dependency installation with both pinned package lockfiles
- Backend syntax/configuration (56 modules), five empty-schema migrations and integrity checks
- Backend Node suite: 429 passed, zero failed or skipped
- Backend workerd/local D1 suite: 77 passed, zero failed or skipped
- Backend Wrangler dry-run with network denial and telemetry disabled
- Bundled parser rebuilt byte-for-byte from pinned dependencies
- Frontend shipped-defaults regression: two passed
- Frontend/core and cross-package suite: 75 passed, zero failed or skipped
- Actual MCP-ingress frontend/backend dual-workerd pipeline with real local D1 and mocked X
- Optional MCP transport metadata accepted, validated and stripped before signing; malformed metadata and attempted authority overrides denied
- Native-shaped status-only ingress with every mutation/live-X gate off and zero mocked X/identity-provider calls
- Fresh supported-starter overlay: TypeScript and full production build
- Built overlay smoke: setup routing, anonymous/other-owner rejection, security headers and default read-only MCP discovery, with outbound requests denied
- Source-tree review for credentials, account/deployment identifiers, encoded fixture claims, runtime artifacts and private provenance

Backend workerd fixtures use an explicit synthetic 2035 clock and advance it directly for expiry tests. Historical Node and cross-package cases use a fixed 2000 clock. Test clock controls and in-memory credit fixtures are never production entrypoints. The frontend suite's temporary test copy enables its read bridge only inside that copy. It tests the distributed default-off module separately. Public example service endpoints are reserved domains. Backend test vectors are newly generated, expired synthetic proofs with discarded private keys.

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
