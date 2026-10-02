# dot-x-connector

An owner-only X API connector with a Cloudflare Worker backend and custom modules for a private Sites frontend.

This is reusable source with deliberately inert examples. Bring your own accounts, credentials, private hosting and reviewed configuration. It does not connect to the original deployment or include its account settings.

## What's included

- Backend OAuth account binding, encrypted token storage and bounded cached reads
- ES256-signed, short-lived requests from a private owner-bound frontend
- Separately gated original posts, reposts and narrow own-thread replies
- Strict owner access-token validation and separate write-scope consent
- An optional exact-intent, one-time mention canary with a persistent singleton claim
- Durable write receipts, duplicate suppression and conservative uncertain outcomes
- Fixed-window credit reservations, request limits and operation limits; optional default-off ongoing accounting with UTC caps and reply spacing
- Offline Node, real-workerd/D1 and frontend/backend interoperability tests

The own-thread reply implementation considers eligible direct and nested responses inside an account-owned original thread, after fresh bounded parent-chain verification. It checks public authorship, freshness, opt-outs and one automated reply per interaction, and requires an opt-out notice. Replies ship disabled. Review the [platform policy caveat](docs/costs-and-policy.md) before use.

Direct Messages, arbitrary API proxying, following, liking, deletion, media upload and quote posts are outside this package. It does not provide instant notifications or a general-purpose conversation bot.

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
