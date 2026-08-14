# Security and threat model

## Assets

- Telegram bot authority and chat membership information
- Redis chat, job, schedule, quota, callback, and artifact state
- Model-provider budget and credentials
- Upstash Box account authority
- Private R2 artifacts
- User prompts, attachments, history, and generated outputs

## Adversaries and untrusted inputs

- Unauthorized Telegram users and forged webhook senders
- A malicious or compromised member of a Box-enabled group
- Prompt injection in messages, attachments, source repositories, or websites
- Forged, replayed, late, duplicated, or reordered Box callbacks
- Malformed uploads and attempts to access another user's artifacts
- Model-generated shell commands and code with unexpected network behavior

## Controls

### Telegram and actors

Telegram's webhook secret is checked before update processing. Owner identity is
an immutable numeric user ID. Box binds to an immutable numeric group chat ID.
Owner-only execution is the default; group-member execution is an explicit
trusted-group opt-in.

### Box credentials

The Box API key, callback signing key, Telegram token, Redis credentials, and R2
authority never enter Box. Model-provider keys use exact-host attached headers;
only non-secret provider-discovery placeholders enter the container.

Attached headers prevent reading the raw key. They do not prevent arbitrary
code from causing an authenticated request to the matched provider. Provider
accounts therefore need their own hard budgets, and Worker quotas remain
mandatory.

### Egress and SSRF

Custom Box network policy uses a broad public-suffix allowlist for research,
package downloads, provider calls, and Worker callbacks. Upstash custom mode
blocks private IP ranges even when a permitted hostname resolves to one. Add
uncommon public suffixes deliberately when a deployment needs them.

Worker-side fetches go through `URLReader.validateUrl`, which rejects
credentialed URLs, non-HTTP schemes, and private, loopback, link-local,
metadata, carrier-grade NAT, benchmarking, multicast, and reserved addresses.
Numeric IPv4 in decimal, hex, octal, and short forms is canonicalised by the
URL parser before validation. IPv4 embedded in IPv6 — IPv4-mapped,
IPv4-compatible, and the NAT64 well-known prefix — is decoded and checked
against the same IPv4 rules, so `[::ffff:169.254.169.254]` is refused exactly
as `169.254.169.254` is.

This is defence in depth rather than the boundary. A Worker resolves DNS inside
`fetch`, so a public hostname whose record points at an internal address cannot
be rejected before the request leaves; Cloudflare's egress policy is what stops
it. Treat `validateUrl` as the layer that keeps obviously internal targets out
of requests, logs, and error messages, not as a guarantee about where a packet
can reach.

### Callbacks

Immediate-job callbacks are HMAC signed over a versioned canonical request,
timestamp, job ID, and nonce. Verification is constant-time. Redis binds the
expected nonce and state transition, making duplicates idempotent and rejecting
forged, out-of-order, or unknown-job callbacks.

Persistent schedule callbacks additionally require QStash's short-lived JWT,
which binds the exact callback URL and raw body. Before delivery, the Worker
checks that the durable schedule is active and attests the run ID, status, Box,
and upstream schedule identity against the Box API. Static webhook headers alone
cannot authorize a recurring result.

### Artifacts

Box receives a short-lived job-scoped session token. Each artifact authorization
validates job state, filename, content type, declared size, and idempotency key.
Upload tokens are single-artifact and time-limited. R2 objects are private and
download URLs use short-lived HMAC signatures. Authorization also checks chat
and job ownership before issuing a refreshed URL.

### Protected actions

The Pi extension recognizes common deployment, payment, destructive external,
push, and third-party communication shell commands. It binds a pending action
to a nonce and SHA-256 command hash, pauses execution, and consumes one matching
owner approval.

This is defense in depth, not complete mediation. A benign-looking command can
execute a script whose internal network actions are invisible to the parent
shell classifier. Consequently:

- no permanent third-party integration credentials are supplied to Box;
- group-member execution is disabled by default;
- deployments, payments, and other high-impact operations should be completed
  outside Box.

### Action broker

For the external writes it covers, the broker replaces classification with
mediation. A Box job cannot perform the write at all; it can only request a
named action from `src/agent/box/action_catalog.ts` with structured parameters.
The Worker validates them, checks the repository allowlist, shows the owner the
exact effect, and — only after a matching one-time approval — performs the
operation itself using a credential the sandbox never receives.

The executor reads its parameters from the stored record, not from anything the
Box sends at execution time, and re-derives the approved fingerprint before
running. What the owner saw is therefore what executes. A fully compromised Box
can request an action or decline to; it cannot widen, alter, or repeat one.

Both `ACTION_BROKER_ENABLED=true` and a non-empty `ACTION_BROKER_GITHUB_REPOS`
are required. An empty allowlist permits nothing: a broker whose scope defaulted
to "anywhere" would be worse than no broker, because it would look like a
boundary.

Limits worth stating: the broker only covers actions in the catalog. Anything
outside it still falls back to the shell classifier and its documented
weaknesses, and adding a loosely-typed action — one taking a raw URL, command,
or arbitrary request body — would reintroduce exactly the gap this closes.

## Operational requirements

- Use separate development and production credentials.
- Set provider-side hard budget and rate limits.
- Rotate a secret immediately if it appears in Git, logs, screenshots, chat, or
  generated output.
- Run a full-history secret scanner before each public release.
- Review dependency and Box SDK changes before upgrading pins.
- Never log request authorization headers, callback signatures, or tokens.
- Keep R2 private and verify its 30-day lifecycle rule.

## Known limitations

- Upstash Box is a preview dependency with possible API, pricing, and isolation
  changes.
- Public-internet access cannot guarantee that all uncredentialed external
  writes are prevented.
- Model-response metering is an application control; provider-side limits are
  still required.
- Telegram download and upload limits constrain direct file transfer.
- There is not yet a formal third-party penetration test or security audit.
