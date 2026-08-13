# Telegram Box Agent Improvement Plan

## Product Goal

Build a highly useful personal Telegram assistant with a free-tier-first hybrid architecture. Cloudflare Workers remains the always-on Telegram control plane, while isolated Upstash Box environments execute long-running agent jobs that need a shell, writable filesystem, packages, browser automation, code execution, or document generation. The bot should give grounded answers, make efficient use of model quotas, remember useful context, and add practical utilities without requiring a permanent server.

This plan is intentionally broader than bug fixing. It covers improvements to search, research, model usage, prompt caching, memory, Telegram usability, personal utilities, reliability, and observability.

## Non-Negotiable Constraints

- The production Telegram webhook, ordinary chat path, authorization, routing, job registry, artifact gateway, reminders, and digests must continue to run on Cloudflare Workers.
- Upstash Redis REST remains the persistent state layer unless a free, Worker-compatible replacement has a clear advantage.
- Upstash Box is the only planned non-Worker compute plane. Do not require a VPS, desktop bridge, or user-operated always-on machine.
- Shells, subprocesses, browsers, native tools, package installation, and writable filesystems are allowed only inside isolated Box environments, never inside the Worker request path.
- Worker-side network operations must use Worker-compatible HTTP APIs. Box jobs may use their sandboxed network, shell, filesystem, and browser capabilities within job policy.
- Keep the Worker bundle, CPU use, outbound requests, memory use, and scheduled work within the current Cloudflare free-tier limits. Treat Box, DeepSeek, the GLM Coding Plan, R2, and Telegram as independently metered services.
- External providers may have their own quotas or costs. "Runs on a free Worker" does not mean every upstream service is free.
- Expensive or experimental behavior must be optional, capped, and able to fall back safely.
- Pin the Upstash Box SDK because Box is in developer preview, and fail closed when an incompatible API or pricing change invalidates a safety bound.
- Preserve the bot's personality and concise Telegram-first responses.
- Sensitive logging hardening is not a current priority for this personal bot.

Before major deployment changes, recheck the current [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/).

## Existing Bot Instances and State-Safe Rollout

Cloudflare Worker isolates are disposable and are not a source of durable bot state. The bot's conversation history, summaries, profiles, explicit memories, settings, selected model, reminders, feeds, bookmarks, usage counters, and search caches live in Upstash Redis. A deployment must therefore preserve the Worker name, Telegram webhook, secrets, and the existing `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` bindings.

Most of the current improvement set is additive and does not require a destructive Redis migration. Phase 5B deliberately cuts new background-agent execution over to Box without deleting old records:

- Existing conversation keys such as `recent_turns:*`, `conversation_summary:*`, `group_profile:*`, `person_cards:*`, `active_topics:*`, `ambient_messages:*`, `bot_settings:*`, `model:*`, and `language:*` keep their current formats.
- Explicit durable memories use the new `memory:v2:*` namespace. Existing rolling memory remains available; explicit memory starts empty until `/remember` is used.
- Sources, last-read pages, bookmarks, feeds, scheduled jobs, active-task cancellation, usage telemetry, provider health, command fingerprints, and search caches use separate versioned keys. Older code ignores these keys safely.
- Box jobs, schedules, daily quotas, callback nonces, approvals, cost accounting, and artifact manifests use the `box_job:v1:*` family and related versioned indexes.
- Existing `agent_run:v1:*` records become terminal and read-only at the Box cutover. The scheduler must never claim them again, but status/history code may continue to display them until their existing expiry.
- Missing new state is treated as an empty/default value, so the first request after deployment does not need a migration job.
- A temporary Redis outage causes ordinary chat to continue without stored context where safe. It does not delete the stored context.

Rollout behavior and safeguards:

- Deploy this schema-compatible release directly to 100% of traffic during a quiet period. A gradual split is not useful for a personal Telegram bot and can route scheduled work or consecutive updates to different code versions.
- Do not change the Worker name or Redis credentials during this rollout. Doing so would create an apparently "new" bot state even though the old Redis data still exists elsewhere.
- Existing short webhook requests should be allowed to finish, but an old-version long task started during the cutover will not understand the new `/cancel` state. Avoid deploying while `/research`, `/read`, image generation, or model comparison is running.
- Telegram may retry an update around the cutover; the Redis update-deduplication key prevents duplicate processing across isolates and versions.
- The new stable prompt layout changes the provider-side cache prefix. Expect an initial cache-miss spike after deployment; no conversation memory is lost, and the hit rate should improve after repeated requests establish the new stable prefix.
- A code rollback leaves Upstash and R2 data in place. After the Box cutover, the rollback target must be a Box-aware release with `agent_run:v1:*` execution permanently disabled; never redeploy a pre-cutover artifact that could resume the retired queue. Reminders and digests created by the new version will pause until scheduler-capable code is restored.
- Before deployment, run the full tests, typecheck, and Wrangler dry-run; verify the Worker name and Redis bindings; then smoke-test `/status`, an ordinary reply, `/recall`, and the scheduled queue after deployment.
- Any future state-shape change must use a new versioned key plus dual-read or an explicit idempotent migration. Never overwrite the only copy of an existing state format during deployment.

## Architecture Direction

The bot should gradually move from provider-specific logic inside `telegram.ts` toward small, testable services:

```text
Telegram webhook
    -> request and intent routing
         -> ordinary/quick path in the Worker
              -> relevant Worker-safe tool selection
              -> search, reading, data, memory, and utility APIs
              -> model routing and grounded synthesis
         -> agent path through Upstash Box
              -> Pi agent runtime + DeepSeek or owner-only GLM Coding Plan
              -> isolated shell, filesystem, browser, packages, and code
              -> completion callback and artifact manifest
    -> Redis job, quota, approval, and schedule state
    -> private R2 artifact storage and signed download gateway
    -> Telegram response formatting
    -> usage and cache telemetry
```

Oh My Pi (OMP) and the Pi coding-agent SDK are separate projects in this plan. The full OMP runtime will not be embedded; we will selectively adapt its useful ideas. The smaller Pi coding-agent SDK will be embedded only inside Box as the agent loop. Cloudflare remains the durable control plane; Box is disposable or schedule-scoped execution capacity, not a second source of application truth.

## Success Measures

Track these before and after each major phase:

