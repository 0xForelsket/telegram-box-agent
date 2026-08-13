# Demo and launch checklist

## Provider-free local proof

Run `npm run demo` after `npm ci`. This executes the real control-plane routing,
job state, callback, delivery, cleanup, and artifact-link code with in-memory
adapters. It is safe to run without accounts or credentials and is also run by
CI. It deliberately does not claim that an external provider or deployed bot
was contacted.

The sanitized output artifact is available as
[a PDF](assets/sample-box-artifact.pdf) and
[a rendered preview](assets/sample-box-artifact.png).

## Three-minute demo

1. Show ordinary Telegram chat responding immediately.
2. Send a request that explicitly asks for current research and a polished PDF.
3. Show the immediate job ID acknowledgement.
4. Run `/agent status <job-id>` while the Box is working.
5. Show the final message, directly delivered PDF, and private signed link.
6. Run `/artifact <artifact-id>` to issue a fresh link.
7. Briefly show the architecture diagram and explain that cron never advances
   agent reasoning.

Use a dedicated demo bot, group, provider account, Redis database, Worker, R2
bucket, and Box account configuration. Do not record personal chats or production
dashboards.

## Suggested showcase request

```text
/agent Research the trade-offs between serverless request handlers and isolated
agent sandboxes. Use current primary sources, create a concise Markdown report,
compile a polished PDF, and return both files with source links.
```

## Media to capture

- One clean screenshot of job acknowledgement
- One screenshot of the final PDF delivery and signed link
- A short GIF or video showing status followed by asynchronous delivery
- A sample generated PDF committed only after checking its metadata and content
  for names, local paths, credentials, or private URLs

The sample PDF and preview above satisfy the static-artifact item. The Telegram
screenshots and short recording must come from the dedicated live-demo stack;
do not substitute mock UI for deployed evidence.

## Honest launch notes

State clearly that:

- this is self-hosted and requires several provider accounts;
- the design is free-tier-first rather than permanently free;
- Box is a preview dependency;
- job startup and multi-step execution can take minutes;
- group-member Box access is for trusted groups only;
- protected-action approval is currently a guardrail, not complete mediation.

## Before posting publicly

- Create a new repository under the final project name.
- Confirm `LICENSE` carries the correct copyright holder and year.
- Confirm the package repository/homepage URLs still match the public repository.
- Publish a tagged release from a clean commit.
- Enable CI and GitHub private vulnerability reporting.
- Run `npm run security:scan-history`, review GitHub secret-scanning alerts, and
  rotate anything ever exposed.
- Verify a clean clone by following `docs/deployment.md` from scratch.
- Confirm screenshots, PDFs, Git history, issues, and release notes contain no
  personal numeric IDs, worker subdomains, callback URLs, or credentials.
