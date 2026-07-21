# `@mmd2pptx/cli`

Convert Mermaid source or Mermaid-generated SVG into an editable PowerPoint
presentation.

## Install

```bash
npm install --global @mmd2pptx/cli
```

The package publishes an ESM API and the `mmd2pptx` executable. It requires
Node.js 20 or newer.

## Convert Mermaid source

```bash
mmd2pptx architecture.mmd --output architecture.pptx
```

`.mmd` files are rendered to SVG with the package-local Mermaid CLI and
Puppeteer, then converted by `@mmd2pptx/core`. No global `mmdc` installation is
used.

## Convert an existing SVG

```bash
mmd2pptx architecture.svg \
  --output architecture.pptx \
  --layout wide \
  --background '#ffffff'
```

The `.svg` path does not launch a browser, so it remains the fastest and
lightest runtime path. Run `mmd2pptx --help` for complete usage.

## Browser runtime

Puppeteer normally downloads a compatible Chrome during installation. If the
machine already has Chrome, Edge, or Chromium, mmd2pptx detects common install
locations. The browser download/cache is typically a few hundred megabytes
(about 230 MB in the macOS ARM64 test environment), and each `.mmd` invocation
launches a headless browser. Set an explicit browser when needed:

```bash
PUPPETEER_EXECUTABLE_PATH=/path/to/chrome mmd2pptx architecture.mmd
```

To suppress Puppeteer's browser download during package installation, set
`PUPPETEER_SKIP_DOWNLOAD=true`; `.mmd` conversion will then require a detected
system browser or `PUPPETEER_EXECUTABLE_PATH`. `.svg` conversion is unaffected.

Each `.mmd` conversion uses an isolated operating-system temporary directory.
Both successful and failed renders remove that directory before returning.

## Library API

The package export includes the CLI argument parser, `runCli`, and the isolated
Mermaid renderer for embedding or testing. Most application integrations should
use `@mmd2pptx/core` directly.

Licensed under Apache-2.0 as part of the mmd2pptx project.