- Prompt cache hit rate by provider, model, and request mode.
- Average prompt cache hit and miss tokens per request.
- Average total input and output tokens per user-visible answer.
- Average and p95 response latency.
- Search success and fallback rate by provider.
- Percentage of grounded answers with at least two usable sources.
- Tool-call failure rate and timeout rate.
- Average external subrequests per Telegram update.
- Model and search usage by day and month.
- Number of background memory/model calls per user-visible response.
- Box provisioning latency, execution latency, timeout rate, and cleanup failure rate.
- Box jobs started per user and peak group concurrency.
- Model/provider selection per Box job, DeepSeek spend, GLM Coding Plan usage, and percentage of jobs rejected by a cost or subscription-quota gate.
- Artifact upload success, Telegram direct-delivery success, signed-download use, and expired-object cleanup.

Targets will be set after baseline telemetry exists. We should not invent percentage targets before measuring real usage.

---

## Phase 0: Establish the Baseline and Free-Tier Guardrails

### Work

- [x] Add a lightweight internal usage record for each model call:
  - provider and model
  - request mode
  - prompt tokens
  - completion tokens
  - total tokens
  - cache-hit tokens when reported
  - cache-miss tokens when reported
  - latency
  - success or error category
- [x] Extend shared response types to accept provider-specific usage fields without breaking providers that omit them.
- [x] Store short-lived aggregated counters in Redis rather than every raw request indefinitely.
- [x] Add an owner-only `/usage` command showing daily and monthly model/search usage.
- [x] Add an owner-only `/cache` command showing DeepSeek cache-hit ratio and average prompt size.
- [x] Tag calls by stable modes such as `chat`, `chat_tools`, `research`, `memory_extract`, `summary`, `vision`, and `image`.
- [x] Add explicit internal budgets:
  - maximum tool rounds
  - maximum search attempts
  - maximum sources
  - maximum pages read
  - maximum bytes read from a page
  - maximum simultaneous outbound requests
- [x] Document which limits are application limits and which come from Cloudflare or upstream providers.

### Definition of Done

- We can explain where tokens and external calls are going using real counters.
- Cache hits and misses are visible for providers that report them.
- No telemetry failure can prevent the bot from replying.
- All counters have bounded retention or aggregation.

---

## Phase 1: Improve Prompt Cache Hits and Reduce Prompt Size

DeepSeek context caching works automatically but relies on matching prompt prefixes. The current bot places changing memory and minute-level time ahead of reusable conversation history, which can cause early prefix divergence.

### Work

- [x] Define a stable request layout:
  1. stable soul and base operating instructions
  2. stable reply-style variant
  3. stable tool-schema variant
  4. stable compacted memory summary where practical
  5. unchanged recent conversation turns
  6. volatile reply context, selected live memory, and time context
  7. latest user message
- [x] Keep stable prompt text, whitespace, tool order, and JSON schema serialization byte-for-byte consistent.
- [x] Remove minute-level time from ordinary prompts.
- [x] Inject time only for time-sensitive requests, using the coarsest precision that answers the question.
- [x] Stop recalculating human-readable freshness labels inside the early reusable prompt prefix.
- [x] Split memory into:
  - stable durable memory
  - relevant retrieved memory
  - volatile recent context
- [x] Retrieve only memory relevant to the current request instead of always sending every available section.
- [x] Keep summaries unchanged for several turns and compact only when thresholds are crossed.
- [x] Preserve append-only recent conversation ordering between compactions.
- [x] Store full tool results and sources separately; keep compact evidence summaries in model history.
- [x] Use stable prompt variants instead of building slightly different instructions for every request.
- [x] Send tool schemas only when tools are relevant.
- [x] Add regression tests that compare serialized stable prefixes across representative consecutive turns.

### Definition of Done

- Cache-hit and miss tokens are recorded for DeepSeek.
- Consecutive normal-chat requests reuse the longest possible unchanged prefix.
- Time, roster freshness, and unrelated memory no longer invalidate the early prompt prefix.
- Average prompt tokens decline without degrading contextual answers.
- Memory compaction and tool-call tests continue to pass.

---

## Phase 2: Build a Search Broker Instead of Calling Exa Directly

### Core Types

- [x] Introduce a `SearchProvider` interface.
- [x] Normalize all providers to a shared result contract:

```ts
interface SearchResponse {
  provider: string;
  answer?: string;
  sources: SearchSource[];
  query: string;
  searchedAt: string;
}

interface SearchSource {
  title: string;
  url: string;
  snippet?: string;
  publishedAt?: string;
  author?: string;
}
```

### Broker Behavior

- [x] Move Exa behind the new provider interface.
- [x] Support an ordered provider list controlled by configuration.
- [x] Give every attempt an `AbortController` timeout.
- [x] Fall back only for retryable conditions such as timeout, quota, temporary upstream failure, or unusable results.
- [x] Do not retry authentication or malformed-request errors across the same provider.
- [x] Deduplicate canonical URLs and near-duplicate results.
- [x] Validate that responses contain usable sources before treating them as successful.
- [x] Preserve provider and source information even when the default Telegram reply hides links.
- [x] Add a normalized query parser for quoted phrases, exclusions, domains, recency, and result limits.
- [x] Cache normalized search results in Redis using freshness-aware TTLs.
- [x] Do not cache clearly personal, private, or highly volatile queries for long periods.
- [x] Keep the existing monthly search cap, but make limits provider-specific.
- [x] Track success, latency, quota errors, and fallback use per provider.

### Definition of Done

- Telegram search behavior no longer knows Exa-specific response details.
- Exa remains available and passes existing behavior tests.
- At least one fallback provider can be added without modifying Telegram conversation orchestration.
- Provider failure produces either a useful fallback result or a concise user-facing failure.

---

## Phase 3: Add Search Providers Safely

### 3A. Existing and Supported Providers

- [x] Keep Exa as a dependable configured provider.
- [x] Keep Wikipedia as the preferred source for stable encyclopedic facts.
- [x] Keep Yahoo Finance and EODHD as specialist stock providers rather than treating generic web search as market data.
- [x] Evaluate Gemini grounding through a documented Google API path.
- [x] Add OpenAI Responses API web search as an optional officially supported provider.
- [x] Evaluate lightweight public search only as a last-resort fallback.

### Definition of Done

- Search can use more than one provider through the same contract.
- Upstream costs and quotas are visible in `/usage` or `/status`.

---

## Phase 4: Grounded Research and Reading Utilities

### `/research`

