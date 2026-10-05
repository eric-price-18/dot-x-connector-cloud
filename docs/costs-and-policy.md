# Costs and platform rules

Checked 2 October 2026. Rates, availability and policy can change; recheck the linked sources before enabling live access.

## Hosting

Cloudflare Workers Free lists 100,000 requests/day and 10 ms CPU per invocation. Paid Workers begins at $5 USD/month. Free-plan suitability still needs real CPU measurement for the deployed workload. [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)

Cloudflare D1 Free lists five million rows read/day, 100,000 rows written/day and 5 GB total storage. Exceeding free limits causes errors until limits reset or capacity is addressed. [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)

These allowances do not establish that the full service is free: X usage, identity-provider plans and availability of private Sites hosting are separate.

## X usage

X currently uses prepaid, pay-per-use credits. Listed examples are $0.015 per ordinary post and $0.200 for a post containing a URL. Standard post reads are $0.005 per returned resource; qualifying own-account reads are $0.001. Eligibility depends on the endpoint and account relationship.

Verify the exact endpoint's current charge in the Developer Console. Set a provider spending limit and deliberately choose whether auto-recharge is enabled. Daily billing deduplication is a soft guarantee, and a credit balance can become slightly negative. A local counter or cached estimate is not proof of the final bill. [X pricing and spending controls](https://docs.x.com/x-api/getting-started/pricing)

The optional ongoing accounting path uses those published rates without ownership, deduplication or summoned discounts. It reserves $0.035 before an ordinary URL-free browser-reviewed reply, or $0.22 for URL/ambiguous text; see [the exact breakdown](browser-replies.md). Atomic quota-and-money reservation avoids charging a known local denial. Only a current, provably unattempted call can release its dollar reservation; historical and unknown liabilities remain untouched. The unchanged UTC caps, operation ceiling and spacing still apply. No live reply success is established by these offline tests.

## Platform requirements versus local choices

Automation policy rechecked 5 October 2026 against [X's official rules](https://help.x.com/en/rules-and-policies/x-automation), sections I, II.A, II.B.2–3 and II.C. X prohibits non-API automation and automated likes, requires explicit account-owner consent beyond OAuth, and requires prior written approval for AI reply bots. Automated replies/mentions need recipient opt-in, an opt-out route and one response per interaction. Its examples include a mention that clearly invites a response; not every tag qualifies. Automated DMs have separate consent requirements.

Own-thread-only, the sample cadence, local spending caps and owner conversation approval before a first DM reply are conservative design/policy choices. The linked rules do not establish universal own-thread-only replies. Broader scope requires owner authorization, matching reviewed implementation and platform compliance. The interpretation of a particular interaction or unattended browser-discovery workflow remains context-dependent; this tutorial is not an X approval or exemption. Keep unsupported operations off and resolve uncertainty before activation. See [cross-dot interoperability](operator-workflows.md#reply-scope-and-other-dots).

The official [reply endpoint guide](https://docs.x.com/x-api/posts/manage-tweets/introduction#reply-to-a-post)
describes self-serve replies when the original author explicitly summons the
replying account by mentioning it or quoting its post. That supports invited
interactions outside the responder's own roots; it does not remove other rules.
The [developer guidelines](https://docs.x.com/developer-guidelines#gray-areas-explained)
explicitly treat AI-generated replies without approval as a violation even when
helpful. The [What to Build guide](https://docs.x.com/what-to-build) encourages
mention-responsive AI integrations, but that general encouragement is not an
app-specific approval. Verify actual approval evidence for the intended app/use
case before enabling AI replies; neither this tutorial nor a successful API call
establishes that it exists. These documentation changes expand no runtime scope.
