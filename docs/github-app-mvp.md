# Read-only GitHub App MVP

Status: proposed

## Product statement

The first GitHub integration turns Mermaid files maintained in repositories into
locally generated, editable delivery files:

> Open a Mermaid file from an authorized GitHub repository, preview it in
> `mmd2pptx`, and download PPTX, SVG, draw.io, or JSON Canvas output.

This connects the existing browser converter to GitHub without changing the
conversion pipeline. GitHub is a source picker; the browser remains the place
where Mermaid is rendered and artifacts are generated.

## Goals

- Install and authorize a GitHub App for selected repositories.
- List repositories the signed-in user can access through an installation.
- Browse the default branch and open `.mmd` or `.mermaid` files.
- Load the selected source into the existing editor, preview, and export it with
  the existing format and PowerPoint-mode controls.
- Support private repositories without asking users for a personal access token.
- Preserve paste and local-file workflows when GitHub is unavailable or not
  connected.
- Keep GitHub permissions and the authentication service narrowly scoped.

## Non-goals

The MVP does not:

- parse Mermaid code blocks from Markdown;
- search an entire repository;
- select a branch, tag, or commit;
- write generated files to a repository or create a pull request;
- run as a pull-request bot, Check Run, or synchronization gate;
- render Mermaid or generate exported artifacts on the authentication service;
- replace the existing local `.mmd` and `.mermaid` import.

These boundaries keep the first release read-only. Write-back and automation
must be designed as later, separately permissioned features.

## User journey

1. The user chooses **Open from GitHub** in the web app.
2. If there is no active session, the app opens the GitHub authorization flow.
3. If the GitHub App is not installed for a usable repository, the user is sent
   to GitHub's installation picker and returns to the web app afterward.
4. The user chooses an installation, repository, folder, and Mermaid file on the
   repository's default branch.
5. The selected UTF-8 source replaces the editor content only after an explicit
   confirmation when the editor contains unsaved changes.
6. The existing browser pipeline renders the source and generates the selected
   export locally.
7. The source picker records the repository, path, ref, commit SHA, and source
   blob SHA in browser state so the UI can identify where the open document came
   from.

Signing out deletes the `mmd2pptx` server session and returns the UI to local
mode. Uninstalling or suspending the GitHub App is detected on the next request
and produces a reconnect state rather than an empty repository list.

## System architecture

```text
GitHub Pages web app
  |-- editor, Mermaid rendering, Diagram IR, preview, exports (local)
  |-- GitHub source picker
  |       |
  |       | authenticated HTTPS requests
  |       v
  |   authentication broker
  |       |-- server-side user session
  |       |-- GitHub App private key
  |       `-- short-lived installation tokens
  |               |
  `---------------|----> GitHub REST API
                  `----> session store / secret manager
