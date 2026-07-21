# Contributing

Contributions are welcome. By submitting a contribution, you agree that it is
licensed under Apache-2.0 and that you have the right to submit it.

## Development

```bash
pnpm install
pnpm check
pnpm test
pnpm build
```

Please add a regression test for every conversion bug. A successful test must
inspect generated PowerPoint content, not only check that a file was created.

Public examples and test fixtures must follow the
[public example policy](docs/public-example-policy.md). Create them from
scratch, mark them as synthetic, and never adapt user-provided or confidential
material for a demo.

Do not copy code from projects that do not grant an explicit open-source
license. Describe external references and algorithms in the pull request.

## Releases

Maintainers must follow the [Trusted Publishing release process](docs/releasing.md).
Do not add npm write tokens to GitHub Actions or repository settings.
