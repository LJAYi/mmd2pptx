# mmd2pptx

Turn Mermaid diagrams into editable PowerPoint slides.

**Live demo:** [ljayi.github.io/mmd2pptx](https://ljayi.github.io/mmd2pptx/)

`mmd2pptx` is a clean-room, Apache-2.0 implementation built around a reusable
conversion engine. The project favors deterministic, inspectable output: nodes,
labels, and connectors become native PowerPoint objects where possible, and the
conversion result reports diagnostics instead of silently producing an empty
slide.

> **Status:** early MVP. Flowchart SVG conversion is the first supported path;
> expect the API and rendering coverage to evolve before 1.0.
> Workspace packages are intentionally marked private until package-level
> license/readme artifacts and the public API are frozen for the first release.

## Project surfaces

| Surface | Purpose |
| --- | --- |
| Web app | Paste Mermaid, preview it, and download a PPTX locally in the browser |
| `@mmd2pptx/core` | Browser and Node SDK for SVG parsing and PowerPoint generation |
| `@mmd2pptx/cli` | Convert Mermaid-generated `.svg` files from scripts and CI |
| GitHub Pages | Hosts the static web app without receiving diagram source |

The static app and SDK perform conversion locally. Diagram contents do not need
to leave the user's device.

## Web app

Install dependencies and start the development server:

```bash
corepack enable
pnpm install
pnpm dev
```

Build the same static assets deployed to GitHub Pages:

```bash
pnpm pages:build
```

The web build uses relative asset URLs by default, so it works at both a project
site such as `https://<owner>.github.io/mmd2pptx/` and a custom domain. Set
`MMD2PPTX_BASE_PATH` only when an explicit absolute base is preferred.

## SDK

The core package separates SVG parsing from PowerPoint generation so callers can
render Mermaid with their preferred version and security settings:

```ts
import {
  diagramToPptxBlob,
  parseMermaidSvgElement,
} from "@mmd2pptx/core";

const svg = document.querySelector("svg");
if (!svg) throw new Error("Missing SVG");

const parsed = parseMermaidSvgElement(svg);
if (parsed.diagnostics.some(({ severity }) => severity === "error")) {
  throw new Error("The SVG could not be parsed");
}

const result = await diagramToPptxBlob(parsed.data, {
  layout: "wide",
  backgroundColor: "#ffffff",
});

console.log(result.summary, result.diagnostics);
// result.data is the generated Blob.
```

The browser app adds the Mermaid-source-to-SVG step on top of this API.

For Node, the convenience API accepts an SVG string without requiring a DOM:

```ts
import { readFile, writeFile } from "node:fs/promises";
import { svgStringToPptxBuffer } from "@mmd2pptx/core";

const svg = await readFile("diagram.svg", "utf8");
const result = await svgStringToPptxBuffer(svg, { layout: "wide" });
await writeFile("diagram.pptx", result.data);
```

## CLI

The MVP CLI accepts an SVG already rendered by Mermaid. Keeping Mermaid CLI out
of the required dependency tree avoids downloading a browser runtime for users
who only need SVG conversion.

```bash
pnpm --filter @mmd2pptx/cli build
node packages/cli/dist/cli.js diagram.svg \
  --output diagram.pptx \
  --layout wide \
  --background '#ffffff'
```

Run `mmd2pptx --help` for all options. Direct `.mmd` input can be layered on by
a caller or a future optional Mermaid CLI integration.

## HTTP API and GitHub Pages

GitHub Pages only serves static files; it cannot implement a server-side endpoint
such as `POST /v1/convert`. The browser SDK is an open JavaScript API and is fully
compatible with Pages, but a public HTTP API needs a separate runtime (for
example, a Worker or container), plus request limits, timeouts, abuse protection,
and an explicit data-retention policy.

A future HTTP service should call the same core package rather than creating a
second conversion implementation.

## Development

```bash
pnpm check
pnpm test
pnpm build
```

The repository is a pnpm workspace:

```text
apps/web       static browser app
packages/core  conversion engine
packages/cli   command-line interface
```

## Clean-room implementation

The idea of converting Mermaid diagrams into PowerPoint is not unique to any one
codebase. This repository is implemented independently from public projects that
do not grant a software license. Do not copy source, tests, assets, or distinctive
documentation from an unlicensed repository into this project.

## License

Licensed under the [Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for project
attribution. Dependencies retain their respective licenses.
