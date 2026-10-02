# Security notes

Keep credentials, tokens, account configuration, live public-key pins, database contents and logs out of public reports. Use a private vulnerability-reporting channel once one has been configured for the repository. Do not assume a public issue is private.

The intended security boundary is one authenticated owner, one bound X account and fixed backend destinations. Validate issuer, subject, audience, expiry, operation, exact request digest and idempotency data server-side. Deny redirects for signed requests. Keep signing and token material out of responses and logs.

A durable write ledger reduces duplicate sends but cannot guarantee exactly-once delivery across an external network. A crash after X accepts a request can leave an uncertain receipt. Preserve that uncertainty and require investigation rather than automatic resend.

Local mock tests exercise protocol and failure behavior. They cannot prove platform approval, production entitlement, provider privacy guarantees or correct configuration of someone else's deployment.