- [x] Add an explicit `/research <question>` command.
- [x] Generate two or three focused search queries, not an open-ended agent loop.
- [x] Run a bounded number of searches with controlled concurrency.
- [x] Merge and deduplicate results.
- [x] Rank sources by relevance, recency where applicable, and source quality.
- [x] Read only the best few pages when snippets are insufficient.
- [x] Produce a concise answer with inline links or a compact sources section.
- [x] Clearly state when sources conflict or evidence is weak.
- [x] Persist the sources for later retrieval.

### `/sources`

- [x] Add `/sources` to show the sources for the latest grounded answer in that chat.
- [x] Store a bounded source record in Redis with TTL.
- [x] Include title, hostname, date when available, and URL.
- [x] Preserve the bot's normal link-free conversational style unless sources are requested or research mode is used.

### `/read`

- [x] Add `/read <url>` for bounded webpage extraction and summarization.
- [x] Allow only HTTP and HTTPS URLs.
- [x] Reject private, local, and metadata-service network targets.
- [x] Apply response byte and redirect limits.
- [x] Prefer readable HTML metadata and main text; avoid a heavyweight DOM library.
- [x] Support plain text, JSON, RSS/Atom, and simple HTML first.
- [x] Defer complex PDFs, JavaScript-only sites, and browser automation unless a free external extractor is acceptable.
- [x] Once Phase 5B ships, route explicit agentic reading tasks that need complex PDF handling, JavaScript rendering, or browser interaction to Box rather than expanding the Worker `/read` implementation.
- [x] Allow a user to ask a follow-up about the most recently read page.

### Definition of Done

- `/research` always operates within fixed search, page, model, and time budgets.
- `/sources` reliably retrieves the last source set.
- `/read` cannot access private network resources and cannot download unbounded content.
- Research results are more thorough than normal search without becoming the default cost of every reply.

---

## Phase 5: Tool Framework and Model Routing

### Streaming Replies

- [x] Stream visible final-answer deltas in private chats for Gemini, OpenAI/GLM, and OpenAI-compatible/DeepSeek models.
- [x] Prefer Telegram's native `sendMessageDraft` animation and fall back to editing a single message when Threaded Mode is unavailable.
- [x] Throttle Telegram updates to at most once per second and preserve normal final-message formatting.
- [x] Never stream raw reasoning, reasoning summaries, encrypted reasoning state, or tool-call arguments.

### Owner Dashboard

- [x] Host a responsive read-only control dashboard directly from the Worker.
- [x] Issue access through an owner-only `/dashboard` command with a 15-minute Redis session.
- [x] Keep the access token in the URL fragment and persist only its SHA-256 hash.
- [x] Show model roles, usage, DeepSeek cache rate, provider health, search quotas, and scheduled jobs.
- [x] Apply no-store, no-index, content-type, frame, referrer, and content-security protections.

### Tool Registry

- [x] Define a small registry containing tool name, description, schema, executor, category, and availability check.
- [x] Replace the growing `if`/`switch` dispatch logic with registry lookup.
- [x] Separate common tools from rare tools.
- [x] Expose the small stable catalog to tool-capable chat models and let the model choose with automatic tool choice; do not force normal-chat lookups from keywords.
- [x] Consider `discover_tools` only when the catalog becomes too large to expose directly. Decision: keep the full small catalog stable for prompt caching; adding discovery now would cost an unnecessary model round.
- [x] Enforce a maximum of three tool rounds per user-visible request.
- [x] Let OpenAI-style GLM and DeepSeek models inspect one tool result and choose another tool within the same bounded loop.
- [x] Add per-tool timeouts and clear error categories.
- [x] Ensure failed tool calls do not cause an unbounded fallback loop or duplicate model call.

### Model Roles

- [x] Make model roles explicit in configuration:
  - default conversation
  - fast/cheap utility
  - memory extraction
  - research synthesis
  - vision
  - image generation
- [x] Route by capability and task rather than provider name.
- [x] Add provider health and fallback without silently changing to an unsuitable model.
- [x] Add optional `/compare <question>` using two models with a strict two-model bound.
- [x] Avoid subagent fan-out during normal chat.
- [x] If a reviewer/adviser flow is added, restrict it to explicit `/research` or `/compare` usage.

### Definition of Done

- Adding a tool does not require editing the core Telegram response loop in several places.
- Ordinary chat sends only the prompt and tool schemas it needs.
- Model selection is understandable from configuration and visible in status output.
- Tool and model fallbacks are bounded and tested.

### 5B. Upstash Box Agent Runtime

The existing Redis `agent_run:v1:*` implementation proved the background-job UX, but advancing one semantic step per five-minute cron wake creates avoidable latency and makes multi-step execution brittle. Replace that execution model in the first Box release. Cloudflare remains the Telegram control plane; Upstash Box becomes the isolated execution plane for tasks that need long-running model/tool loops, files, packages, a shell, a browser, code execution, or generated documents.

Implementation checkpoint (2026-08-13):

- [x] Add the feature-flagged Worker foundation without changing live Telegram routing: exact Box/Pi package pins, a real `Agent.Custom` launcher, the `box-sse-v1` Pi harness, provider isolation, and context/output/response/spend guards. The initial application execution timeout was removed on 2026-08-13 by owner decision.
- [x] Add the first `box_job:v1:*` Redis record and index implementation with the planned lifecycle, hashed callback nonces, locked transitions, and duplicate/late/out-of-order completion handling.
- [x] Add job-scoped HMAC callback authorization and focused tests for forged, expired, cross-job, duplicate, late, and racing callbacks.
- [x] Verify the foundation with 133 passing tests, TypeScript checking, and a successful Cloudflare Worker dry-run bundle.
- [x] Run the live DeepSeek and owner-only GLM Box compatibility proofs before enabling the feature or replacing the cron runner. No production Box job is routed by this checkpoint.
- [x] Add the first feature-flagged control-plane slice: owner group binding, member/owner authorization, admission quotas, asynchronous provisioning, authenticated completion delivery, idempotent Telegram notification leases, and terminal Box cleanup. The flag remains off.

#### Routing and Telegram Controls

