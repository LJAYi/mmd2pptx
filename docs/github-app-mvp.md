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
7. The source picker records the repository, path, ref, and source blob SHA in
   browser state so the UI can identify where the open document came from.

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

1. `GET /auth/github/start` creates a cryptographically random OAuth `state`,
   binds it to a short-lived browser transaction, and redirects to GitHub.
2. `GET /auth/github/callback` validates `state`, exchanges the GitHub code, and
   creates a server-side session containing the encrypted GitHub user token.
3. The callback sends a single-use exchange code to the approved Pages origin.
   It never places a GitHub token in a URL or returns one to browser code.
4. `POST /auth/session/exchange` consumes the code and returns an opaque,
   short-lived `mmd2pptx` session handle. The web app keeps the handle in memory;
   it must not use local storage.
5. The broker uses the user token to determine which installations the user can
   access. For repository content, it mints a short-lived installation token
   narrowed to the selected repository and keeps that token server-side.

The exchange-code pattern avoids depending on third-party cookies when the
Pages site and broker have different registrable domains. If a custom domain
later places the UI and broker on the same site, an `HttpOnly`, `Secure`,
`SameSite=Lax` cookie may replace the browser-held session handle.

The callback and popup communication must use exact origin allowlists. The
broker must also enforce a restrictive CORS allowlist; wildcard origins are not
allowed for authenticated routes.

## Broker API

All JSON responses use stable machine codes for errors. Collection endpoints
are paginated and must not silently truncate GitHub results.

| Method and path | Purpose |
| --- | --- |
| `GET /auth/github/start` | Begin user authorization and preserve the approved return origin |
| `GET /auth/github/callback` | Validate the callback and create a server session |
| `POST /auth/session/exchange` | Exchange a single-use callback code for an opaque app session |
| `GET /api/github/session` | Return signed-in state and installation availability |
| `GET /api/github/installations` | List installations accessible to the signed-in user |
| `GET /api/github/installations/{installationId}/repositories` | List repositories accessible through one installation |
| `GET /api/github/installations/{installationId}/repositories/{repositoryId}/contents?path=...` | List a directory or read one supported source file from the default branch |
| `POST /auth/logout` | Invalidate the app session and its cached credentials |

Repository and content responses contain only fields the UI needs. A repository
response includes its numeric ID, owner/name, visibility, default branch, and
installation ID. A file response includes repository ID, path, ref, blob SHA,
size, and UTF-8 source. It does not include an installation token or raw GitHub
response headers.

For the MVP, `contents` is path-oriented rather than a recursive Git tree or
code-search endpoint. At the root and directory levels it returns immediate
children. It returns file contents only when all of the following are true:

- the repository belongs to the selected installation and is available to the
  current user;
- the ref is the repository's current default branch;
- the normalized path stays within the repository and identifies a regular
  file, not a symlink or submodule;
- the extension is `.mmd` or `.mermaid`, case-insensitively;
- the file is UTF-8 text and no larger than the configured source limit;
- GitHub's response and media type match the requested operation.

The initial source limit should be 1 MiB. This is high enough for diagrams while
providing a predictable browser and rendering boundary. The UI shows unsupported
files as disabled rather than attempting to open them.

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
- Protect the authorization flow with one-time `state`, one-time exchange codes,
  exact redirect/origin validation, and replay protection.

### Request authorization

Every repository request revalidates the session, installation ID, repository
ID, default branch, and normalized path. IDs and paths supplied by the browser
are untrusted. The broker must not accept arbitrary GitHub URLs or forward
arbitrary API routes.

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
- `UNSUPPORTED_FILE`, `FILE_TOO_LARGE`, and `INVALID_UTF8`;
- `GITHUB_RATE_LIMITED` with a reset timestamp;
- `GITHUB_UNAVAILABLE` and `BROKER_UNAVAILABLE`.

GitHub error bodies must not be passed through verbatim. A request ID should let
operators correlate sanitized logs without exposing source or credentials.

## Delivery slices

0. **Public-link validation:** optionally allow a public GitHub blob URL to be
   resolved through unauthenticated GitHub APIs, then load the resulting Mermaid
   text into the current editor. This validates the picker-to-editor boundary but
   is not a substitute for the App or private repository support.
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
  state/replay protection, pagination, source limits, sanitized errors, and the
  picker-to-editor transition.
- The installation page and privacy copy describe the exact requested
  permission and the difference between local and GitHub source modes.

## Deployment decision before implementation

The static site can remain on GitHub Pages, but the broker needs a runtime,
session store, secret manager, rate limiting, and observability configuration.
Before slice 1, choose one of these deployment shapes:

1. Put a custom domain in front of both Pages and the broker and use same-site
   secure cookies. This has the simplest long-term browser security model.
2. Keep `ljayi.github.io` and deploy a separate broker origin, using the
   popup/single-use-code flow and an in-memory opaque session handle described
   above. This preserves the current URL but requires careful CORS and CSP work.

The selection should be recorded in a deployment ADR. It should evaluate secret
management, session storage, regional/data-retention controls, cost, deployment
ownership, and local-development support. It must not place GitHub credentials
in GitHub Pages build variables or static assets.
