# Telegram Box Agent

A Telegram webhook is a good place to authorize, route, and acknowledge work.
It is a bad place to run a browser, install packages, compile documents, or keep
an agent alive long enough to produce a multi-file deliverable.

Telegram Box Agent is an opinionated split-runtime answer: keep the control
plane serverless, and move only execution-heavy requests into an isolated,
on-demand sandbox.

- Cloudflare Workers handle chat, authorization, routing, Redis-backed state,
  reminders, digests, callbacks, and private artifact delivery.
- Upstash Box runs long-lived agent work that needs shell commands, files,
  packages, browsers, code execution, or document generation.

The Worker acknowledges a durable job immediately; Box performs the long-lived
work and returns results through authenticated callbacks. The user gets a normal
Telegram conversation plus asynchronous PDFs, spreadsheets, archives, images,
or other artifacts without a cron-driven agent loop.

> Status: public preview. It is suitable for self-hosted experiments with
> trusted users. Upstash Box is still a preview dependency, and the protected
> shell-action approval classifier is a guardrail rather than a complete
> external-write security boundary. Read [SECURITY.md](SECURITY.md) before
> exposing Box execution to a group.

## Verify the control plane locally

The provider-free demo exercises the real deterministic router, Redis record
model, asynchronous job state machine, signed completion callback, delivery
leases, cleanup, and private-artifact link generation using in-memory adapters.
It does not contact Telegram, Cloudflare, Redis, R2, Upstash Box, or a model
provider.

```bash
npm ci
npm run demo
```

Expected flow:

```text
1. Router: Box
2. Accepted immediately: <job-id> (queued)
3. Execution plane attached: running
4. Signed callback applied: succeeded
5. Telegram message: Box job <job-id>: succeeded
6. Private artifact delivery: serverless-sandbox-report.pdf (24-hour signed URL)
```

[Open the sample generated PDF](docs/assets/sample-box-artifact.pdf).

![Sample PDF artifact](docs/assets/sample-box-artifact.png)

```mermaid
flowchart LR
    T["Telegram"] --> W["Cloudflare Worker control plane"]
    W --> C["Ordinary chat providers"]
    W <--> R["Upstash Redis job and chat state"]
    W --> B["Upstash Box with Pi"]
    B --> M["DeepSeek or owner GLM route"]
    B -->|"signed callback"| W
    B -->|"job-scoped upload"| A["Private Cloudflare R2"]
    W -->|"message, file, signed link"| T
```

## Architectural trade-offs

| Decision                                       | What it buys                                                                                       | What it costs                                                                                |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Cloudflare Worker control plane                | Fast webhook handling, centralized authorization, durable job state, and private artifact delivery | Redis, R2, and callback state machines add operational surface area                          |
| Fresh Box for each immediate job               | Filesystem, shell, browser, packages, and a longer execution lifetime outside the request handler  | Snapshot maintenance and sandbox startup overhead; Upstash Box is still a preview dependency |
| Deterministic pre-routing                      | Predictable cost and no model turn spent deciding where work runs                                  | Heuristics can misroute; `/agent` and `/quick` are explicit escape hatches                   |
| Signed callbacks and scoped artifact authority | The execution plane does not receive permanent storage credentials                                 | More lifecycle states, retries, leases, and cleanup paths to test                            |
| Protected-action approval classifier           | A useful owner checkpoint for recognized shell writes                                              | Defense in depth only; it is not complete mediation or an audited security boundary          |

The current `npm run build` dry run reports a 912.72 KiB Worker upload
(190.42 KiB gzip). The provider-free demo covers the queue-to-callback lifecycle,
but it is not a production latency benchmark; credentialed Telegram, Box, R2,
and provider acceptance checks remain separate.

## Capabilities

- Deterministic hybrid routing with `/agent` and `/quick` overrides
- Asynchronous jobs, cancellation, owner-managed schedules, and approval/resume
- Shell, filesystem, package, browser, code, and document execution through Pi
- Private R2 artifacts with scoped upload authority and expiring download links
- Quotas, concurrency limits, cost gates, authenticated callbacks, and recovery tests

## Routing

`/agent <request>` always uses Box. `/quick <request>` always stays on the
ordinary chat path. Otherwise a deterministic pre-router sends requests to Box
when they clearly require file generation, browser automation, code execution,
repository work, or a multi-step deliverable. The normal model does not spend a
turn deciding whether to hand off.

Documents sent with an explicit `/agent` caption are staged into the job. Inputs
downloaded through Telegram are limited to 20 MB; larger inputs must be supplied
through an accessible URL.

## Deploy ordinary chat

Prerequisites:

- Node.js 22+ (required by Wrangler 4)
- A Cloudflare account and Wrangler login
- A Telegram bot token from BotFather
- An Upstash Redis REST database
- At least one configured chat-model provider

```bash
npm ci
cp .dev.vars.example .dev.vars
npm test
npm run typecheck
npm run dev
```

On Windows PowerShell, use:

```powershell
Copy-Item .dev.vars.example .dev.vars
```

Customize the non-secret values in `wrangler.toml`, add deployment secrets with
`npx wrangler secret put <NAME>`, then deploy with `npx wrangler deploy`.
Register the deployed `/webhook` endpoint with Telegram and include the same
`TELEGRAM_WEBHOOK_SECRET` as Telegram's webhook secret token.

