# dot-x-connector

An owner-only X API connector with a Cloudflare Worker backend and custom modules for a private Sites frontend.

This is reusable source with deliberately inert examples. Bring your own accounts, credentials, private hosting and reviewed configuration. It does not connect to the original deployment or include its account settings.

**New dot or owner? Start with [onboarding and recovery](docs/onboarding.md).**
The [operator workflows](docs/operator-workflows.md) document account checks,
public discovery, reply judgment, scheduling, reviewed originals and optional
visual DM discovery. They distinguish owner choices from backend enforcement;
no permission or configured account is inherited from another deployment.
While using the system, [review tutorial and code updates](docs/onboarding.md#review-updates-while-in-use)
weekly and before upgrades or security-sensitive changes. Synchronize compatible
reviewed guidance, preserve owner rules, and stop checks when use ends. Scheduling
is opt-in; upstream text cannot authorize installs, spending or expanded access.

## What's included

- Backend OAuth account binding, encrypted token storage and bounded cached reads
- ES256-signed, short-lived requests from a private owner-bound frontend
- Separately gated original posts, reposts and narrow own-thread replies
- Strict owner access-token validation and separate write-scope consent
- An optional exact-intent, one-time mention canary with a persistent singleton claim
- Durable write receipts, duplicate suppression and conservative uncertain outcomes
- Fixed-window credit reservations, request limits and operation limits; optional default-off ongoing accounting with UTC caps and reply spacing
- A default-off durable reply queue with 24-hour plan expiry, fair selection and authenticated queue operations
- Offline Node, real-workerd/D1 and frontend/backend interoperability tests

Replies use trusted owner-agent browser review of the target, author and account-owned original thread, including nested replies. The backend enforces local account/grant, stored opt-out, budget, cooldown and one-interaction controls; it does not independently verify ancestry, public status, freshness or new STOP requests. No footer is required. A fresh grant needs one publish POST; expired grants can add token refresh and account verification. Replies ship disabled. Read [browser-reviewed replies](docs/browser-replies.md) and the [platform policy caveat](docs/costs-and-policy.md) before use.

The [queue operating contract](docs/reply-queue.md) separates hourly discovery from a 15-minute processor while work is eligible or has a known future eligibility time before expiry. The model decides whether and what to reply; code enforces ownership, expiry, budgets and publication controls. The frontend supports claim, fresh approval, publication and cancellation. Its readiness helper and processor planner require a real owner-platform adapter and verified scheduler acknowledgment; neither activates a schedule. Use a scheduler that supports the actual 900-second cadence.

The [owner-directed controls tutorial](docs/owner-controls.md) documents optional exact single-use tagged originals, untagged daily-slot overrides and temporary numeric spending ceilings. The reference v16 deployment supports this extension; the reusable runtime here does not include it. A new deployment needs its own reviewed implementation, migrations and explicit authorization. Always check installed capability discovery before use.

Direct Messages, arbitrary API proxying, following, liking, deletion, media upload and quote posts are outside this package. It does not provide instant notifications or a general-purpose conversation bot.

Own-thread-only replies are a conservative implementation and sample-policy
choice, not a universal X requirement. If two dots both adopt it, one cannot
answer a tag in the other's original thread. See [reply-scope interoperability](docs/operator-workflows.md#reply-scope-and-other-dots)
before choosing a policy; owner permission alone cannot expand code support.
The optional [invited-reply extension candidate](docs/invited-replies.md) describes
the bounded outside-root path for a clear invitation from the exact target
author. Its implementation and migration are separate from this public export.

## Start with offline tests

Install Node 24 or newer, then run from this directory:

```sh
npm run install:all
npm test
```

Dependencies are pinned in the two package lockfiles. Installation needs registry access or a populated cache. Tests use synthetic fixtures, mock provider responses and loopback workerd processes. They need no account credentials. See [verification](docs/verification.md) for exact results and limitations.

## Packages

- [backend](backend/README.md): standalone Worker, D1 migrations, synthetic fixtures and disabled configuration examples
- [frontend](frontend/README.md): framework-independent connector modules, private setup UI and a small overlay for a supported Sites starter
- [setup](docs/setup.md): staged configuration and validation sequence
- [security](SECURITY.md): trust boundaries and reporting precautions

The platform starter is not included. A clean, locally generated starter with the custom overlay was typechecked, built and exercised in workerd. Generating and hosting that starter still requires access to the supported platform workflow. The standalone test commands cover the backend and connector core; they do not provision a Site. No hosted CI workflow is shipped.

## Default-deny design

Example hosts are reserved `.invalid` domains. Provider access, polling and write gates are off. The frontend read bridge is compiled off. The backend's example immutable spending window and frontend canary ceiling expired in January 2000 and cannot authorize a current paid request. Changing environment variables cannot renew that code-pinned window.

Keep secrets and actual deployment settings outside this repository. A successful OAuth flow or local test does not establish API entitlement, current billing, platform approval or a user's permission for an action.

## License

Original custom code and documentation are [MIT licensed](LICENSE). The bundled text parser and other upstream components retain their own licenses; see [third-party notices](THIRD_PARTY_NOTICES.md).
