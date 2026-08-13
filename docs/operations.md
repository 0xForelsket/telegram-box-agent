# Operations

## Service ownership

The Cloudflare Worker is the system of record for authorization and routing.
Redis is the durable state dependency. Box is disposable execution capacity.
R2 is private artifact storage. Telegram is the user-facing delivery channel.

## Limits

Default Box controls:

- owner-only execution unless trusted group mode is enabled
- two concurrent active jobs for the bound group
- five starts per user per Kuala Lumpur calendar day
- 12 model responses per job
- 256K maximum input context per response
- 64K maximum output per response
- $1 maximum DeepSeek model spend per job
- no application-level execution deadline

The lack of a fixed execution deadline is intentional. Operators should still
monitor stuck jobs and provider/platform maximum runtimes.

## Cost model

The deployment is free-tier-first, not guaranteed free. Upstash Box allowances,
Workers, Redis, R2 operations, Telegram delivery, and model-provider pricing can
all change. DeepSeek is BYOK. GLM coding-plan use is owner-only and follows the
provider's plan rules.

Update the three `BOX_DEEPSEEK_*_USD_PER_MTOKENS` values whenever pricing
changes. Startup validation must fail closed if the configured worst-case usage
can exceed $1. Provider-side hard budgets remain necessary because host-attached
authorization can be exercised by code in the Box without revealing the key.

## Observability

Use `/status`, `/usage`, `/cache`, `/agent status`, and the owner dashboard for
application-level telemetry. Log job IDs, run IDs, state transitions, provider
categories, latency, and retry decisions; never log prompts by default or any
authorization material.

Recommended production alerts:

- repeated callback verification failures
- QStash signature failures or scheduled-run attestation mismatches
- provisioning or snapshot restore failure rate
- jobs stuck in non-terminal states
- cleanup leases repeatedly failing
- Telegram delivery retry backlog
- R2 upload or lifecycle failures
- provider quota/authentication failures
- rate-card validation failure after configuration changes

## Failure recovery

- Worker retry before job creation: admission lock and idempotent update handling
  prevent duplicate jobs.
- Duplicate callback: accepted idempotently without duplicate Telegram delivery.
- Telegram failure: completion delivery lease is released and retried.
- R2 upload retry: artifact idempotency reuses the same manifest/object.
- Cleanup failure: terminal record remains and recovery retries Box deletion.
- Approval expiry: job becomes failed rather than executing an old action.
- Provisioning failure: job is marked failed and any created Box is deleted.

Cloudflare cron may repair terminal delivery and cleanup plus process reminders
and digests. It must never advance Box reasoning or poll active jobs as an agent
loop.

## Release checklist

1. `npm ci`
2. `npm test`
3. `npm run typecheck`
4. `npm run build`
5. `npm audit --omit=dev`
6. Full current-tree and Git-history secret scan
7. Verify no production IDs, URLs, screenshots, logs, or generated output are staged
8. Verify R2 lifecycle and private access
9. Verify snapshot and both configured model routes
10. Deploy disabled, smoke test, then enable
11. Complete a real Telegram artifact job
12. Record version, snapshot ID, and rollback target outside the public repository
