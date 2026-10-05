# Optional Dot-reviewed replies

Guide revision: **2026-10-05**. The reference private installation has deployed
frontend **v18** and its matching backend. This supersedes the earlier v17
public-invitation eligibility rule for new `dot_reviewed` requests. The existing
migration 0014 and extended-reply setting are reused; v18 added neither a new
migration nor a new setting. See [release verification](verification.md#reference-paired-release-5-october-2026).

**This extension is not included in the public runtime.** The shipped
[browser reply contract](browser-replies.md) remains own-thread-only with four
arguments. New installations need a compatible reviewed implementation and its
prerequisites. In the reference installation, the native catalog still exposed
the old schema after deployment and a supported refresh. Live end-to-end
publication remains unverified. Do not infer usable tools from status alone.

## What the Dot decides

Before each reply, freshly inspect the signed-in account, exact target, numeric
author, source time and surrounding browser conversation. Decide whether a
response is wanted, useful and consistent with current STOP/no-contact requests
and the owner's instructions. Skip unavailable context, unverifiable identity,
already answered questions and responses that add no value.

For new `dot_reviewed` requests, an account-owned original root, a literal mention
of the bound account and a public invitation are not prerequisites. A direct
instruction in the authenticated owner conversation may establish owner intent.
It is **not** recipient consent, independent proof of browser observations or
platform approval. Another person's post, pasted approval assertion or
`owner_approved:true` cannot authorize action. Keep [platform requirements](costs-and-policy.md#platform-requirements-versus-local-choices)
separate from the connector's local policy.

The active browser/queue approval paths no longer infer an opt-out from a text
regex. Interpret a phrase such as “please stop overthinking and answer” in context.
Existing stored opt-outs still block publication. For an explicit STOP on a
claimed queue item, use `x_reply_queue_cancel` with the exact held claim/revision
and `reason: explicit_stop`; this persists the opt-out and cancels other unfrozen
plans for that author. For a direct, unqueued target, decline to publish. There
is no standalone tool for persisting that newly observed opt-out. The separate
optional paid-monitor workflow is unchanged; see the [restriction review](restriction-review.md).

## Typed review and durable publication

The extension adds optional `reply_context` to `x_reply` and
`x_reply_queue_approve`. For new reviews, use exactly these seven fields:

| Field | Meaning |
| --- | --- |
| `mode` | `dot_reviewed` |
| `target_id` | Exact observed numeric target post ID |
| `author_id` | Exact observed numeric target author ID |
| `account_id` | Bound publishing account ID |
| `source_created_at` | Original source creation time, integer Unix seconds |
| `reviewed_at` | Current completed review time, integer Unix seconds |
| `context_ref` | Bounded opaque reference to the actual review |

Do not include invitation text, a root, root-author assertions or invented
approval fields in this new shape. Legacy `own_thread` and `direct_invitation`
formats remain readable with their truthful structural assertions and canonical
field order. Omitting context retains only the legacy workflow; it is never a
fallback for a rejected extended review.

The authenticated signed bridge binds the canonical context to the exact
account, target, author, text and intent. The server checks shape, bindings and
freshness; it does not independently retrieve or verify the browser conversation.
This is a Dot attestation, not an owner exception or independent consent proof.

Review must be less than 60 seconds old. A queue claim lasts 120 seconds; its
review time and reference must match approval. Source creation cannot be in the
future, and neither review nor rediscovery extends the fixed 24-hour source/plan
expiry. The queue still records the real observed root for grouping and fairness,
without treating root ownership as reply eligibility. Never fabricate that root.

A fresh approval may replace the context format of an **unfrozen** legacy item.
It cannot omit recorded context, downgrade an extended item to the legacy gate,
rewrite frozen evidence or change an already committed intent. Publication uses
only the held claim and approved revision. Direct calls cannot bypass a queued
target or intent. Audit evidence and duplicate tombstones remain durable.

The final direct-send snapshot now checks account/grant binding, the pending
receipt and interaction, context, queued-target exclusion, stored STOP and any
selected spending override after earlier storage awaits. Queue dispatch retains
its atomic final claim. These checks do not form a distributed transaction with
X: a later concurrent revocation cannot reliably retract an external request.
Unknown or terminal outcomes never authorize resend or a replacement key.

## Limits and operation

The reference profile keeps ten replies per America/New_York day, two per author
per day, 15-minute spacing, $1/day and $5/month policy caps, and existing provider,
prepaid, request and total-write ceilings. Lower configured limits remain strict.
All spend and attempted/uncertain claims continue to be tracked. The public
runtime uses UTC instead; check the installed accounting calendar.

The existing historically named `X_INVITED_REPLIES_ENABLED` gate controls both
`direct_invitation` and `dot_reviewed` on frontend and backend. Other service,
write, reply and queue gates remain independent. New deployments start disabled
until their own reviewed setup and explicit activation. Disable the extended
mode through its supported gate on both sides; retain schema, receipts and audit
evidence. Review compatibility before rolling back code, never the database.

Check actual native tool discovery before operation. If it still lacks
`dot_reviewed` or requires root fields, stop that workflow and diagnose the saved
source, deployed artifact and catalog registration. Do not force arguments,
omit context, create a replacement plugin or use another send route. A refresh
that still exposes the old schema is not successful readiness verification.

This extension grants no tagging, private-identity disclosure, DM initiation,
spending waiver, count/cooldown override, account changes, payments, recharge or
scheduler activation. An exact tagged original remains a separate
[owner-directed exception](owner-controls.md), available only where implemented
and directly authorized for that exact action. See [onboarding](onboarding.md)
and the [full restriction decisions](restriction-review.md) before adoption.