```

GitHub Pages cannot safely store a GitHub App private key or client secret, mint
installation tokens, or implement callbacks. A small server-side authentication
broker is therefore required even though the UI remains on GitHub Pages.

The broker is not a conversion API. It retrieves authorized source files and
returns their text to the browser. Mermaid rendering, IR creation, validation,
and all exports continue to run in the existing web application.

## Authentication and installation flow

The broker owns all GitHub credentials and server sessions:

1. The web app generates a high-entropy PKCE verifier in memory and derives an
   `S256` challenge.
2. `GET /auth/github/start` validates the approved return origin, creates a
   cryptographically random OAuth `state`, binds it and the challenge to a
   short-lived browser transaction, and redirects to GitHub with the challenge.
3. `GET /auth/github/callback` validates `state` and stores the returned GitHub
   authorization code in that one-time server transaction. It does not exchange
   the GitHub code yet. It redirects to a clean broker completion URL so the
   GitHub code is removed from the address bar and browser history.
4. The clean completion page sends a single-use `mmd2pptx` exchange code to the
   exact approved Pages origin with `postMessage`. It never places a GitHub token
   in a URL or returns one to browser code.
5. `POST /auth/session/exchange` receives the exchange code and original PKCE
   verifier. The broker verifies its `S256` hash against the stored challenge
   before atomically consuming the transaction, then exchanges the stored GitHub
   code and verifier for a GitHub user token.
6. The broker creates a server-side session containing the encrypted GitHub user
   and refresh tokens and returns an opaque, short-lived `mmd2pptx` session
   handle. The web app keeps the handle in memory; it must not use local storage.
7. Before minting an installation token, the broker uses the signed-in user's
   token to enumerate that user's repositories for the installation. It scopes
   the installation token to the intersection of the user-accessible and
   installation-accessible repository sets. Every contents read recomputes or
   revalidates this intersection.

The exchange-code pattern avoids depending on third-party cookies when the
Pages site and broker have different registrable domains. If a custom domain
later places the UI and broker on the same site, an `HttpOnly`, `Secure`,
`SameSite=Lax` cookie may replace the browser-held session handle.

The callback and popup communication must use exact origin allowlists. The
broker must also enforce a restrictive CORS allowlist; wildcard origins are not
allowed for authenticated routes.

The initial deployment uses an explicit `Authorization` header rather than an
ambient browser authentication cookie. The exchange endpoint requires the
one-time code, matching PKCE verifier, and exact allowed `Origin`; logout
requires the session handle and the same origin check. If a future same-site
deployment switches to cookies, every state-changing request must additionally
use a CSRF token and reject missing or mismatched `Origin`/`Referer` headers.

Expiring GitHub App user tokens must be enabled. The broker rotates the user and
refresh tokens server-side before the current token's eight-hour expiry. An
expired, revoked, or unrefreshable GitHub token invalidates the app session and
makes the failing request return `SESSION_EXPIRED`; subsequent requests with
that handle return `SESSION_REQUIRED` and require authorization again.

## Broker API

All JSON responses use stable machine codes for errors. Collection endpoints
are paginated and must not silently truncate GitHub results.

| Method and path | Purpose |
| --- | --- |
| `GET /auth/github/start` | Begin user authorization and preserve the approved return origin |
| `GET /auth/github/callback` | Validate the callback and stage a one-time server transaction |
| `GET /auth/github/complete` | Remove GitHub parameters from the URL and notify the initiating window |
| `POST /auth/session/exchange` | Exchange a single-use callback code for an opaque app session |
| `GET /api/github/session` | Return signed-in state and installation availability |
| `GET /api/github/installations` | List installations accessible to the signed-in user |
| `GET /api/github/installations/{installationId}/repositories` | List repositories accessible through one installation |
| `GET /api/github/installations/{installationId}/repositories/{repositoryId}/contents?path=...` | List a directory or read one supported source file from the default branch |
| `POST /auth/logout` | Invalidate the app session and its cached credentials |

Collection responses use one envelope:

```json
{
  "items": [],
  "next_cursor": null,
  "has_more": false
}
```

The cursor is opaque, bound to the current session and query, and expires with a
five-minute server-side metadata snapshot. The first request fully enumerates
the authorized collection within a configured 5,000-item ceiling, sorts
installations by account login then ID, repositories by full name then ID, and
directory entries by type, name, then blob/tree SHA. `has_more` is true exactly
when another slice remains in that snapshot; `next_cursor` is non-null exactly
in the same case. Invalid, expired, or query-mismatched cursors return
`INVALID_CURSOR` rather than restarting pagination.

Directory enumeration uses Git Data tree metadata rather than the Contents API.
If GitHub marks the tree response as truncated or the directory exceeds the
5,000-entry ceiling, the broker returns `DIRECTORY_TOO_LARGE`; it never presents
a partial directory as complete.

Repository and content responses contain only fields the UI needs. A repository
response includes its numeric ID, owner/name, visibility, default branch, and
installation ID. A file response includes repository ID, path, ref, commit SHA,
blob SHA, size, and UTF-8 source. It does not include an installation token or
raw GitHub response headers.

For the MVP, `contents` is path-oriented rather than a recursive Git tree or
code-search endpoint. At the root and directory levels it returns immediate
children. It returns file contents only when all of the following are true:

- the repository is in the revalidated intersection of the selected
  installation and the signed-in user's accessible repositories;
- the ref is the repository's current default branch;
- the broker resolves the default branch to a commit and walks the Git Data tree
  for the normalized path without following links;
- the verified entry has type `blob` and mode `100644` or `100755`; symlink mode
  `120000`, submodule type `commit`/mode `160000`, and unknown modes are rejected;
- the extension is `.mmd` or `.mermaid`, case-insensitively;
- the file is UTF-8 text and no larger than the configured source limit;
- the source is fetched from the Git Data blob endpoint using the verified entry
  SHA, and the returned SHA, size, encoding, and media type match that entry.

The initial source limit is 256 KiB. Before render, GitHub-loaded source also
passes a conservative browser complexity budget: at most 5,000 lines, 2,000
non-comment statements, and 16 KiB in any one line. These values are versioned
configuration with boundary tests, not GitHub query parameters. The current
main-thread renderer is not considered sufficient protection by itself; files
that exceed any limit remain disabled and private-repository release is blocked
until the preflight exists. Rendering in a terminable worker may replace this
conservative budget later.

This API is separate from the draft `/v1/convert` service in
[`openapi.yaml`](openapi.yaml): one retrieves authorized source, while the other
would perform server-side conversion. The GitHub MVP does not deploy or call the
conversion API.

## Browser integration

GitHub-loaded text enters the same state transition as a local file:

```text
GitHub file text
  -> source editor
  -> Mermaid SVG with securityLevel: strict
  -> Diagram IR
  -> PPTX | SVG | draw.io | JSON Canvas
