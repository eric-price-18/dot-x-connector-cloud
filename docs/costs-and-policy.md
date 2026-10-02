# Costs and platform rules

Checked 2 October 2026. Rates, availability and policy can change; recheck the linked sources before enabling live access.

## Hosting

Cloudflare Workers Free lists 100,000 requests/day and 10 ms CPU per invocation. Paid Workers begins at $5 USD/month. Free-plan suitability still needs real CPU measurement for the deployed workload. [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)

Cloudflare D1 Free lists five million rows read/day, 100,000 rows written/day and 5 GB total storage. Exceeding free limits causes errors until limits reset or capacity is addressed. [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)

These allowances do not establish that the full service is free: X usage, identity-provider plans and availability of private Sites hosting are separate.

## X usage

X currently uses prepaid, pay-per-use credits. Listed examples are $0.015 per ordinary post and $0.200 for a post containing a URL. Standard post reads are $0.005 per returned resource; qualifying own-account reads are $0.001. Eligibility depends on the endpoint and account relationship.

Verify the exact endpoint's current charge in the Developer Console. Set a provider spending limit and deliberately choose whether auto-recharge is enabled. Daily billing deduplication is a soft guarantee, and a credit balance can become slightly negative. A local counter or cached estimate is not proof of the final bill. [X pricing and spending controls](https://docs.x.com/x-api/getting-started/pricing)

## Automation

X prohibits non-API automation and automated likes. Its rules require prior written, explicit X approval to deploy or operate an AI reply bot, with other requirements applying to automated responses. A working OAuth flow or a user's permission does not establish platform approval. [X automation rules](https://help.x.com/en/rules-and-policies/x-automation)

The public example must keep replies off unless the final implementation and the operator's platform approval support the intended use. Follow current policy and honor opt-outs. Avoid bulk or repetitive posting.
