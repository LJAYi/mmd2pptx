# mmd2pptx

Turn Mermaid diagrams into editable PowerPoint slides.

**Live demo:** [ljayi.github.io/mmd2pptx](https://ljayi.github.io/mmd2pptx/)

`mmd2pptx` is a clean-room, Apache-2.0 implementation built around a reusable
conversion engine. The project favors deterministic, inspectable output: nodes,
labels, and connectors become native PowerPoint objects where possible, and the
conversion result reports diagnostics instead of silently producing an empty
slide.

> **Status:** v0.2.3. The web app and CLI accept Mermaid source, while the core
> SDK converts Mermaid-rendered SVG. The API and rendering coverage may still
> evolve before 1.0.

## Project surfaces

| Surface | Purpose |
| --- | --- |
| Web app | Paste Mermaid, preview it, and download a PPTX locally in the browser |
| `@mmd2pptx/core` | Browser and Node SDK for SVG parsing and PowerPoint generation |
| `mmd2pptx` | Main CLI for converting `.mmd` source or Mermaid-generated `.svg` |
| GitHub Pages | Hosts the static web app without receiving diagram source |

The static app and SDK perform conversion locally. Diagram contents do not need
to leave the user's device.

## Web app

The preview viewer supports mouse or touch dragging, pointer-centered wheel
zoom, 100% reset, fit-to-view, fit-to-width, an expanded view, and copying the
Mermaid source or rendered SVG. Keyboard users can pan with the arrow keys and
use `+`, `-`, `0`, `F`, or `W` for the matching view actions. Viewer transforms
are applied outside the SVG, so changing the preview never changes PPTX output.

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

Install the public core package:

```bash
npm install @mmd2pptx/core
```

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

Install the command globally, then convert either Mermaid source or an existing
SVG:

```bash
npm install --global mmd2pptx
mmd2pptx diagram.mmd --output diagram.pptx
mmd2pptx diagram.svg \
  --output diagram.pptx \
  --layout wide \
  --background '#ffffff'
```

Run `mmd2pptx --help` for all options. `.mmd` conversion launches headless
Chrome through the package-local Mermaid CLI. `.svg` conversion stays on the
direct path and does not launch a browser. See the
[CLI package guide](packages/cli/README.md) for browser configuration and
installation-size details.

## Flowchart support

| Feature | v0.2.3 behavior |
| --- | --- |
| Node shapes | Rectangles, rounded/stadium, ellipse, diamond, hexagon, parallelogram, trapezoid, cylinder |
| Connectors | Editable straight segments with bends, solid/dashed/dotted styles, common start/end markers |
| Edge labels | Editable text from SVG text or Mermaid HTML labels |
| Transforms | Nested matrix, translate, scale, rotate, and skew |
| Curves | Approximated as editable straight segments between path command endpoints |
| Unsupported SVG | Reported through diagnostics; filters, arbitrary paths, clusters, and some CSS are not exact |

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
