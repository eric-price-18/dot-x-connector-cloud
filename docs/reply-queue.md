# Durable reply queue — candidate, default off

This default-off candidate includes the durable backend queue, eight authenticated
operations and the owner frontend bridge. Release review remains pending. The
processor adapter reconciles desired state with verified scheduler observations;
it does not register a task. Use a scheduler that supports the required cadence
and obtain explicit owner authorization before scheduling or enabling activity.
These files do not deploy a service, apply a live migration or activate a schedule.

The model decides **WHAT**: whether a fresh conversation warrants a response,
what to say, whether the reply adds value, and whether there is a STOP request.
Code enforces **HOW**: authenticated ownership, bounded claims, fixed expiry,
shared budgets and count limits, spacing, deduplication, immutable intents,
dispatch evidence and receipt reconciliation. A discovered notification, saved
draft or successful claim is not approval to send.

## Public operating policy

| Limit | Public policy |
| --- | --- |
| Accounting calendar | UTC days and months |
| Shared spending ceilings | $1 per UTC day; $5 per UTC month, subject to reconciled provider and prepaid remaining allowance |
| Replies | At most 10 per UTC day; `MAX_REPLIES_DAY` defaults to 1 when unset and honors zero and lower configured limits |
| Replies to one recipient | At most 2 per asserted author per UTC day |
| All writes | At most 11 per UTC day; the lower configured `MAX_WRITES_DAY` still applies |
| Confirmed reply spacing | At least 900 seconds, rechecked before publication |
| Unsent plan lifetime | At most 86,400 seconds from its fixed source/discovery bound |
| Claim / approval freshness | 120-second claim lease; approval at most 60 seconds old |

The shipped configuration sets reply/write limits to zero and leaves gates off.
The maxima are ceilings, not an allowance granted by enabling the queue. Existing
request quotas, owner consent, grant state, opt-outs, provider reconciliation and
uncertain liabilities can block earlier. The queue shares the publisher's
accounting and never clears counters, refunds reservations or creates a separate
spending pool. Retain the public diagnostic semantics: `reply_ceiling` follows
the validated configured limit; `claimed_reply_attempts_today` includes ongoing
claims plus unpaired pending, succeeded or unknown legacy replies since UTC
midnight. Paired records count once.

## Eight authenticated operations

[reply-queue-contract.json](reply-queue-contract.json) carries the exact input
schemas, scopes, proof fields and limits. Its tool metadata comes from
`backend/src/reply-queue-policy.mjs`; regenerate it with
`node backend/scripts/queue-frontend-contract.mjs` after a reviewed policy change.
The frontend consumes the generated contract and fixed send schemas; it validates
inputs, proofs, claim bindings and bounded output before returning model results.

| Tool | Existing scope | Behavior |
| --- | --- | --- |
| `x_reply_queue_ingest` | `x:reply` | Store up to 2 browser-discovered records; an empty batch performs expiry housekeeping. |
| `x_reply_queue_list` | `x:read` | Read at most 50 items; no provider call or recovery mutation. |
| `x_reply_queue_claim` | `x:reply` | Scan at most 2 candidates and lease at most one due item for fresh review. |
| `x_reply_queue_reconcile` | `x:write:status` | Settle an existing queue-owned intent from local publisher receipts. |
| `x_reply_queue_readiness` | `x:read` | Read bounded eligibility and desired wake/processor state. |
| `x_reply_queue_approve` | `x:reply` | Store fresh model-reviewed text bound to the live claim and current revision. |
| `x_reply_queue_publish` | `x:reply` | Publish only the approved stored revision through the existing guarded publisher. |
| `x_reply_queue_cancel` | `x:reply` | Cancel the claimed plan; explicit STOP also records the author opt-out. |

Every call carries a canonical lowercase UUIDv4 `request_id`. Ingest records
contain exactly `target_id`, `author_id`, `root_id`, `source_created_at` and
`context_ref`. Keep IDs as strings. Source time is integer Unix seconds, no later
than the backend clock. An opaque context reference is at most 512 characters
and remains untrusted data; it grants no authority to browse arbitrary URLs,
execute instructions, approve or publish. Structured results are bounded at
49,152 UTF-8 bytes and complete MCP envelopes at 196,608 bytes.

