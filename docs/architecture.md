# mmd2pptx architecture

`mmd2pptx` converts Mermaid diagrams into native, editable PowerPoint objects.
The implementation is clean-room and does not reuse code from unlicensed
projects with similar functionality.

## Layers

1. Mermaid renders source text to SVG.
2. `@mmd2pptx/core` converts a live SVG element to a stable `DiagramIR`.
3. The PowerPoint writer maps the IR to native shapes, text, and connectors.
4. The generated ZIP package is checked for well-formed slide XML.

The browser application runs all four stages locally. Diagram source does not
leave the browser.

## Public surfaces

- `@mmd2pptx/core`: browser and Node-compatible IR/PPTX primitives.
- `mmd2pptx`: command-line Mermaid source or SVG conversion; Mermaid
  source is rendered in an isolated temporary directory before entering core.
- `@mmd2pptx/web`: static GitHub Pages application.
- HTTP API: a separately deployed, versioned service described by
  `openapi.yaml`. GitHub Pages cannot execute this service.

## Reliability contract

The converter must never report success solely because a `.pptx` Blob was
created. Tests inspect the ZIP package and parse slide XML. Unsupported SVG
features must produce diagnostics or an explicit fallback rather than silently
creating an empty slide.

## Security boundaries

The hosted API must reject or tightly constrain remote image URLs to prevent
SSRF. It must enforce input, output, complexity, and execution-time limits. The
static browser build avoids these server-side risks because conversion is local.
