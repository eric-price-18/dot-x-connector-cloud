# Verification record

Local source-export verification, 2 October 2026, Linux with Node 24.19.0. These are offline tests of this reusable source, not a claim that any reader's deployment or provider account has been verified.

The documentation review of 5 October 2026 adds [new-owner onboarding](onboarding.md),
[operator workflows and source boundaries](operator-workflows.md), and reference-v16
extension availability. It does not change runtime source or turn historical
test results below into acceptance of a new deployment. Browser judgment,
scheduler acknowledgment, conditional DM alerts and owner-manual PIN entry need
their own operational verification; no SDK/DM transport or PIN-unlock bridge is
claimed by the source tests.

The [invited-reply extension guide](invited-replies.md) documents an additional,
default-off candidate with typed provenance and final dispatch checks. Its
private implementation test results are not results for this public runtime.
The public source remains own-thread-only; no deployment or activation is part
of the tutorial revision.

For this documentation-only revision, all 93 local links in 14 changed Markdown
files resolved, the private-identifier scan found zero matching files, the
backend syntax/configuration/integrity check passed (91 modules), and both
processor/readiness helper tests passed. No runtime implementation, deployment,
owner setting or scheduler was changed by this tutorial revision.

## Passed

- Clean dependency installation with both pinned package lockfiles
- Backend syntax/configuration (66 modules), six empty-schema migrations and integrity checks
- Backend Node suite: 412 passed, zero failed or skipped
- Backend workerd/local D1 suite: 104 passed, zero failed or skipped
- Atomic caps: ten replies/day, two per recipient/day and eleven total writes; lower limits, concurrent claims, pending/unknown claims and UTC-midnight reset covered
- Backend Wrangler dry-run with network denial and telemetry disabled
- Prior-release evidence reused for the unchanged bundled parser: rebuilt byte-for-byte from pinned dependencies
- Frontend shipped-defaults regression: two passed
- Frontend/core and cross-package suite: 66 passed, zero failed or skipped
- Actual MCP-ingress frontend/backend dual-workerd pipeline with real local D1 and mocked X
- Optional MCP transport metadata accepted, validated and stripped before signing; malformed metadata and attempted authority overrides denied
- Native-shaped status-only ingress with every mutation/live-X gate off and zero mocked X/identity-provider calls
- Current frontend core modules compile and run through the dual-workerd interoperability harness. Full supported-starter TypeScript/build was last verified on an earlier release and was not rerun for this changed reply contract.
- Earlier built-overlay smoke covered setup routing, anonymous/other-owner rejection, security headers and default discovery; it is historical evidence, not live acceptance of this new contract.
- Source-tree review for credentials, account/deployment identifiers, encoded fixture claims, runtime artifacts and private provenance

Backend workerd fixtures use an explicit synthetic 2035 clock and advance it directly for expiry tests. Historical Node and cross-package cases use a fixed 2000 clock. Test clock controls and in-memory credit fixtures are never production entrypoints. The frontend suite's temporary test copy enables its read bridge only inside that copy. It tests the distributed default-off module separately. Public example service endpoints are reserved domains. Backend test vectors are newly generated, expired synthetic proofs with discarded private keys.

- Generic reconciliation tests cover the real owner login/form path, CSRF and origin denial, exact account binding, shutdown/default-off gates, schema checks, D1 atomicity, replay, full legacy carry and no credit replenishment. The local validator smoke verifies restrictive output permissions and rejects overwrite or in-source output.

## Browser-reviewed reply boundary

The current service path is covered by 16 dedicated browser-reply transport cases/subcases plus real frontend/backend interoperability. Fresh credentials produce exactly one publish POST and no content/STOP scan. Expired credentials produce token POST, account-verification GET and reply POST. Tests cover required author metadata, signed body/target tampering, stored and late local opt-outs, count/cooldown/budget denials, Unicode text preservation, grant rotation, concurrent single-send and permanent unknown receipts.

The server trusts the owner-agent's browser findings about root ownership, author, public status, freshness and new no-response requests. Those are not independently verified by the backend. Old paid-ancestry/mandatory-footer service tests were replaced by tests for this contract; the lower Node/frontend test counts do not represent skipped failures. Retained standalone historical guard tests exercise old helpers, not a guarantee or paid step in normal replies.

Atomic monetary/request quotas, UTC caps, default-off gates, owner reconciliation, pre/post-reservation grant fences, stored opt-outs, target claims and historical liabilities remain. The current grant-rotation regression and real-D1 trigger tests still pass. Generic reconciliation tests continue to cover the authenticated owner form, CSRF/origin/account checks, shutdown gates, D1 atomicity, replay and no credit replenishment.

No deployment, paid X call, actual live reply, or hosted native-catalog integration was performed for this candidate. The public source contains no private temporary budget/count exception. Platform policy/approval and account entitlement are separate prerequisites.

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
