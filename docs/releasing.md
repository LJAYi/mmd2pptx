# Releasing mmd2pptx

All releases after v0.2.1 use npm Trusted Publishing. GitHub Actions obtains a
short-lived OIDC credential for each publish; the repository must never store an
npm write token.

## npm trusted publisher settings

Configure both `@mmd2pptx/core` and `mmd2pptx` with the same GitHub Actions
publisher:

| Field | Value |
| --- | --- |
| Organization or user | `LJAYi` |
| Repository | `mmd2pptx` |
| Workflow filename | `publish.yml` |
| Environment | `npm` |
| Allowed action | `npm publish` |

The repository's GitHub `npm` environment accepts deployments only from tags
matching `v*`. Keep that policy aligned with this workflow's tag trigger.

After the first successful OIDC release, set each package's publishing access
to **Require two-factor authentication and disallow tokens**. Trusted Publishing
continues to work because it does not use a traditional npm token.

## Release procedure

1. Update the version in the root, web, Core, and CLI package manifests.
2. Run `pnpm install`, `pnpm check`, `pnpm test`, `pnpm build`, and
   `pnpm --filter @mmd2pptx/web e2e`.
3. Merge the version PR and wait for the `main` CI and Pages workflows.
4. Create and push a stable tag such as `v1.2.3` from the release commit on
   `main`. Do not create the GitHub Release manually.
5. The `Publish npm and release` workflow validates the tag, tests and packs the
   workspace, publishes Core before the CLI, and creates the GitHub Release only
   after both Registry publishes succeed.

Trusted Publishing automatically adds npm provenance attestations. If one job
fails, use GitHub's **Re-run failed jobs** action after correcting external state.
Never move a published tag or attempt to overwrite an npm version; use a new
patch version when source changes are required.
