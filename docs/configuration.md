# Configuration and safe defaults

The example values are deliberately nonfunctional. Adapt them in a private deployment checkout and rerun the full suite after changing security-critical configuration.

## Values that belong to each deployment

- Owner email for initial owner verification and a durably bound Site-scoped owner ID
- Frontend origin, service issuer and service subject
- Fixed read and write backend endpoints and matching proof audiences
- Cloudflare account, Worker and D1 identifiers
- Identity-provider issuer, client IDs, redirect URLs and allowed owner subject
- X developer app client ID, exact callback URL and intended numeric X account ID
- A newly initialized frontend public-key pin
- Explicit operation limits, budget settings and any operation deadline

Example files must use reserved example domains or unfilled markers and fail closed until configured. A changed origin, account or key must not silently rebind an existing deployment.

## Secrets

Use the host's supported secret-entry mechanism for client secrets, encryption material and tokens. Keep them out of source files, commands copied into public issues, screenshots, logs, Git history and assistant messages. Do not put a frontend signing private key in a public environment example.

The frontend signing key is stored only in its server-side database. X OAuth tokens remain backend-only. Database administrators and deployed server code are within the trust boundary; encrypted storage is not a dedicated hardware key vault.

## Feature gates

Missing or malformed enablement values must disable their operation. Example configuration keeps provider access, polling, original posts, reposts and replies off. Default-off configuration is essential even when an OAuth grant includes write scopes.

Reuse the same idempotency key for status lookup. After `pending` or `unknown`, inspect the durable receipt and do not send a new write with a new key to resolve uncertainty. A status lookup returning `not_found` does not itself prove an earlier request was never sent.

Use provider spending limits as well as local operation/budget controls. Preserve the guard logic when replacing sample configuration; removing a one-off deployment deadline must not accidentally remove cost enforcement.

## Example fixed-window policy

The backend code pins `example-disabled-budget` to an expired January 2000 deadline with a maximum of 5,000,000 micro-USD. This is a disabled sample, not an active budget. A real deployment needs a reviewed code-level run identifier and finite expiry; environment values must match or narrow those pins. Keep durable reservations and unknown-outcome tombstones intact.

## Gates by capability

Every environment gate below requires the exact string `"true"`. A missing,
boolean, differently capitalized or malformed value does not enable it.

- **Owner login:** `OWNER_LOGIN_ENABLED` and `LIVE_IDP_ENABLED`, valid provider
  discovery/JWKS/UserInfo pins, exact owner subject, `openid x:read` access-token
  scope and the backend `/mcp` resource audience. Owner sessions never accept an
  ID token in place of an access token.
- **Store a write-capable X grant:** `OWNER_X_WRITE_CONSENT_ENABLED`, a reviewed
  `tweet.write` OAuth consent, and live X/account/budget prerequisites. This flag
  does not enable posting or alter an existing token's scopes.
- **Signed cached reads:** frontend compiled `SERVICE_BRIDGE_ENABLED`, backend
  `SERVICE_ENABLED`, matching issuer/subject/read audience and a valid public
  signing-key pin. Cache retrieval itself makes no live X request.
- **Polling:** backend `READ_POLLING_ENABLED`, `LIVE_X_ENABLED`, a linked account,
  finite budget and read/request limits, plus an explicitly configured schedule.
- **Original posts:** frontend `X_ORIGINAL_POSTS_ENABLED`; backend
  `SERVICE_ENABLED`, `SERVICE_WRITE_ENABLED`, `POST_ENABLED`,
  `X_ORIGINAL_POSTS_ENABLED` and `LIVE_X_ENABLED`.
- **Reposts:** the equivalent write prerequisites and `X_REPOSTS_ENABLED` on
  both sides, plus a separate repost limit.
- **Own-thread replies:** frontend `X_OWN_THREAD_REPLIES_ENABLED`; backend
  `SERVICE_ENABLED`, `SERVICE_WRITE_ENABLED`, `REPLY_ENABLED`,
  `X_OWN_THREAD_REPLIES_ENABLED` and `LIVE_X_ENABLED`. Current platform approval,
  trusted browser target/author/root review, honoring opt-outs and local durable interaction checks
  remain necessary. No independent server ancestry/public-status/freshness or new-STOP scan is provided. The legacy reply interface is still code-disabled.
- **Write receipt lookup:** frontend `X_WRITE_STATUS_ENABLED`; backend
  `SERVICE_ENABLED`, `SERVICE_WRITE_ENABLED`, `X_WRITE_STATUS_ENABLED` and valid
  service/account binding. This is ledger-only and does not contact X.

Mutation gates are necessary but not sufficient: account binding, a write-capable
X grant, finite immutable budget, operation/request limits, exact arguments and
short-lived signed proofs must also pass. Frontend discovery and stored link
status are not assurances of backend or provider readiness.

## Optional one-time mention canary

All four `X_CANARY_MENTION_*` bindings are absent from shipped configuration.
The exact lower-case handle, lowercase UUID v4, lowercase SHA-256 of the exact
text and finite expiry are server configuration, never tool arguments. The
backend and frontend validate them independently. The frontend's
`CANARY_DEADLINE` and backend's immutable credit-policy ceiling must agree in a
reviewed private deployment. The public ceilings are expired.

An authorized exact intent can claim the backend `canary_mention` singleton only
once. Changing its account, configuration or idempotency key does not grant a
second attempt. Preserve that migration, claim and all write tombstones. This
feature is optional, does not apply to replies/reposts, and does not establish
recipient consent or platform approval. Prefer a harmless mention-free original
for ordinary end-to-end verification.

## MCP transport metadata

The frontend accepts the optional object-valued `_meta` defined in the
[MCP 2025-11-25 schema](https://modelcontextprotocol.io/specification/2025-11-25/schema#calltoolrequestparams).
When present, its `progressToken` must be a string or finite number. All metadata
is discarded before exact tool-argument validation and signing. It cannot supply
identity, account, destination, proof, activation flags or tool arguments.
Unsupported task execution and unknown outer fields remain rejected. No incoming
metadata or tokens are logged for diagnosis.

Tools are gated in `tools/list`, but long-lived client task catalogs can remain
stale. Prefer a fresh task/conversation or supported catalog refresh after a gate
change. A reconnect or new OAuth grant is not inherently required for discovery.

## Optional ongoing policy (disabled template)

`X_ONGOING_OPERATIONS_ENABLED` is `false` in both example configurations. The original expired immutable credit window remains unchanged. Ongoing mode is a separate reviewed opt-in using migration `0006_ongoing.sql`; it requires account-bound reconciliation records, not a renewed legacy run constant. An environment flag alone cannot create those records or authorize spending.

Use UTC day/month boundaries, sample $1/day and $5/month limits, a maximum of ten replies per UTC day, at most two per recipient per UTC day, eleven total writes and 900-second spacing, and lower operator limits (including zero). Every old pending, successful and unknown operation counts without private exemptions. Paid polling remains off and cron lists remain empty. Follow the runnable [reconciliation workflow](reconciliation.md): supported D1 migrations, a local evidence validator, administrator-installed Worker secret, and the existing authenticated owner form. There is no automated provider-balance import. Do not fabricate or copy reconciliation rows from tests or another deployment.

The full $0.035 URL-free or $0.22 URL/ambiguous ongoing reply hold must fit before token work or dispatch. Only never-attempted stages release their unused reservations; unknown attempts and crashes retain their conservative bounds. Owner-session diagnostics at `/owner/monitor-status` are local estimates, not authoritative provider balances. See [browser-reviewed replies](browser-replies.md).
