# Changelog

All notable changes to this project are documented here.

## 0.1.0 - 2026-08-13

- Reintroduced the project as Telegram Box Agent with new public documentation,
  safe example configuration, CI, release metadata, and contribution policies.
- Added the Cloudflare Worker/Upstash Box hybrid agent runtime, deterministic
  routing, Redis job state, cancellation, schedules, approval/resume, and R2
  artifact delivery.
- Added a custom Pi harness with DeepSeek metering and an owner-only GLM coding
  route.
- Moved model-provider credentials to exact-host Upstash attached headers,
  blocked private-network Box egress, removed permanent external integration
  credentials, and made group-member Box execution opt-in.
- Removed the experimental private subscription-based model integration and all
  related commands, configuration, tests, UI, and documentation.
- Added body-bound QStash verification and live upstream attestation for
  persistent schedule callbacks.
- Added a provider-free control-plane demo, Worker entrypoint integration tests,
  a sanitized sample PDF, and full-reachable-history secret scanning in CI.