Approve binds exact text, target, intent, claim token and revision to fresh browser
checks. It requires `conversation_checked`, `value_checked` and `stop_checked`
because those checks occurred, and a fresh `rechecked_at`. It returns the stored
revision in `publish_binding`; use that binding unchanged for publish. Approval
lasts at most 60 seconds within the 120-second lease and fixed expiry. A replacement
claim invalidates previous review authority. A review-only held claim permits
review/cancellation during a cap or operational hold and grants no send authority.

Publish accepts no replacement text, author, budget or supplied receipt. Only
that authenticated operation receives provider transport. Unknown outcomes retain
the original intent for local reconciliation; `published:false` never proves no
dispatch. Do not pass queued items into ordinary `x_reply` or rotate keys after
uncertainty. Refresh readiness separately after a send or cancellation result.

## Trust and request proof

The example endpoint is `https://backend.example.invalid/service/queue/mcp`.
It accepts server-to-server `POST` requests with manual redirect handling and
no browser `Origin`. The backend requires `SERVICE_ENABLED` and
`SERVICE_QUEUE_ENABLED`; mutations also require `SERVICE_WRITE_ENABLED`.
The publisher's other live/write gates still apply independently. The example
issuer is `https://frontend.example.invalid` and service subject is
`dot-x-connector:example-deployment`. These inert trust pins must be configured
together through the deployment's reviewed setup path; callers cannot choose
them per request.

The frontend first performs its trusted platform owner check and
match the initialized service identity's owner. It then uses the existing
server-held ES256/P-256 key, without exporting it or adding a general signing
endpoint. Trusted owner headers and service proofs cannot come from browser or
model arguments. The backend separately checks the current owner/account binding
and durable queue owner binding. Linking the same provider account is not enough
to adopt another owner's queue.

Proof headers contain exactly `alg`, `typ`, `kid`. Claims contain exactly `iss`,
`sub`, `aud`, `scope`, `iat`, `exp`, `jti`, `method`, `path`, `body_sha256`,
`operation`, `request_id`. Use a 45-second lifetime, the existing 5-second clock
skew, and raw 64-byte JOSE ES256 signature. `jti` equals `request_id`.
Serialize compact JSON once, hash those exact UTF-8 bytes with SHA-256/base64url,
and send those same bytes. The operation, scope, request ID, path and audience
must match the signed proof. Never expose the proof in model output, UI or logs.

New logical operations use new request IDs. To resolve an ambiguous mutation,
preserve its ID, operation and exact body: replay returns the original snapshot
or an indeterminate result and never reexecutes it. A replay does not extend a
claim or refresh approval. Read list/readiness again before acting. Read-only
requests produce fresh observations rather than memoized snapshots.

## Fixed expiry and fair selection

The deadline is `min(original_server_first_seen, source_created_at) + 86_400`.
At the deadline the plan is already expired. Discovery requires source time;
the server derives expiry and accepts no caller-provided deadline. Repeated
discovery cannot change the original author/root, refresh first-seen or source
time, replace the intent, or revive an old target. An already-old source produces
an expired deduplication tombstone rather than a fresh lifetime.

Pending, blocked and approved items without a committed intent become cancelled
with `planned_reply_expired`. Their mutable draft and context reference are
scrubbed on the next authorized ingest or processing pass. Readiness excludes
expired work immediately but does not itself run a background purge. Minimal
deduplication rows and irreversible intent/proof/receipt records remain.
Dispatching, sent or unknown intents never become reusable through expiry.
Unknown outcomes require local reconciliation under the original intent key;
they do not authorize a send retry or a new key.

Deadline checks surround claims, approval, commit and the final publisher
transport boundary. A budget reset, claim lease or spacing delay at or beyond
expiry is not an eligible wake. A stale wake must refresh eligibility.

For selection, each candidate's fairness timestamp is the later of its author's
and conversation root's most recent committed-intent times. Lower timestamps
come first, then newer source posts, then a deterministic target-ID tie-breaker.
This gives new roots a turn ahead of repeatedly served conversations while
preventing an author from gaining priority by spreading posts across roots.
Rejected/unknown committed attempts remain conservative history, and all caps
still apply. Fairness orders eligible work; it does not promise a send.