```

No GitHub-specific fields belong in `@mmd2pptx/core` or `DiagramIR`. Source
provenance is web-application state and may be represented as:

```ts
interface GitHubSourceProvenance {
  installationId: number;
  repositoryId: number;
  repository: string;
  path: string;
  ref: string;
  commitSha: string;
  blobSha: string;
}
```

The picker should use progressive disclosure: connection state first, then
installation, repository, and directory. It needs explicit loading, empty,
expired-session, revoked-installation, insufficient-permission, rate-limit, and
GitHub-outage states. Closing the picker leaves the current diagram untouched.

## Security and privacy model

### Credential handling

- Store the GitHub App private key and client secret in a managed secret store.
- Encrypt GitHub user tokens at rest inside the session store.
- Keep installation tokens server-side, scope them to the selected repository,
  and discard or expire them promptly.
- Rotate secrets without redeploying browser assets.
- Make session handles high-entropy, short-lived, revocable, and unusable after
  logout. Apply idle and absolute expiry.
- Protect the authorization flow with PKCE `S256`, one-time `state`, atomically
  consumed exchange codes, exact redirect/origin validation, and replay
  protection.

### Request authorization

Every repository request revalidates the session, user/installation repository
intersection, installation ID, repository ID, default branch, commit/tree
identity, and normalized path. IDs and paths supplied by the browser are
untrusted. The broker must not accept arbitrary GitHub URLs or forward arbitrary
API routes.

Apply per-session and per-IP rate limits, request timeouts, maximum response
sizes, and conservative GitHub pagination limits. Return a specific reset time
for GitHub rate limits when GitHub provides one.

### Data handling

- Do not persist repository contents or generated artifacts.
- Do not place Mermaid source, GitHub tokens, file paths, repository names, or
  callback codes in application, analytics, or error logs.
- Operational logs may include request IDs, numeric status/error codes, latency,
  byte counts, and installation/repository IDs only when necessary for abuse
  handling; define and publish a short retention period.
- Disable request-body capture in hosting and observability products.
- Never send GitHub-loaded source to the draft conversion API.

The current global statement, "Your diagram stays in this browser," is only
accurate for pasted and locally opened sources. Before GitHub import ships, the
UI and privacy documentation must distinguish the modes:

- **Paste or local file:** source and exports stay in the browser.
- **Open from GitHub:** the broker retrieves the selected source from GitHub;
  conversion and generated artifacts stay in the browser, and the broker does
  not retain file contents.

The web app should add a restrictive Content Security Policy and preserve
Mermaid's `securityLevel: "strict"` setting before accepting private source.

## GitHub App permissions

The read-only MVP requests one repository permission:

| Permission | Access | Reason |
| --- | --- | --- |
| Contents | Read-only | Browse directories and read selected Mermaid files |

GitHub grants metadata read access to every GitHub App installation; it does not
need to be presented as an additional requested capability. The App should
default to **Only select repositories** during installation and explain that
users can change the selection in GitHub.

Later features require a separate permission review and user-facing rationale:

| Later feature | Additional permissions |
| --- | --- |
| Write generated files and create a PR | Contents: read/write; Pull requests: read/write |
| PR conversion checks | Checks: read/write; Pull requests: read; Contents: read |
| Slash commands in issue/PR comments | Issues: read/write |

The MVP must not request these future permissions preemptively.

The implementation should be checked against GitHub's current documentation
for [GitHub App user access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app),
[installation access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app),
[repository contents](https://docs.github.com/en/rest/repos/contents), and
[GitHub App permissions](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps)
when slice 1 begins. GitHub behavior is an external contract; tests should mock
documented responses and include a small opt-in integration suite against a
dedicated test installation.

## Error contract

The broker uses `application/problem+json` with a stable `code`, HTTP status,
safe user-facing detail, and request ID. At minimum, the UI distinguishes:

- `SESSION_REQUIRED` and `SESSION_EXPIRED`;
- `INSTALLATION_REQUIRED`, `INSTALLATION_REVOKED`, and
  `INSUFFICIENT_PERMISSION`;
- `REPOSITORY_NOT_AVAILABLE` and `PATH_NOT_FOUND`;
- `UNSUPPORTED_FILE`, `FILE_TOO_LARGE`, `DIAGRAM_TOO_COMPLEX`, and
  `INVALID_UTF8`;
- `INVALID_CURSOR`, `COLLECTION_TOO_LARGE`, and `DIRECTORY_TOO_LARGE`;
- `GITHUB_RATE_LIMITED` with a reset timestamp;
- `GITHUB_UNAVAILABLE` and `BROKER_UNAVAILABLE`.

GitHub error bodies must not be passed through verbatim. A request ID should let
operators correlate sanitized logs without exposing source or credentials.

## Delivery slices

1. **Authentication shell:** deploy the broker, complete session and installation
   flows, and show connection state without reading repository content.
2. **Read-only source picker:** list installations and repositories, browse the
   default branch, validate supported files, and return source plus provenance.
3. **Local conversion integration:** connect loaded source to the existing
   renderer/exporters, update privacy copy, and cover error and reconnect states.
4. **Limited release:** enable the App for selected installations, observe only
   source-free operational metrics, complete a security review, then make the
   install link public.

Each slice should be a focused pull request. No slice requires changes to the
core conversion API.

## Acceptance criteria

- A user can install the App for one selected public or private repository,
  authorize, browse its default branch, and open a supported Mermaid file.
- A user without access cannot list or read the installation, repository, or
  file by changing request parameters.
- GitHub tokens never reach browser code, URLs, analytics, or logs.
- Repository contents and generated outputs are not stored by the broker.
- Pasted, local-file, and GitHub-loaded sources produce the same preview and
  exporter behavior for identical text.
- PPTX, SVG, draw.io, and JSON Canvas generation occurs in the browser.
- Expired sessions, revoked installations, rate limits, missing files, invalid
  UTF-8, and oversize files produce actionable states without clearing the
  current editor.
- Signing out invalidates the server session; uninstalling the App prevents all
  subsequent repository reads.
- Automated tests cover path normalization, authorization boundaries, callback
  state/PKCE/replay protection, pagination snapshots, tree-entry validation,
  source and complexity limits, sanitized errors, and the picker-to-editor
  transition.
- A browser E2E test mocks the broker, loads source plus provenance, preserves
  unsaved-change confirmation, verifies a non-empty preview and export, and
  asserts that the flow never calls `/v1/convert`.
- The installation page and privacy copy describe the exact requested
  permission and the difference between local and GitHub source modes.

## Deployment decision

The static site remains at `ljayi.github.io`. The broker is deployed as a
separate Cloudflare Worker origin and uses the popup, PKCE, single-use-code, and
in-memory opaque session-handle flow described above. Strongly consistent
Durable Object storage atomically consumes OAuth transactions and holds
encrypted server sessions; GitHub App credentials and the application-level
session-encryption key use Worker secrets. Ordinary eventually consistent KV is
not used for exchange codes or replay-sensitive session state.

This choice, including its privacy and operational consequences, is recorded in
[`adr/0002-separate-origin-github-broker.md`](adr/0002-separate-origin-github-broker.md).
GitHub credentials must never be placed in Pages build variables or static
assets.
