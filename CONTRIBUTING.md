# Contributing

Thanks for improving Telegram Box Agent.

## Development

1. Install Node.js 22 or newer (Wrangler 4 requires it).
2. Run `npm ci`.
3. Copy `.dev.vars.example` to `.dev.vars` and use development-only secrets.
4. Run `npm test`, `npm run typecheck`, and `npm run build` before opening a pull request.

Do not commit credentials, production identifiers, generated screenshots,
local backups, Box output, or `.dev.vars`. Keep changes focused and add tests
for authorization, retries, callback ordering, or other state-machine behavior.

## Pull requests

Describe the user-visible change, security implications, configuration changes,
and verification performed. Breaking changes to Redis record versions, callback
authentication, artifact URLs, Box snapshots, or provider routing must include
a migration or explicit rollout note.

## Security issues

Do not open a public issue for a vulnerability that could expose credentials,
permit unauthorized jobs, forge callbacks, or access another user's artifacts.
Follow the private reporting instructions in `SECURITY.md`.
