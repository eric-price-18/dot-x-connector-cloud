// Public source is intentionally expired and cannot authorize paid X requests.
// Keep these code-level pins immutable: deployment requires a reviewed new
// fixed window; environment variables must never renew or widen it.
export const CREDIT_RUN_ID='example-disabled-budget';
export const CREDIT_RUN_DEADLINE=Date.parse('2000-01-02T08:00:00Z')/1000;
export const CREDIT_MAX_MICROUSD=5000000;