- [x] Add hybrid routing: clearly multi-step, tool-using, or file-generating requests route to Box automatically; `/agent <request>` forces Box and `/quick <request>` forces the ordinary Worker chatbot.
- [x] Add owner-only `/box enable` to bind Box execution to the immutable numeric Telegram chat ID of the current group. Authorization never depends on its editable title.
- [x] Default immediate Box jobs to the owner. Permit non-bot members of the bound group only when the operator explicitly sets `BOX_ALLOW_GROUP_MEMBERS=true` and accepts the trusted-group security model. Keep private-chat and all other group authorization unchanged.
- [x] Add `/agent status [job-id]`, `/agent cancel <job-id>`, `/agent approve <job-id> <nonce>`, and `/artifact <artifact-id>`.
- [x] Add owner-only `/agent schedule create|list|pause|resume|delete` controls backed by native Box schedules.
- [x] Let `/agent <request>` use the configured default Pi model route. Add `/agent --model deepseek <request>` for an explicit DeepSeek run and owner-only `/agent --model glm <request>` for the subscriber's GLM Coding Plan route.
- [x] Let a member inspect and cancel their own jobs; let the bot owner inspect or cancel every job.
- [x] Acknowledge a job immediately with its stable job ID, then deliver completion asynchronously. Query Redis and Box on demand for status instead of polling from cron.

#### Job State and Control-Plane Interfaces

- [x] Store Box job records, schedules, per-user daily quotas, group concurrency leases, one-time callback nonces, approval state, cost, and artifact manifests in versioned Redis keys under `box_job:v1:*` and related indexes.
- [x] Use the lifecycle `queued -> provisioning -> running -> awaiting_approval | succeeded | failed | canceled | timed_out`, with explicit timestamps and terminal reasons.
- [x] Make state transitions compare-and-set and idempotent so Worker retries, Telegram retries, duplicate callbacks, and concurrent cancellation cannot produce duplicate execution or delivery.
- [x] Add a one-time authenticated Box completion callback. Store only a hash of the high-entropy callback nonce, reject forged/replayed/late callbacks, and make a valid duplicate return success without repeating side effects.
- [x] Add a short-lived, job-scoped artifact-upload authorization endpoint. It returns only the minimum upload authority required for one object so no Box receives permanent R2 credentials.
- [x] Add an HMAC-signed artifact download endpoint that streams an object from private R2 only while the link is valid.
- [x] At cutover, terminalize pending `agent_run:v1:*` records with a retirement reason, remove that queue from scheduled processing, and keep the old records read-only until expiry.
- [x] Retain the Cloudflare cron trigger only for lightweight reminders and digests. No cron wake may plan, advance, synthesize, or retry a Box agent job.

#### Pi Runtime, Model Routes, and Cost Guard

- [x] Pin `@upstash/box` and the exact `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` versions validated by Upstash's maintained custom-Pi example. Do not float between Pi package scopes or forks without a compatibility test and explicit upgrade.
- [x] Build and restore-verify a reusable ARM64 Box snapshot. It contains the pinned Pi packages; Chromium/Playwright; Node/TypeScript tooling; Python document, data, notebook, visualization, and HTTP tooling; Git/Git LFS and shell utilities; C/C++, CMake/Ninja, Go, Rust, and Java compilers; SQLite/Postgres/Redis clients; Pandoc, Tectonic, LibreOffice, Poppler, qpdf, Ghostscript, OCR, Graphviz, and broad Unicode fonts; and ImageMagick, SVG, image optimization, EXIF, FFmpeg, and archive tooling. The Worker refreshes the current harness and artifact publisher into every restored Box so safety fixes do not require rebuilding the snapshot. Keep Docker, database servers, GPU stacks, cloud deployment CLIs, and a full TeX Live distribution out of the base image; add them only to a separately reviewed image or approved job when needed.
- [x] Implement the Pi harness with Upstash's `box-sse-v1` custom-agent protocol. Forward text, tool, and tool-result events; keep raw thinking out of Telegram; return token/cache/cost usage; and persist each session in a job- or schedule-scoped directory so approval and follow-up runs resume the correct context.
- [x] Use Pi's filesystem, shell, extension, and session APIs as the primary agent loop rather than launching a separate coding-agent CLI. Box remains responsible for isolation, lifecycle, schedules, streaming, and completion webhooks.
- [x] Treat binary outputs as Box filesystem paths rather than inline prompt attachments. Require the agent to publish each final file through the job-scoped artifact helper, which creates the validated Redis artifact manifest instead of depending on the sample Pi harness's unsupported JSON-schema response mode. Telegram binary-input staging remains pending.
- [x] Configure DeepSeek as the default route for every member and for general non-coding agent work. Use `DEEPSEEK_API_KEY`, `deepseek-v4-flash`, high reasoning, at most 256K input context, at most 64K output per model response, and at most 12 model responses.
- [x] Route DeepSeek requests through the Box-local proxy. Count actual input, cached-input, and output usage; enforce context/output/response limits; calculate worst-case cache-miss cost from configured rates; and refuse the next model call when it could exceed the $1 per-job ceiling. This remains a runtime component and is intentionally not treated as complete merely because the general-purpose snapshot now exists.
- [x] Validate the configured DeepSeek rate card and worst-case bound before accepting DeepSeek jobs. Fail closed when changed pricing, missing rates, or changed model limits make the $1 guarantee unsafe. At the documented 2026-08-13 Flash rates, the configured limits have a worst-case ceiling below $0.65.
- [x] Use Pi's pinned built-in international `zai` Coding Plan provider with a dedicated Worker secret named `ZAI_CODING_PLAN_API_KEY`. Give Pi only a non-secret discovery placeholder and inject the real authorization header at the Box host for the exact Z.AI hostname. Pin the endpoint to `https://api.z.ai/api/coding/paas/v4`, start with `glm-5.2`, and keep the model ID changeable without rebuilding the Box snapshot. Add `models.json` only if a later provider/model override is actually required.
- [x] Restrict the GLM Coding Plan provider to the bot owner and coding-agent tasks because individual subscription benefits are subscriber-only and multi-user access is prohibited. Never use the owner's Coding Plan key for another group member's job, a general chatbot reply, or an unsupported non-coding workload.
- [x] Keep one model provider for the lifetime of a started job. If an explicitly selected GLM run is unavailable or quota-limited, report that state and require an owner retry/choice; do not silently consume DeepSeek credit or move an in-progress session across providers.
- [x] Apply the same context, response-count, and concurrency guards to GLM jobs. Do not impose an application execution timeout on either provider; jobs run until completion, cancellation, or an upstream/platform limit. Track GLM tokens, requests, failures, and subscription-quota errors separately; the fixed subscription route has no per-job dollar charge to compare with the DeepSeek $1 ceiling.
- [x] Keep Pi provider credentials outside the Box container using exact-host Upstash attached headers. Never place them in Box environment variables, the snapshot, Redis records, prompts, logs, artifacts, or Telegram output. Expose only the selected provider/model label in status and usage views.
- [x] Enforce two concurrent jobs for the bound group and five starts per user per calendar day in the configured timezone. The owner's GLM jobs consume the same group and daily job quotas.
- [x] Create immediate jobs from the prepared snapshot in fresh Box environments. Delete the Box only after terminal state and artifact publication are durable; retry orphan cleanup independently and idempotently.

