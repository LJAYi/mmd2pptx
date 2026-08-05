# mmd2pptx GitHub broker

This private workspace package is the separate-origin broker for the read-only
`mmd2pptx` GitHub App. It handles GitHub user authorization, encrypted
server-side sessions, repository browsing, and bounded source-file reads. It
does not render Mermaid or convert diagrams.

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
`/auth/github/callback` URL, and request `Contents: Read-only`. No write,
pull-request, or checks permissions are needed. The production allowlist
contains only `https://ljayi.github.io`; local origins belong in the untracked
`.dev.vars` file.

Repository enumeration and Git Data reads use the expiring GitHub App user
access token. GitHub scopes that token to the intersection of the signed-in
user's access, the App installation's selected repositories, and the App's
read-only Contents permission. The broker re-enumerates that intersection
before every contents request and never sends the token to the web app; this
MVP therefore does not require an App private key or mint installation tokens.

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
- `GET /api/github/installations/{installationId}/repositories`
- `GET /api/github/installations/{installationId}/repositories/{repositoryId}/contents?path=...`
- `POST /auth/logout`

Collection endpoints return opaque, single-use cursors. Repository lists and
directory entries are capped at 5,000 items and snapshotted for five minutes.
The contents route walks the repository's current default-branch Git tree
without following symlinks or submodules. It returns regular UTF-8 `.mmd`,
`.mermaid`, and `.md` files up to 256 KiB; Markdown is returned as source text
for the web app to select a Mermaid code block. Source contents are not stored
by the broker. Each broker request also has an absolute 90-call GitHub request
budget, and repository paths are limited to 32 segments.
