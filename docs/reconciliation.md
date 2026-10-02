# Initialize and reconcile ongoing accounting

This is the supported generic workflow for this template. It needs no custom UI, SQL authoring or code changes. The administrator installs private billing evidence; the signed-in account owner confirms it through the existing owner page. Nothing in this workflow enables an X call, reply, polling schedule or automatic recharge.

## Grouped human prerequisites

Complete these inputs together:

- The backend already belongs to you, is connected to your intended account, and has working owner sign-in. Use your own account identifier and billing records, never test fixtures.
- The administrator has permission to apply migrations to this backend's D1 database, update this Worker's configuration, deploy this Worker and manage its secrets. The browser operator must authenticate as the configured owner. Existing authorized credentials are sufficient; do not place tokens in commands or source files.
- Check the provider dashboard for the current calendar-month billing cycle, its usage and current prepaid balance. Confirm automatic recharge is off and no other application/account shares that allowance. Save the supporting records privately and compute their SHA-256 digest as `evidence_id`. These are operator attestations; the validator cannot independently verify the dashboard.
- This implementation supports confirmed calendar-month provider cycles only. Its conservative interval starts no earlier than the month's first day at 12:00 UTC and ends no later than the last day at 10:00 UTC, covering uncertain provider timezones from UTC−12 to UTC+14. Use a narrower interval if required. If the provider uses another cycle, stop for an implementation review rather than inventing a calendar month.

The **public local spending calendar is UTC**. The private operational deployment used America/New_York; do not copy that configuration or assume its midnight/DST behavior applies here. Changing the public calendar requires a reviewed ledger transition, not an environment-variable tweak.

## One-pass operator runbook

Run commands from `backend/` in your private deployment checkout, with its pinned dependencies installed. Set `CONNECTOR_CONFIG` to your private Wrangler configuration path and `CONNECTOR_DB` to your configured D1 database name. Keep evidence files outside this source checkout. These commands are for your explicitly approved deployment, not commands this repository runs automatically.

1. Shut down activity in that private configuration: set `LIVE_X_ENABLED`, `READ_POLLING_ENABLED`, `POST_ENABLED`, `REPLY_ENABLED`, `SERVICE_WRITE_ENABLED`, `X_ORIGINAL_POSTS_ENABLED`, `X_REPOSTS_ENABLED`, `X_OWN_THREAD_REPLIES_ENABLED`, and `X_ONGOING_OPERATIONS_ENABLED` to `"false"`; retain an empty cron list. Keep the existing owner sign-in/identity-provider settings available. Temporarily set only `ONGOING_MAINTENANCE_ENABLED` to `"true"`. Deploy this shutdown configuration and wait for prior requests to finish. Do not erase pending/unknown receipts.

   ```sh
   npm exec -- wrangler deploy --config "$CONNECTOR_CONFIG"
   npm exec -- wrangler d1 migrations apply "$CONNECTOR_DB" --remote --config "$CONNECTOR_CONFIG"
   ```

   Apply every shipped migration, including `0006_ongoing.sql`. The handler checks that the required schema matches the shipped definitions. A failed or incompatible migration is a stop, not permission to replace tables.

2. Create a private JSON evidence file with exactly these fields. Money is integer micro-USD: $1 is `1000000`. Times are integer Unix seconds. `observed_at` must describe a dashboard observation within the preceding hour; refreshing this timestamp without rechecking the evidence is invalid. The account ID must exactly match the connected backend account.

   ```json
   {
     "account_id": "YOUR_NUMERIC_ACCOUNT_ID",
     "observed_at": 0,
     "cycle_start": 0,
     "cycle_end": 0,
     "provider_cycle_month": "YYYY-MM",
     "confirmed_used_micro_usd": 0,
     "confirmed_prepaid_micro_usd": 0,
     "evidence_id": "SHA256_OF_YOUR_PRIVATE_SUPPORTING_RECORDS",
     "auto_recharge_off": true,
     "exclusive_billing": true
   }
   ```

   Replace all placeholders and amounts with verified values. The zero timestamps are deliberately invalid; this example cannot authorize spending. `confirmed_prepaid_micro_usd` is the current confirmed remaining prepaid balance, not a new credit grant.

3. Validate locally and install the result as a secret on the same Worker. `EVIDENCE_INPUT` and `RECONCILIATION_OUTPUT` are absolute private file paths outside the repository; the output must not already exist.

   ```sh
   node scripts/prepare-reconciliation.mjs "$EVIDENCE_INPUT" "$RECONCILIATION_OUTPUT"
   npm exec -- wrangler secret put ONGOING_RECONCILIATION_JSON --config "$CONNECTOR_CONFIG" < "$RECONCILIATION_OUTPUT"
   ```

   The local helper performs no network access and writes the validated output with restrictive file permissions. Do not put evidence in a public commit, command-line literal, tutorial or support log. If secret installation or deployment fails, stop and inspect that exact error.

4. Open your backend's `/owner` page and sign in as its configured owner. Under **Spending reconciliation**, choose **Apply spending reconciliation**. The browser sends only its CSRF value; it cannot submit SQL, balances or exceptions. The handler binds the account, verifies the administrator-installed evidence, and atomically records the cycle and any existing liabilities. A successful response says reconciliation completed and activity remains disabled. Replaying the same cycle is rejected without resetting anything.

5. Set `ONGOING_MAINTENANCE_ENABLED` back to `"false"`, delete the temporary Worker secret, and deploy. Keep all X activity off while reviewing the result.

   ```sh
   npm exec -- wrangler secret delete ONGOING_RECONCILIATION_JSON --config "$CONNECTOR_CONFIG"
   npm exec -- wrangler deploy --config "$CONNECTOR_CONFIG"
   ```

6. After the separate policy, consent and operation approvals in [setup](setup.md), a reviewed private configuration may opt into `X_ONGOING_OPERATIONS_ENABLED` and only the desired operation gates. Review `/owner/monitor-status` while signed in: it reports local reservations, never authoritative provider billing. Keep polling and cron off when human browser notification checks supply candidate IDs. Reply execution still requires fresh API ownership/eligibility/STOP checks and the full $0.175 plain-text or $0.36 URL/ambiguous reservation; five replies is a ceiling, not a guaranteed throughput.

## Subsequent months and conservative stops

Repeat this same shutdown/evidence/form/cleanup workflow for each new supported provider month. New months do not replenish the original prepaid authorization, erase liabilities or create historical exemptions. The sample $1/day and $5/month UTC limits remain independent of the provider interval.

Legacy reservations are carried automatically, in full, into the activation day/month and ongoing credit authorization. Unknown send/refresh liabilities must already have sufficient recorded reservation coverage; otherwise the transaction fails and changes nothing. The public workflow does not provide liability forgiveness, same-month evidence replacement, credit top-ups, timezone changes or non-calendar billing cycles. Those are explicit review boundaries, not missing steps an operator should bypass with ad hoc SQL. A fresh account with valid evidence can complete the workflow above without writing code.
