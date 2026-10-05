# Nested replies in this public checkout

Direct and nested replies now use the [browser-reviewed reply workflow](browser-replies.md). The trusted owner-agent must establish that the original root belongs to the bound account; participation in another account's thread is insufficient.

The normal service no longer performs paid target/root/ancestor/author/STOP scans, does not enforce a four-ancestor depth limit, and requires no footer. It cannot independently prove the browser assertions. Retained historical guard helpers and standalone tests are not guarantees of the current service path.

All default-off gates, generic UTC limits, local stored opt-outs, account/grant fences, target uniqueness and immutable receipts remain. Use the four required arguments and skip when target or author identity cannot be verified without guessing. See the current guide for cost bounds, the refresh exception and model responsibilities.

The separately deployed [Dot-reviewed extension](invited-replies.md) does not require root ownership for new reviews. Its real queue root remains grouping metadata. That extension is not included in the four-argument public runtime described above.
