# ADR 0002: Separate-origin GitHub broker on Cloudflare Workers

Status: accepted

## Context

The current web application is a static GitHub Pages project at
`https://ljayi.github.io/mmd2pptx/`. Private-repository import needs a GitHub App
private key, OAuth callback handling, installation-token minting, replay-safe
sessions, rate limiting, and controlled logs. None of those secrets or server
operations can safely run in GitHub Pages.

A custom domain could put the static site and broker on the same site, but it
would add domain and routing work before the GitHub import has been validated.
Using authentication cookies across `github.io` and an unrelated broker origin
would depend on third-party cookie behavior that browsers increasingly block.

## Decision

Keep the static application on GitHub Pages and deploy the initial read-only
GitHub broker to a separate Cloudflare Workers origin.

- GitHub authorization opens the broker as a top-level popup.
- The browser generates a PKCE verifier and sends only its `S256` challenge when
  starting authorization.
- The broker validates OAuth `state`, removes the GitHub authorization code from
  the visible URL, and returns a one-time exchange code to the exact approved
  Pages origin with `postMessage`.
- The Pages application exchanges that code together with the verifier. The
  broker validates the challenge before exchanging GitHub's authorization code.
- The broker returns only an opaque `mmd2pptx` session handle, which the Pages
  application stores in memory and sends in an `Authorization` header.
- GitHub user, refresh, and installation tokens remain server-side. Repository
  contents transit the Worker but are not stored there; rendering and exports
  remain in the browser.
- Exact-origin CORS, CSP, short expirations, origin checks, and rate limits are
  part of the launch boundary.

Cloudflare Durable Objects provide strongly consistent, atomic consumption of
OAuth transactions and session updates. Tokens are encrypted at the application
layer before storage. The GitHub App private key, client secret, and session
encryption key use Worker secrets. Cloudflare KV is not used for one-time codes,
PKCE transactions, or other replay-sensitive state because its consistency
model is unsuitable for atomic consumption.

The broker implementation should expose Web-standard request handlers and keep
GitHub and session storage behind small interfaces. This preserves local tests
and avoids coupling the product contract to Durable Object APIs outside the
deployment adapter.

## Consequences

- The existing public URL and GitHub Pages deployment remain unchanged.
- Users do not need a personal access token, and GitHub credentials never enter
  browser code or static assets.
- Browser refresh clears the in-memory app session handle and requires a fresh
  authorization flow. This is an intentional first-release security/UX tradeoff.
- The project gains a Cloudflare account, Worker deployment, Durable Object
  migration, secret-rotation, retention, and incident-response responsibility.
- Private Mermaid source passes through GitHub and the Worker before reaching
  the browser. Privacy copy must state this even though source is not retained.
- The separate origin requires exact CORS and popup-origin handling. It avoids
  ambient cross-site authentication cookies and their third-party-cookie
  reliability problems.
- A future custom domain may move the broker to the same site without changing
  the source-picker API. Switching to cookie authentication would require a new
  ADR and explicit CSRF protection.
- Local development uses a local Worker runtime and mock GitHub endpoints; live
  GitHub integration tests target a dedicated test App and installation.

This ADR selects deployment topology and initial runtime. The endpoint,
permission, security, and acceptance contracts remain in
[`../github-app-mvp.md`](../github-app-mvp.md).