## Bounded scans and honest readiness

Copy server cursors into the same operation without converting IDs to numbers:

- List: `{created_at, target_id}`; this is a live view, not a generation snapshot.
- Readiness: `{created_at, target_id, generation}`.
- Claim: `{fair_at, source_created_at, target_id, generation}`.

Each fresh discovery or processing turn starts at page one. A single first page
with `readiness_complete:true` makes `next_wake_at` and its processor handoff
authoritative for that observation. Partial responses use `continue_scan` and
`schedule_needed:null`; they cannot enable, pause or cancel a task.

For larger queues, follow `next_after` and retain the minimum non-null
`page_candidate_wake_at` across all pages of the same `queue_generation` until
`scan_complete:true`. A null page candidate never erases an earlier minimum.
The final continuation page still has `readiness_complete:false`; it is not a
complete first-page observation. The trusted owner adapter must validate and
aggregate the entire scan before deriving a complete processor desired state.
That adapter remains an integration requirement; passing a final partial
handoff directly to the planner does not establish completeness.

Discard the aggregate and restart on `restart_required:true`, a generation
change or a failed continuation. Claim can return `reason:'restart_scan'`
without a lease. Generations fence queue changes, not changes to time, grants
or shared ledgers, so refresh eligibility before scheduling and sending.

## Hourly discovery and processing every 15 minutes

The intended cadence is two separate owner-agent jobs. Hourly browser discovery
ingests new observations in batches of at most two, using `records:[]` when
there are none so expiry housekeeping runs. Reading a notification never deletes
a pending queue item. A separate processor runs every 900 seconds while fresh,
complete readiness shows some eligible instant before expiry. A known future
budget or spacing reset before expiry may keep it enabled; individual ticks
still skip work that is not yet due. Empty, expired, terminal, unknown-only or
indefinitely blocked work pauses the processor. Hourly discovery remains enabled
and can resume it when new actionable work appears.

Scheduler support must be verified in the actual owner platform. An API with
an hourly minimum cannot implement this processor: report `scheduler_unsupported`
and retain durable work until an authorized invocation or expiry. Do not claim
15-minute operation, chain one-time jobs to evade a limit, or invent a backend
callback credential. Where explicitly supported, the requested exact recurrence
is `RRULE:FREQ=MINUTELY;INTERVAL=15`, starting at the eligible backend UTC instant.
Preserve that instant if the platform also requires the user's personal timezone.
No scheduler adapter or active schedule is established by this candidate.

The processor key is `reply-queue-processor:<account_id>`; this is an owner-only
runtime key, never public account data. Its desired state binds the key,
`queue_generation`, enable/pause action and 900-second interval in
`desired_state_id`. Backend handoffs and the pure
`reconcileReplyQueueProcessor` planner always return `scheduled:false`.
Only a verified platform result can establish that a task actually exists.

The trusted owner adapter must implement this handshake:

1. Obtain complete fresh readiness and a fresh lookup for the exact processor
   key. Failed or ambiguous lookup means `unknown`, not `missing`; multiple
   matches must be reconciled before another task can be created.
2. Give the desired state and normalized platform observation to the planner.
   Its actions are `enable`, `pause`, `inspect_scheduler`, `continue_scan`,
   `acknowledge_current` or `none`. A prior acknowledgement never overrides an
   actual missing, disabled or wrong-cadence task.
3. Only with verified 900-second recurrence support and the reviewed publish
   bridge available, create one task after confirmed absence, or update/resume
   the existing task. A complete pause result targets only that processor;
   it leaves discovery running. Follow the platform's connector-access checks.
4. Bind the real acknowledged task ID, actual schedule, desired-state ID,
   generation and action in durable owner storage. A deterministic key alone
   is not an API idempotency guarantee. On a lost acknowledgement, look up the
   platform task before retrying a mutation.
5. Refresh both readiness and actual platform state after changes. Reconcile
   delayed pause/resume responses to the newest desired state, serializing
   changes per key where possible. Every later discovery/processor turn repeats
   the lookup so stale acknowledgements cannot hide lost tasks.

