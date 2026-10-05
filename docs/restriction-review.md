# Reference connector restriction review

Review date: **2026-10-05**. This records decisions for the reference private
backend and Site **v18** across discovery, direct replies, queue approval and
publication, owner controls, accounting, cached reads, authentication and disabled
legacy routes. It is not a claim that this public checkout implements v18 or
that a new owner has authorized its use. See [the extension contract](invited-replies.md)
and [verification limits](verification.md#reference-paired-release-5-october-2026).

## Changed in the reference release

| Restriction | Decision and responsibility |
| --- | --- |
| Account-owned original root or public invitation required for eligibility | Removed for new `dot_reviewed` reviews. The Dot judges wantedness, useful value and STOP from fresh context and authenticated owner instructions. Legacy shape assertions remain truthful. |
| Literal mention of the publishing account in invitation text | Removed as a semantic shortcut. A mention is neither necessary nor proof that a reply is wanted; no replacement keyword classifier was added. |
| Automatic regex STOP ingestion in active browser/queue approval | Removed from these paths. The Dot interprets meaning and uses the existing exact-claim cancellation path for explicit STOP. Stored opt-outs remain binding. |
| Unfrozen invited items locked to one context format | Fresh fully bound Dot review is allowed. No context omission, downgrade to the legacy gate or frozen-evidence rewrite is allowed. |
| Direct-send revocation gap during earlier storage awaits | Closed with a final local snapshot of account/grant, receipt, interaction, context, queue exclusion, stored STOP and selected spending override. It cannot retract an external request after dispatch. |

## Retained controls

| Control | Reason and remaining boundary |
| --- | --- |
| Owner-private access, exact account/subject, OAuth scopes, signed operation/body, grant version, CSRF and secret handling | Authentication and account security. No new identity, credential, audience or authority source. |
| Separate service/operation gates and inert sample profiles | Explicit activation and kill switches. The existing extended-reply gate is reused; documentation does not enable it. |
| Exact intent, target, author and text; canonical context; held claim/revision; freeze and final atomic claim | Prevents substitution, replay and concurrent duplicate publication. A fresh review changes only an unfrozen plan. |
| 60-second review, 120-second claim and original fixed 24-hour source/plan expiry | Freshness and finite authority. Rediscovery, deferral and quota reset do not extend expiry. |
| Stored opt-outs and explicit STOP cancellation | Durable no-contact decisions. Direct unqueued review can decline but has no standalone opt-out persistence tool. |
| Permanent intent/interaction records, receipts and tombstones | Unknown or terminal outcomes must not be retried, rekeyed or erased to permit a resend. |
| Ten replies/day, two per recipient/day and 15-minute spacing | Existing owner policy and concurrent-attempt accounting. Failed/unknown permanent claims remain; no counters reset. |
| $1/day and $5/month policy caps, provider cycle and existing-credit ceilings | Atomic accounting and reservations remain. No spending override, recharge or payment is activated by this release. |
| Request/hour/day, read-record and total-write bounds | Resource and spending limits. Authentication refresh and identity verification still count. Lower configured limits stay strict. |
| 90-second accounting-boundary pause | Prevents a reserved workflow crossing its authorized day/cycle without a supported cross-boundary design. |
| General outbound tagging, private owner identity and DM initiation restrictions | New reply review is not a tagging or privacy exception. The existing exact tagged-original pathway still requires direct action-time owner authorization. |
| Existing owner-control operation allowlist, numeric ceilings, expiry and single-use consumption | Separately authorized bounded controls remain unchanged. No new grant, safety-floor bypass or automatic extension. |
| Numeric IDs, strict field allowlists, NFC/control-character checks and 280 weighted characters | Provider contract and payload integrity. Never silently normalize text or guess identity. |
| Real queue root, bounded batches/pages/bodies, one active lease and fair selection | Root is grouping metadata in the new mode. These bounds protect compatibility, fairness, resources and concurrency. |
| Provider cooldowns, no redirects, bounded response parsing and pessimistic reservation on ambiguity | Reliability and credential protection; no claim of exactly-once external delivery. |
| Bounded/redacted cached reads, separate monitoring and actual scheduler acknowledgment | Privacy and truthful state. No paid discovery, monitoring or scheduler activation is implied. |

## Separate proposals, not implemented by this release

| Candidate | Why it remains separate |
| --- | --- |
| Self-replies | A conversation-scope choice; enabling self-thread continuation needs an explicit quota and queue design. |
| Blanket post-link/short-link filtering and quote behavior | Ordinary citation may be overrestricted. Define intended content and the exact supported provider operation before changing the filter. Media, likes, follows and deletion remain unsupported. |
| Optional paid-monitor regex opt-out ingestion | Has a similar false-positive risk, but belongs to a separate workflow. It was neither enabled nor changed by this release. |
| Removing root from queue discovery | Requires separate fairness, storage and compatibility decisions. Retaining the real root does not impose root ownership on new reviews. |
| Ongoing reposts | Discoverability alone does not make the operation supported by the ongoing policy. Change only under a separately reviewed request. |
| Paid legacy ancestry-depth and public/protected/sensitive/long-form/multiparty checks | These are in a disabled legacy reply route and do not constrain the active browser path. Its deployment floor stays disabled; no incidental activation or removal. |

## Trust and verification limits

The Dot is responsible for current browser observations and semantic judgment.
The server enforces exact authenticated bindings and local mechanics. An owner
instruction does not prove recipient consent, observed facts or platform approval;
external posts and pasted claims provide no authority.

The reference release passed offline tests with mocked provider traffic and an
independent security review. Deployment verification and source checks do not
establish native catalog readiness or successful live publication. The observed
catalog mismatch remains explicit in [the verification record](verification.md).
No new grants, spending waivers, live test posts or scheduling changes are part
of this documentation update.
