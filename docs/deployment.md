# Deployment

## 1. Prerequisites

- Node.js 22+ (required by Wrangler 4)
- Cloudflare account with Workers and R2
- Wrangler authenticated with `npx wrangler login`
- Telegram bot and numeric owner user ID
- Upstash Redis REST database
- At least one ordinary chat-model provider
- Optional: Upstash Box plus DeepSeek or a Z.AI coding-plan key
- For persistent Box schedules: QStash current and next signing keys

## 2. Install and configure

```bash
npm ci
cp .dev.vars.example .dev.vars
```

On PowerShell use `Copy-Item .dev.vars.example .dev.vars`. Edit `.dev.vars` for
local development. Edit only non-secret deployment defaults in `wrangler.toml`.
Set a unique Worker name and R2 bucket names.

At minimum configure these Wrangler secrets:

```text
TELEGRAM_BOT_TOKEN
TELEGRAM_WEBHOOK_SECRET
UPSTASH_REDIS_REST_URL
UPSTASH_REDIS_REST_TOKEN
```

Add at least one ordinary model key, for example
`OPENAI_COMPATIBLE_KEY`, `GOOGLE_MODEL_KEY`, or `OPENAI_API_KEY`.

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put UPSTASH_REDIS_REST_URL
npx wrangler secret put UPSTASH_REDIS_REST_TOKEN
```

Do not store secret values in `wrangler.toml`.

## 3. Verify and deploy basic chat

```bash
npm test
npm run typecheck
npm run build
npx wrangler deploy
```

Set `DASHBOARD_BASE_URL` to the deployed HTTPS origin if the owner dashboard is
enabled. Register Telegram's webhook as a JSON POST to `setWebhook` with:

- URL: `https://YOUR_WORKER/webhook`
- secret token: the exact `TELEGRAM_WEBHOOK_SECRET`
- allowed updates: `message`, `callback_query`

Do not paste the bot token into documentation, screenshots, issue reports, or
shell history that will be shared.

## 4. Create private R2 artifact buckets

Update the bucket names in `wrangler.toml` and the package scripts if you change
the defaults, then run:

```bash
npm run r2:create
npm run r2:lifecycle
npm run r2:verify
```

The lifecycle rule must delete objects under `jobs/` after 30 days. Do not make
the bucket public.

## 5. Configure Box

Add these secrets:

```text
UPSTASH_BOX_API_KEY
BOX_CALLBACK_SECRET
DEEPSEEK_API_KEY or ZAI_CODING_PLAN_API_KEY
```

`BOX_CALLBACK_SECRET` must contain at least 32 random characters. Configure:

```text
BOX_CALLBACK_URL=https://YOUR_WORKER/box/callback
BOX_AGENT_ENABLED=false
BOX_ALLOW_GROUP_MEMBERS=false
```

Persistent schedules also require both QStash receiver keys. They let the
Worker verify the short-lived JWT over the exact callback URL and body:

```text
QSTASH_CURRENT_SIGNING_KEY
QSTASH_NEXT_SIGNING_KEY
```

Store both as Wrangler secrets. Schedule creation fails closed when either key
is absent.

Build and verify the snapshot:

```bash
npm run snapshot:build
npm run snapshot:verify
npm run verify:box:deepseek
```

For the owner-only GLM coding route, also run `npm run verify:box:glm`.
Store the verified snapshot ID as `BOX_SNAPSHOT_ID`.

## 6. Safe enablement

Deploy with Box disabled first. Verify:

- `GET /` returns 200.
- An unsigned request to `/box/callback` returns 401.
- An unsigned request to `/box/schedule-callback` returns 401 when the schedule exists.
- An unauthenticated artifact authorization returns 401.
- Tests, typecheck, and dry-run build pass using the deployment configuration.

Then set `BOX_AGENT_ENABLED=true`, deploy, and privately ask the owner to run
`/box enable` in the intended Telegram group. Binding uses the immutable numeric
chat ID, never the group title.

Start an acceptance job:

```text
/agent Create a one-page Markdown file and a PDF that explain the runtime.
```

Verify acknowledgement, status, final Telegram delivery, signed download link,
link reissue through `/artifact`, and Box cleanup.

## 7. Trusted group access

Keep `BOX_ALLOW_GROUP_MEMBERS=false` for public or mixed-trust groups. Enabling
it permits every non-bot member of the bound group to create jobs and consume
the configured provider budget. Members can inspect and cancel only their own
jobs; the owner can inspect and cancel all jobs.

## Updating

Re-run tests and snapshot verification whenever Box, Pi, document tooling, or
provider configuration changes. Roll out Worker changes before replacing the
snapshot so the Worker can always refresh the latest harness and policy files.