#### Recurring Jobs, Artifacts, and Approvals

- [x] Use native Box schedules for recurring agent prompts. Give each schedule its own persistent Box and completion webhook; only the bot owner may create, change, pause, resume, or delete schedules.
- [x] Keep Upstash Workflow out of the first release. Reconsider it only for parallel fan-out, branching durable workflows, or multi-stage human approvals that Box schedules and callbacks cannot express cleanly.
- [x] Store generated PDFs, spreadsheets, archives, images, and other artifacts in a private R2 bucket under job-scoped keys. Apply an R2 lifecycle rule that deletes them after 30 days.
- [x] Issue 24-hour signed download links and let `/artifact <artifact-id>` reissue a link while the object still exists.
- [x] Send artifacts up to Telegram's 50 MB document limit directly and include the signed link. For larger files, send the link only.
- [x] Accept Telegram attachments up to the Bot API's current 20 MB download limit; require an accessible URL for larger inputs.
- [x] Permit shell commands, local files, package installation, code, browser actions, and artifact creation inside the sandbox without approval.
- [x] Disable external write integrations by default and let the owner enable them individually. Execute an allowlisted write only when the originating prompt explicitly requests it.
- [x] Pause recognized deployment, spending, destructive external changes, protected-branch pushes, or unsolicited third-party communication for one-time owner approval. Preserve the Box session and bind the nonce to the job, exact action, owner identity, and expiry. Document the shell classifier as defense in depth, not complete mediation, and never inject permanent third-party integration credentials into Box.

#### Delivery Slices

1. Prove that the Pi custom harness runs inside Box, calls DeepSeek with the intended model, uses shell/filesystem tools, emits valid `box-sse-v1` events, resumes the correct session, and makes no unintended provider request. Separately prove an owner-only Pi call consumes GLM Coding Plan quota through the dedicated coding endpoint.
2. Add group binding, hybrid routing, Redis job state, quotas, concurrency control, status, and cancellation.
3. Add asynchronous Box execution, authenticated callbacks, cancellation, upstream/platform timeout recording, cleanup, and retirement of the cron-stepped agent queue. Do not add an application execution deadline.
4. Add R2 artifact publication, PDF generation, Telegram document delivery, signed downloads, and retention.
5. Add owner-managed Box schedules and approval/resume flows.

#### Definition of Done

- Bound-group, owner-only, member-job, `/quick`, `/agent`, quota, and concurrency behavior has automated coverage.
- Duplicate, forged, replayed, late, and out-of-order callbacks cannot corrupt state or duplicate Telegram/R2 side effects.
- Worker and Telegram retries cannot create duplicate Box runs, messages, approvals, or artifacts.
- Upstream/platform timeout, cancellation, Box provisioning, Pi harness, DeepSeek, GLM Coding Plan, artifact upload, Telegram delivery, and cleanup failures all reach a recoverable or explicit terminal state.
- A generated PDF is delivered directly when eligible and remains downloadable through an expiring link; oversized delivery, link reissue, link expiry, and 30-day deletion are verified.
- Tests prove the DeepSeek cost gate fails closed whenever configured rates and limits could exceed $1, while GLM Coding Plan quota failures stay isolated and never expose or share the owner's subscription.
- Recurring schedule create/run/pause/resume/delete flows and owner authorization are verified.
- Existing reminders and digests still run through Cloudflare cron, while tests prove no cron invocation advances a Box job.

---

## Phase 6: Improve Memory Utility and User Control

The existing memory system already has recent turns, summaries, profiles, person cards, topics, and ambient context. Improve control and retrieval before adding a more complex memory database.

### Work

- [x] Add `/remember <fact>` for explicit durable memory.
- [x] Expand `/forget` so it can remove a named memory or topic, not only a person card.
- [x] Add `/recall <query>` for searching stored memory.
- [x] Tag explicit memories by scope: private user, group, person, topic, preference, or reminder.
- [x] Store timestamps and stable IDs separately from prompt text.
- [x] Retrieve relevant memories for each request instead of injecting the whole memory block.
- [x] Prefer simple lexical/tag matching first; use embeddings only if a suitable free or low-cost API is justified.
- [x] Add deduplication so the same fact is not repeated across summary, profile, and person cards.
- [x] Add contradiction handling that prefers newer explicit corrections.
- [x] Let group admins inspect and remove durable group memory.
- [x] Add TTLs for transient topics while keeping explicit durable facts.
- [x] Ensure memory extraction runs in the background and never delays the Telegram response unnecessarily.

### Definition of Done

- Users can explicitly save, find, correct, and delete memories.
- The model receives less irrelevant memory.
- Durable memory and temporary conversation context have visibly different lifecycles.
- Prompt-size and cache metrics demonstrate whether retrieval is helping.

---

## Phase 7: Expand Everyday Utility

These features should use deterministic Worker code, Worker-compatible HTTP APIs, and Redis whenever they fit a short request. Route only tasks that genuinely need a long-running tool loop, browser, filesystem, package, code, or artifact workspace to Box. Each item needs a small feasibility check for upstream cost and quota before implementation.

### High-Value Candidates

- [x] Weather lookup using a documented low-cost or free API.
- [x] Currency and unit conversion with deterministic local calculations where possible.
- [x] URL bookmarking and reading list stored in Redis.
- [x] RSS/Atom feed summaries for selected sources.
- [x] Personal reminders using one scheduled Worker trigger and a Redis due-time queue.
- [x] Scheduled daily or weekly digests for selected feeds, topics, stocks, or searches.
- [x] Translation, rewriting, and summarization shortcuts that reuse the existing model APIs.
- [x] Voice-note transcription through an external API, with strict Telegram file-size limits.
- [x] Optional text-to-speech for short replies if an acceptable API quota exists.
- [x] Lightweight GitHub repository, issue, release, and documentation lookups through the GitHub HTTP API.
- [x] arXiv and other structured-source lookup adapters for research questions.
- [x] Simple calculator, date arithmetic, and timezone tools implemented locally without model calls.

