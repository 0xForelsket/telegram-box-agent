# Upstash Box runtime

## Snapshot contents

`scripts/build-box-snapshot.mjs` prepares a reusable snapshot with:

- Node.js and Python
- Pi coding agent and Pi model SDK, pinned by `src/agent/box/pi_runtime.ts`
- Chromium and Playwright dependencies
- LaTeX/PDF tooling and common document converters
- office, image, archive, media, OCR, data, and build utilities
- the custom Pi harness, protected-action extension, and artifact helper

The snapshot avoids reinstalling the complete toolchain for every immediate job.
The Worker still rewrites the harness and execution-policy files during launch
so a stale snapshot cannot silently retain an older safety policy.

```bash
npm run snapshot:build
npm run snapshot:verify
```

Store the resulting snapshot ID as `BOX_SNAPSHOT_ID`. Pin `@upstash/box` and the
Pi packages; verify a new snapshot before changing any pinned version.

## Model routes

### DeepSeek

DeepSeek is the default general-purpose route. The Worker validates the
configured rate card against 256K maximum input context, 64K maximum output per
response, 12 model responses, and a $1 per-job model-spend ceiling. The harness
also meters provider requests and refuses requests outside those bounds.

### GLM coding plan

The GLM route is owner-only and accepted only for coding-oriented requests. It
uses the same context and response-count controls. Because subscription-plan
accounting may not expose an equivalent dollar rate, the DeepSeek dollar gate
does not represent GLM plan consumption.

## Secret handling

Pi requires non-empty provider variables for discovery. The Box receives a
literal non-secret placeholder such as `host-injected`; the actual authorization
header is configured through Upstash `attachHeaders` for the exact provider
hostname. Provider key material therefore does not appear in Box environment
variables, files, or process memory.

This prevents direct key disclosure, but code in the Box can still cause
requests to a matched provider hostname. Use provider-side hard spend limits,
retain application quotas, and keep group-member execution disabled unless all
members are trusted.

## Network policy

Research requires broad public-web access, so the runtime uses custom egress
with provider hostnames and common public suffixes allowlisted. Upstash custom
policy blocks private IP ranges even for permitted hostnames. Deployments that
need an uncommon public suffix must add it deliberately to
`BOX_NETWORK_POLICY.allowedDomains`.

Permanent third-party integration credentials are not passed to Box. Recognized
deployment, payment, destructive, push, and communication commands pause for an
owner approval, but this classifier is not complete mediation; see the security
documentation.

## Files and artifacts

Telegram documents up to the Bot API download limit are provided to Box as
prompt files. Text inputs are appended safely to the prompt; binary inputs are
written to randomized files under `/workspace/home`.

The publishing helper requests short-lived upload authorization from the
Worker, then streams bytes to an authenticated Worker upload URL. It never
receives R2 account credentials. Manifests and object keys are job-scoped and
idempotent.

## Lifecycle

- Immediate job: fresh Box, run, callback, publish/deliver, delete.
- Approval: pause on a recognized protected action, owner grants the exact
  nonce/action hash, resume the same Pi session, consume the grant once.
- Schedule: one persistent Box per owner-managed schedule.
- Recovery: Redis delivery and cleanup leases let cron repair terminal side
  effects, but cron never advances agent reasoning.
