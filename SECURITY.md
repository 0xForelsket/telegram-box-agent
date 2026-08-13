# Security policy

## Reporting

Until a dedicated security address is published, report vulnerabilities
privately to the repository owner through GitHub's private vulnerability
reporting feature. Do not include live credentials, personal chat data, or a
working exploit in a public issue.

## Supported version

Security fixes target the latest commit on the default branch. There are no
long-term-support release branches yet.

## Security model

- Cloudflare Workers hold Telegram, Redis, Box, model-provider, callback, and
  artifact-signing credentials.
- Provider secrets are configured as Upstash host-side attached headers. The
  Box receives only non-secret discovery placeholders.
- Box egress uses a custom policy that blocks loopback, private, link-local,
  metadata, carrier-grade NAT, multicast, and reserved address ranges.
- Box execution is owner-only by default. Group-member execution requires the
  explicit `BOX_ALLOW_GROUP_MEMBERS=true` opt-in and assumes every group member
  is trusted.
- Immediate completion callbacks are signed, time-bounded, nonce-bound, and idempotent.
- Persistent schedule callbacks also require a QStash body signature and live
  upstream run attestation.
- Artifact uploads use short-lived job-scoped authorization. R2 remains private;
  downloads use expiring HMAC-signed URLs.
- Permanent third-party integration credentials are never injected into Box.

## Important limitation

The protected-shell-action classifier and Telegram approval/resume mechanism
are defense-in-depth guardrails, not a complete external-write security
boundary. A script can express network behavior that is not visible in its
parent shell command. Do not configure permanent deployment, payment, source
control, messaging, or cloud-account credentials inside Box. A future release
may add a Worker-side action broker with short-lived action-scoped authority.

The Box runtime executes model-generated code. Treat prompts, files, websites,
and generated commands as untrusted. Use separate provider accounts with hard
spend limits and do not enable group-member execution for untrusted groups.