The complete setup, including R2 and Box, is in
[docs/deployment.md](docs/deployment.md).

## Enabling the agent runtime

Agent mode additionally requires an Upstash Box API key, a prepared snapshot,
a provider key, a public callback origin, and private R2 buckets.

```bash
npm run r2:create
npm run r2:lifecycle
npm run snapshot:build
npm run snapshot:verify
```

Deploy with `BOX_AGENT_ENABLED=false`, verify callback and artifact endpoints,
then set it to `true`. In a Telegram group, the configured owner runs:

```text
/box enable
/agent Create a short PDF explaining this architecture
```

Box execution is owner-only by default. `BOX_ALLOW_GROUP_MEMBERS=true` is an
explicit trust decision: every member of the bound group can consume provider
budget and cause model-generated code to run.

## Commands

Core agent commands:

- `/agent [--model deepseek|glm] <request>` — force an immediate Box job
- `/quick <request>` — force ordinary chat
- `/agent status [job-id]` — inspect jobs
- `/agent cancel <job-id>` — cancel an authorized job
- `/agent approve <job-id> <nonce>` — owner-only protected-action approval
- `/agent schedule create <5-field UTC cron> [--model deepseek|glm] <request>` — create an owner-only persistent schedule
- `/agent schedule list` — list schedules
- `/agent schedule pause|resume|delete <schedule-id>` — manage schedules
- `/artifact <artifact-id>` — issue a fresh download link
- `/box enable` — owner-only binding of Box to the current numeric group ID

Run `/help` for chat, search, memory, utility, audio, reminder, and digest
commands.

## Documentation

- [Architecture](docs/architecture.md)
- [Box runtime](docs/box-runtime.md)
- [Deployment](docs/deployment.md)
- [Security and threat model](docs/security.md)
- [Operations and costs](docs/operations.md)
- [Demo and launch checklist](docs/demo.md)
- [Project roadmap](PLAN.md)

## Development and verification

```bash
npm test
npm run typecheck
npm run build
npm audit --omit=dev
```

Tests cover routing overrides, group authorization, quotas, concurrency races,
callback forgery and ordering, retries, cancellation, approval resume, schedules,
cost gates, artifact idempotency, and delivery recovery.

The Telegram entry point is a small facade over responsibility-focused modules:

- [`message_handling.ts`](src/api/telegram/message_handling.ts) — webhook updates, media, callbacks, and transport
- [`authorization.ts`](src/api/telegram/authorization.ts) — private-chat, group, administrator, and owner gates
- [`memory.ts`](src/api/telegram/memory.ts) — prompt state, durable memories, summaries, and chat settings
- [`chat_execution.ts`](src/api/telegram/chat_execution.ts) — provider routing, tools, research, and response generation
- [`scheduling.ts`](src/api/telegram/scheduling.ts) — reminders, digests, cancellable tasks, and agent wake-ups
- [`box_orchestration.ts`](src/api/telegram/box_orchestration.ts) — Box jobs, schedules, callbacks, and artifacts

The command registry follows the same pattern: [`commands.ts`](src/config/commands.ts) aggregates core,
utility, Box, and personal command modules instead of defining every command in
one file.

`npm run demo` is deterministic integration proof for the local control plane.
The Box snapshot, provider routes, Telegram delivery, R2 lifecycle, and deployed
callback origin still require the credentialed acceptance checks in
[docs/deployment.md](docs/deployment.md); CI does not claim to emulate those
external services.

## Security defaults

- Authorization fails closed. With both `WHITELISTED_USERS` and
  `WHITELISTED_GROUPS` empty the bot denies every request, and the `/webhook`
  endpoint rejects all traffic unless `TELEGRAM_WEBHOOK_SECRET` is configured
  and matches Telegram's secret token.
- `WHITELISTED_GROUPS` authorizes everyone who speaks in a listed group, scoped
  to that group only — it never grants private-chat access. Treat it as a
  statement that every current and future member of that group is trusted.
- `OWNER_USER_ID` is never inferred. It is required for owner-only commands and
  mandatory when `BOX_AGENT_ENABLED=true`.
- Secrets belong in Wrangler secrets or `.dev.vars`, never source control.
- Model-provider authorization is attached by the Box host to the exact provider
  hostname; the secret does not enter the container.
- URL fetching rejects private, loopback, link-local, metadata, and reserved
  addresses, including IPv4 smuggled inside IPv6. This is defence in depth: a
  Worker resolves DNS inside `fetch`, so a public hostname pointing at an
  internal address cannot be caught before the request leaves, and Cloudflare's
  egress policy is the boundary that actually stops it.
- R2 is private. Artifact upload and download authority is short-lived and scoped.
- Permanent third-party integration credentials are not supplied to Box.
- Group-member Box execution is disabled unless explicitly enabled.

See [SECURITY.md](SECURITY.md) and [docs/security.md](docs/security.md) for the
remaining limitations.

## Free-tier-first, not free forever

The design can fit within several providers' free tiers for light personal use,
but model requests are BYOK, free allowances are finite, and prices can change.
The runtime validates configured DeepSeek rates against its worst-case job bound
and fails closed if the configured limits could exceed the $1 model-spend cap.

## License

Licensed under the [MIT License](LICENSE).
