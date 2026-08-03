# mmd2pptx GitHub broker

This private workspace package is the separate-origin authentication shell for
the read-only `mmd2pptx` GitHub App. It handles GitHub user authorization,
encrypted server-side sessions, and installation listing. It does not read
repository contents or convert diagrams.

## Local development

Copy `.dev.vars.example` to `.dev.vars`, create a dedicated test GitHub App, and
set its callback URL to:

```text
http://localhost:8787/auth/github/callback
```

Generate a 32-byte base64 encryption key without printing it into shell history,
store it as `SESSION_ENCRYPTION_KEY`, then run:

```bash
pnpm --filter @mmd2pptx/github-broker dev
```

The committed Wrangler configuration contains no credentials. Production
secrets must be set with Cloudflare Worker secrets, and `BROKER_PUBLIC_URL` must
be set to the deployed HTTPS Worker origin before deployment.

For production, configure these values without committing them:

| Value | Storage |
| --- | --- |
| `GITHUB_APP_CLIENT_SECRET` | Worker secret |
| `SESSION_ENCRYPTION_KEY` | Worker secret containing 32 random bytes in base64 |
| `GITHUB_APP_CLIENT_ID` | Worker variable or secret |
| `GITHUB_APP_SLUG` | Worker variable |
| `BROKER_PUBLIC_URL` | Worker variable containing the exact HTTPS origin |

The GitHub App must enable expiring user access tokens, use the exact deployed
`/auth/github/callback` URL, and request no repository permissions for this
installation-listing shell. The production allowlist contains only
`https://ljayi.github.io`; local origins belong in the untracked `.dev.vars`
file.

Deployment is intentionally manual until a dedicated Cloudflare account,
Worker URL, test GitHub App, secret-rotation procedure, and limited-release
owner have been confirmed. CI performs a Wrangler dry-run and never receives
deployment credentials.

## Implemented routes

- `GET /health`
- `GET /auth/github/start`
- `GET /auth/github/callback`
- `GET /auth/github/complete`
- `POST /auth/session/exchange`
- `GET /api/github/session`
- `GET /api/github/installations`
- `POST /auth/logout`

Repository browsing and file reads belong to a later pull request.