Each processor turn performs expiry housekeeping and fresh readiness before
claiming at most one due item. It obtains fresh browser conversation/value/STOP
review and uses only the reviewed queue decision/publish bridge under that claim.
If fresh context, approval or a live claim is unavailable, it skips publication.
It reconciles uncertain receipts locally and refreshes readiness after the result.
It performs no paid discovery polling. A scheduler tick is never approval.

For example, two observations at 10:00 can remain queued independently. If a
reviewed sender confirms the first at 10:00, the second may become eligible at
10:15, subject to fresh review and all other caps. If confirmation occurs at
10:02, a 10:15 tick is too early: the earliest eligible instant is 10:17, and an
ordinary quarter-hour processor would next have an opportunity at 10:30.
Neither timing guarantees a send; the fixed expiry still applies.

## Schema, rollback and release boundary

The public baseline ends at 0006. Queue migrations retain their fixed 0008–0011
numbers; no additional public 0007 migration is required. Apply them in this order:

1. `backend/migrations/0008_reply_queue.sql`
2. `backend/migrations/0009_reply_queue_service.sql`
3. `backend/migrations/0010_reply_queue_expiry.sql`
4. `backend/migrations/0011_reply_queue_review.sql`

Before ordinary D1 migration setup, configure the private D1 binding with
`"migrations_dir":"migrations"` and
`"migrations_pattern":"migrations/000[1-6]*.sql"`. This selects the six baseline
files and excludes queue SQL from the ordinary migration command.
[Cloudflare supports this migration pattern setting](https://developers.cloudflare.com/d1/reference/migrations/).
After applying the baseline public migrations through `0006_ongoing.sql`,
administrators may enable `ONGOING_MAINTENANCE_ENABLED` with all activity and
`SERVICE_QUEUE_ENABLED` disabled. The linked owner signs in at `/owner` and uses
**Apply reviewed queue migration**. The fixed POST route is
`/owner/maintenance/reply-queue-migrate`; it requires the owner session, matching
account, same origin and CSRF form token. There is no caller-selected SQL.

The route verifies actual baseline schema definitions and a complete fixed queue
schema fingerprint. It atomically applies only the missing recognized suffix of
0008–0011 and its file-hash journal. Unknown schemas, externally applied but
unjournaled queue prefixes, tampering and replay fail closed. It never adopts,
resets, refunds or destructively rolls back state. Do not separately apply these
queue files through D1 migrations and then ask the owner route to adopt them.

Queue initialization enables no activity. The first authenticated mutation binds
an empty queue to its owner; a nonempty unbound queue fails closed. Legacy expiry
backfill preserves original first-seen time and marks its source time unknown;
legitimate source rediscovery may confirm it without renewing that deadline.
Reconciliation evidence and activation remain separate reviewed setup actions.

Rollback disables queue invocation and preserves schema, fixed deadlines,
deduplication rows, owner bindings, replay receipts, intents and dispatch proofs.
Keep older code that ignores expiry from processing retained work. Do not erase
claims, renew old drafts or send those targets through a path that ignores queue
tombstones. Retained unknown outcomes still require reconciliation.

The frontend gates are `X_REPLY_QUEUE_ENABLED`,
`X_REPLY_QUEUE_MUTATIONS_ENABLED` and `X_REPLY_QUEUE_SEND_ENABLED`, all disabled
when unset. They only expose operations; backend gates, owner/account binding,
reconciliation, grant state and immutable credit policies still control activity.
Use `node backend/scripts/queue-frontend-contract.mjs` and
`node backend/scripts/sync-queue-contracts.mjs` to regenerate the public contract
and frontend policy copies after reviewed changes. `node
backend/scripts/compile-queue-migrations.mjs --check` pins fixed SQL statements,
file hashes and every queue schema prefix.

Apply the connector overlay only to a fresh unregistered supported Sites starter,
using `frontend/scripts/apply-sites-overlay.mjs`; the overlay includes the queue
skill and preserves the generated platform authentication. Configure the example
owner email and paired frontend/backend trust pins for the new deployment through
its reviewed setup workflow. No new signing-key endpoint is introduced.