### Prioritization Rule

Implement utilities in this order:

1. deterministic and local computation
2. free structured HTTP APIs
3. existing paid/configured providers
4. new paid providers only when the benefit clearly justifies them

### Definition of Done

- Each utility has an explicit command or reliable intent route.
- Deterministic tasks do not consume model tokens unnecessarily.
- Scheduled work uses one shared scheduler rather than one Cloudflare trigger per feature.
- Every external service has a quota, timeout, and failure strategy.

---

## Phase 8: Telegram Experience Improvements

- [x] Show a temporary progress message for longer `/research`, `/read`, image, and comparison tasks.
- [x] Edit that message with the final result when possible instead of sending multiple status messages.
- [x] Add a cancel mechanism for queued or multi-step work where practical.
- [x] Keep commands synchronized automatically after deployment or expose clear owner status when they are stale.
- [x] Improve `/help` by grouping commands into chat, search, research, memory, media, utilities, and admin.
- [x] Expand `/status` with provider availability, search order, model roles, memory status, and quota state.
- [x] Add sensible Telegram-length splitting that preserves Markdown links and code blocks.
- [x] Add reply keyboards or inline buttons only where they reduce typing, such as model/provider selection.
- [x] Keep ordinary conversational answers concise; detailed research should remain opt-in.
- [x] Ensure every new user-facing string is represented in the existing localization system.

### Definition of Done

- Long operations provide clear feedback without chat spam.
- Help and status output accurately reflect configured capabilities.
- Long answers, citations, and code render correctly in Telegram.
- New commands remain understandable without reading the README.

---

## Phase 9: Reliability, Testing, and Maintainability

- [x] Break up `telegram.ts` as features move into dedicated services.
- [x] Keep Telegram transport, prompt construction, tools, providers, memory, and usage accounting separate.
- [x] Add contract tests for every search provider using mocked HTTP responses.
- [x] Add fallback-order and timeout tests for the search broker.
- [x] Add SSE parser fixtures for streaming providers.
- [x] Add prompt-layout and cache-stability tests.
- [x] Add request-budget tests that fail if a flow exceeds configured tool or provider limits.
- [x] Add SSRF and oversized-response tests for `/read`.
- [x] Test Redis failure as a degraded mode: chat should still work where safe.
- [x] Test Telegram retries and preserve update deduplication.
- [x] Keep background tasks idempotent.
- [x] Add a lightweight provider health view based on recent failures, not continuous polling.
- [x] Run `npm test`, `npm run typecheck`, and the Wrangler dry-run build for every completed phase.
- [x] Update the main README and translated documentation only after behavior is stable.

### Definition of Done

- Core flows remain covered as architecture is split into services.
- Provider or Redis outages degrade gracefully.
- The Worker dry-run stays inside deployable bundle constraints.
- Documentation matches shipped behavior rather than planned behavior.

---

## Deferred or Rejected for the Hybrid Product

The following capabilities remain deliberately outside the current scope:

- Full OMP or NanoClaw runtime embedding.
- Shell, subprocess, native executable, browser, package installation, or persistent filesystem access inside Cloudflare Workers. These capabilities belong only inside isolated Box environments.
- Git pushes, deployments, external account changes, purchases, deletion, or third-party messaging without the explicit-request and approval policy defined in Phase 5B.
- Desktop or host-OS control outside a Box sandbox.
- Local models that require maintaining a GPU server.
- Large-scale autonomous subagent swarms.
- Self-hosted SearXNG or any other service that requires maintaining an always-on server.
- Upstash Workflow in the first Box release; reconsider it for fan-out, branching, or multi-stage durable approval flows.
- Permanent public R2 objects or long-lived bearer download URLs.

Complex PDF processing, browser automation, repository editing, and persistent evaluation sessions are no longer categorically rejected; they are allowed only in bounded Box jobs under the quotas, cost controls, artifact retention, and approval rules above.

## Recommended Delivery Order

The near-term implementation sequence is:

1. Phase 0: usage and cache telemetry.
2. Phase 1: prompt stability and token reduction.
3. Phase 2: search broker and normalized results.
4. Phase 3A: documented providers and fallback.
5. Phase 4: `/research`, `/sources`, and bounded `/read`.
6. Phase 5: tool registry and model roles.
7. Phase 5B: Upstash Box agent runtime, delivered in its five ordered slices.
8. Phase 6: explicit and retrieved memory.
9. Phase 8: Telegram UX improvements.
10. Phase 7: everyday utilities, selected one at a time by value and quota.
11. Phase 9: continuous refactoring and reliability work throughout every phase.

Phases 0 through 9 describe both completed foundations and remaining work. Phase 5B is delivered; later changes must preserve the verified Pi/DeepSeek and owner-only Pi/GLM compatibility proofs, state machine, callbacks, artifact path, and secure credential boundary.

## Completion Evidence

Validated locally on 2026-08-12 without deploying production:

- `npm test`: 22 test files and 79 tests passed.
- `npm run typecheck`: passed with no TypeScript errors.
- `npm run build`: Wrangler dry-run passed; upload size was 398.70 KiB (84.33 KiB gzip).
- `git diff --check`: passed.
- The command schema has 57 unique Telegram-safe command names and usable descriptions for all eight supported locales.
- Current pre-Phase-5B baseline: the Worker uses one five-minute Cron Trigger, and each scheduler invocation atomically claims at most three jobs to protect the Free-plan subrequest budget. The Box cutover must remove `agent_run:v1:*` advancement from this trigger while retaining lightweight reminder and digest processing.
- Search/research request budgets cap provider attempts, sources, page reads, page bytes, tool rounds, and concurrent outbound requests.
- No production deployment or Redis migration was performed as part of implementation verification.

Phase 5B foundation checkpoint validated locally on 2026-08-13 without enabling Box or deploying production:

- `npm test`: 31 test files and 133 tests passed.
- `npm run typecheck`: passed with the new Box/Pi modules included.
- `npm run build`: the existing Worker entrypoint passed Wrangler dry-run at 490.85 KiB (106.67 KiB gzip).
- A separate Wrangler module-worker probe that forcibly bundled the Box launcher passed at 295.33 KiB (54.79 KiB gzip). The pinned SDK retains lazy `node:fs/promises` and `node:path` imports for its local-download helper and Wrangler warns about them without `nodejs_compat`; the Worker path must not call that helper, and the integration slice must repeat this probe before deployment or replace the SDK call site with a Worker-safe REST adapter.
- `npm audit --omit=dev`: no production dependency vulnerabilities reported.
- Live DeepSeek proof: a temporary Box ran Pi with `deepseek/deepseek-v4-flash`, used bash plus filesystem reads, returned the required marker, resumed the same session for a second file mutation/read, recorded usage, and was deleted successfully.
- Live GLM proof: the non-owner route was rejected before provisioning; a temporary Box then ran the owner route with `zai/glm-5.2`, used bash plus filesystem reads, returned the required marker, resumed the session, recorded usage, and was deleted successfully.
- The proof exposed and fixed a pinned-version compatibility drift in Upstash's sample: Pi 0.84.1 exports `getModel` from `@earendil-works/pi-ai/compat`, not the package root. The repeatable `verify:box:deepseek` and `verify:box:glm` scripts now smoke-test that exact import before calling a model.
- Upstash Box coordinator DNS/connectivity was intermittent and both successful two-turn proofs took about 10.5 minutes despite tiny tasks. Treat provisioning/run latency and coordinator reachability as an operational risk; retain cancellation, cleanup, and upstream-failure recovery without imposing an application execution deadline.
- The feature remained disabled and the old cron runner remained live during this checkpoint; authenticated callback testing was completed in the later control-plane checkpoint.

Phase 5B control-plane checkpoint validated locally on 2026-08-13 without enabling Box or deploying production:

- Callback configuration passed its minimum-length and URL guards without printing or persisting credential material in a job record. The route remained gated until deployment.
- `npm test`: 32 test files and 144 tests passed, including group binding, member/owner isolation, DeepSeek/GLM command routing, two-job concurrency, five-start daily quotas, callback signature checks, forged/duplicate callbacks, Telegram delivery retry, cancellation/provisioning races, cancellation ownership, and idempotent cleanup.
- `npm run typecheck`: passed.
- `npm run build`: Wrangler dry-run passed with the Box service and Cloudflare `nodejs_compat` enabled at 878.84 KiB (177.50 KiB gzip), with no unresolved Node built-in warning.
- `npm run build:box-proof`: passed; the standalone esbuild proof remains a Node-targeted utility rather than a Worker bundle.
- `git diff --check`: passed with line-ending warnings only.
- The Worker now exposes `POST /box/callback`; `/box enable`, `/agent`, `/agent --model`, `/agent status`, and `/agent cancel` are implemented behind `BOX_AGENT_ENABLED=false`. No production secret upload, deployment, group binding, or Box run occurred in this checkpoint.
- The legacy cron-stepped `agent_run:v1:*` runner remains active until upstream-failure recovery, artifact publication, and cutover tests are complete. Hybrid auto-routing, `/quick`, approvals, schedules, and retired-cron behavior remain pending.

Phase 5B artifact-gateway checkpoint validated locally on 2026-08-13 without enabling Box or deploying production:

- Added private `ARTIFACT_BUCKET` binding configuration, job-scoped `box_artifact:v1:*` records, a short-lived Box artifact-session token, one-time object upload tokens, exact-size enforcement, collision-free job-scoped keys, idempotent PUT handling, and HMAC-signed 24-hour download streaming.
- Added the Box-local `publish-artifact.mjs` helper contract. It authorizes and streams final filesystem outputs through the Worker and never receives an R2 API credential.
- Added `/artifact <artifact-id>` with chat/user authorization and owner override. Completion delivery sends artifacts at or below 50 MB through Telegram `sendDocument` plus a signed link; larger artifacts receive the signed link only.
- Generated `output/pdf/box-artifact-smoke.pdf` with ReportLab, extracted the `BOX_ARTIFACT_PDF_OK` marker with pdfplumber, rendered the page with Poppler, and visually verified that text, table, spacing, footer, and page number are legible with no clipping or overlap.
- `npm test`: 34 test files and 154 tests passed. The suite covers upload authorization, forged/expired credentials, exact-size checks, idempotent upload, private download streaming, forged/expired/reissued links, user ownership, the Box publisher's credential isolation, direct Telegram document delivery, over-50-MB link-only delivery, and duplicate callback suppression.
- `npm run typecheck`, `npm run build`, and `git diff --check` passed. Wrangler dry-run includes the private R2 binding at 902.45 KiB (182.02 KiB gzip).
- Cloudflare R2 was enabled in the private deployment, and the live 30-day `jobs/` lifecycle rule was verified. Deployment-specific bucket names are intentionally kept outside the public repository. A live Box-generated PDF upload/download/Telegram proof remained required at this checkpoint.

Phase 5B comprehensive Box snapshot checkpoint validated live on 2026-08-13 without enabling Box or deploying production:

- Built ARM64 snapshot `telegram-agent-runtime-v1-20260813` and recorded its ID only in the ignored local `.dev.vars`. The ready snapshot is 1,376,907,804 bytes; its source builder was deleted after capture.
- The snapshot uses 3.1 GB of the Box's 5 GB filesystem and leaves about 2.0 GB for repositories, generated documents, browser state, and job-local dependencies. Keep this headroom as an explicit acceptance constraint when adding future base packages.
- Real build-time smoke tests compiled LaTeX directly with Tectonic, converted Markdown to PDF through Pandoc/Tectonic, validated both PDFs with qpdf and Poppler text extraction, imported the pinned Python and Node toolsets, and exercised LibreOffice, ImageMagick, FFmpeg, Graphviz, Git, Go, Rust, Java, and headless Chromium.
- `npm run snapshot:verify` restored a fresh Box from the captured snapshot and re-verified Pi, document/data libraries, compilers, database clients, and Chromium 151.0.7922.34. The verifier Box was deleted after the successful check.
- The builder supports retrying transient Upstash coordinator failures and preserving/pausing an incomplete Box for explicit resume. This was required in practice because the live coordinator intermittently timed out during installation.
- No application execution timeout is configured in the launcher or compatibility proofs. Jobs end through completion, member/owner cancellation, or an upstream/platform limit; the response-count, context, output, concurrency, and DeepSeek spend guards remain in force.

Phase 5B disabled production infrastructure checkpoint deployed on 2026-08-13:

- Uploaded the seven Box runtime values from ignored `.dev.vars`, including the ready snapshot ID and `BOX_AGENT_ENABLED=false`; no secret value was printed. Existing Worker secrets were not removed.
- Deployed a gated Worker version with the private production R2 binding. The existing five-minute cron remained active and Box routing remained disabled during this checkpoint. Deployment identifiers are kept outside the public repository.
- Live smoke checks returned HTTP 200 from the Worker root, HTTP 401 for a correctly shaped but forged Box callback, HTTP 401 for artifact authorization without a session token, and HTTP 404 for a nonexistent unsigned artifact URL.
- Final local regression verification passed: 34 test files and 154 tests, TypeScript checking, the 902.29 KiB/181.98 KiB gzip Wrangler dry-run, the standalone Box proof bundle, and `git diff --check` (line-ending warnings only).

Phase 5B completion and production cutover validated on 2026-08-13:

- Implemented hybrid routing, `/quick`, complex `/read --agent`, Telegram document staging, job status/cancel/approve/artifact controls, native owner-managed schedules, the Redis schedule/approval/cost/artifact records, retirement of `agent_run:v1:*`, and removal of semantic agent advancement from Cloudflare cron.
- Added the Box-local provider meter and fail-closed pre-request gates for 256K context, 64K output, 12 responses, and the $1 DeepSeek ceiling. The current rate-card validation remains below $0.65 in the documented cache-miss worst case. GLM stays owner-only, coding-only, provider-isolated, and subject to the same response/context/concurrency guards without an application execution deadline.
- Added durable Redis delivery leases for terminal messages, approval notices, recurring schedule results, and Telegram artifacts. Artifact authorization is content/name/type-idempotent, duplicate callback/upload retries reuse the same manifest/object, and orphan delivery/cleanup is recovered independently.
- Permanent third-party integration credentials are never injected into Box. Recognized deployment, spending, destructive external changes, pushes, and third-party communication pause behind a one-time nonce/action-hash/expiry approval. The classifier is explicitly documented as a defense-in-depth guardrail pending a Worker-side action broker with short-lived action-scoped authority.
- Live current-harness DeepSeek and owner GLM proofs passed in temporary Boxes: Pi completed shell/filesystem work, resumed the same session, and cleanup succeeded; non-owner GLM selection was rejected before provisioning.
- The protected-action proof blocked a recognized command before execution, bound it to the exact nonce and SHA-256 action hash, executed once after one matching grant, suppressed a repeat, and required a separate approval for a different protected action. Native schedule create/list/pause/resume/delete also passed, followed by Box cleanup.
- Final verification passed with 39 test files and 167 tests, TypeScript checking, `git diff --check` (line-ending warnings only), and a Wrangler dry-run at 958.20 KiB / 194.21 KiB gzip. The test corpus covers routing overrides, authorization, quotas/concurrency, callback ordering/forgery/retry, approval delivery/resume, schedule delivery/lifecycle, attachment limits, cost gates, artifact idempotency/direct/link-only delivery, and legacy queue retirement.
- Production smoke checks returned root 200, forged callback 401, unknown schedule callback 404, and unauthenticated artifact authorization 401 before the feature gate was enabled. Deployment and secret-version identifiers are intentionally kept outside the public repository.
- Final user-visible acceptance is performed from Telegram, not through a production backdoor: the owner runs `/box enable` once in the intended group, then starts a PDF job. That validates the real immutable chat ID, Bot API document delivery, and reissuable signed URL using the same path members will use.

Public-release hardening validated on 2026-08-13:

- Removed the experimental private subscription-based model integration, commands, transport, authentication store, tests, dashboard fields, configuration, and documentation.
- Moved provider credentials from Box-readable environment variables to exact-host, write-only Upstash attached headers; added private/link-local/metadata egress denial and owner-only Box execution as the default.
- Removed permanent third-party integration credentials from Box and documented protected-action classification as defense in depth pending a Worker-side action broker.
- Added safe example configuration, CI, release metadata, license, security policy, contribution policy, architecture, deployment, runtime, operations, and demo documentation.
- A clean public-tree copy passed `npm ci --ignore-scripts`, all 35 test files and 149 tests, TypeScript checking, and the Wrangler dry-run. Full and production-only dependency audits reported zero vulnerabilities.
- Gitleaks 8.30.1 scanned the 170-commit Git history and the proposed public tree with no leaks found. Source scans found no remaining integration references or private deployment identifiers.

## Research References

- [Oh My Pi overview](https://github.com/can1357/oh-my-pi)
- [OMP provider configuration](https://github.com/can1357/oh-my-pi/blob/main/docs/providers.md)
- [OMP web search tool](https://github.com/can1357/oh-my-pi/blob/main/docs/tools/web_search.md)
- [OpenAI web search API](https://developers.openai.com/api/docs/guides/tools-web-search)
- [DeepSeek context caching](https://api-docs.deepseek.com/guides/kv_cache)
- [DeepSeek models and pricing](https://api-docs.deepseek.com/quick_start/pricing/)
- [Upstash Box agent API](https://upstash.com/docs/box/overall/agent)
- [Upstash Box custom agents](https://upstash.com/docs/box/overall/custom-agent)
- [Upstash Box Pi setup](https://upstash.com/docs/box/guides/pi-setup)
- [Upstash Box custom Pi harness](https://upstash.com/docs/box/overall/custom-harness/pi)
- [Upstash Box schedules](https://upstash.com/docs/box/overall/schedules)
- [Upstash Box pricing and limits](https://upstash.com/pricing/box)
- [Pi custom model configuration](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/models.md)
- [Pi SDK](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/sdk.md)
- [Z.AI GLM Coding Plan supported tools and endpoint](https://docs.z.ai/devpack/tool/others)
- [Z.AI GLM Coding Plan usage policy](https://docs.z.ai/devpack/usage-policy)
- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare Workers Node.js compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)
- [Cloudflare R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)
- [Telegram Bot API `getFile`](https://core.telegram.org/bots/api#getfile)
- [Telegram Bot API `sendDocument`](https://core.telegram.org/bots/api#senddocument)

## Planning Rules

- Check off work only when it is implemented and verified.
- Do not mark a phase complete because only its happy path works.
- Preserve existing working behavior while introducing provider abstractions.
- Prefer a small vertical slice with tests over a large unverified rewrite.
- Revisit priorities using actual `/usage` and `/cache` measurements.
- Update this file whenever a decision changes the intended architecture or feature scope.
