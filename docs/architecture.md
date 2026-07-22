# mmd2pptx architecture

`mmd2pptx` converts Mermaid diagrams into editable presentation and diagram
formats. The data flow is intentionally one-way: Mermaid is the source of
semantic structure, and no output-format importer is currently in scope.
The implementation is clean-room and does not reuse code from unlicensed
projects with similar functionality.

## Layers

1. Mermaid renders source text to SVG.
2. For Flowcharts, the web app structurally adapts Mermaid FlowDB semantics;
   core merges those identities with renderer SVG geometry into a target-neutral
   `DiagramIR`.
3. Optional layout overrides preserve visual edits without rewriting Mermaid.
4. Forward exporters map the same IR to PPTX, normalized SVG, draw.io, or JSON
   Canvas.
5. Output-specific validators inspect the generated artifact and report explicit
   capability fallbacks.

The browser application runs this pipeline locally. Diagram source does not
leave the browser.

The following are deliberately deferred: draw.io-to-IR, PPTX-to-IR,
SVG-to-Mermaid, and other reverse conversion paths.

## Current source-semantics boundary

Core exposes a Mermaid-independent `MermaidSemanticGraph` contract and a
structural Mermaid 11 FlowDB adapter. The web app uses it for Flowcharts, then
merges node IDs, edge endpoints, parallel-edge order, and nested subgraph
membership into the SVG-derived IR. SVG geometry, computed appearance, and
object order remain authoritative. This is an explicit Flowchart
source-semantics/SVG merge, not a claim that every Mermaid diagram database has
a common AST.

Direct SVG callers and the CLI can still recover identity from renderer metadata
and conventions (`data-id`, explicit endpoint attributes, and tested renderer-ID
patterns). When source semantics are unavailable, endpoint and cluster ownership
use diagnosed geometry fallbacks. Missing, ambiguous, unsupported, or unreadable
semantics remain observable rather than inventing ownership. Core does not add a
runtime Mermaid dependency.

## Shared contracts

- Paths are normalized to absolute Move, Line, Cubic, Quadratic, Arc, and Close
  segments while preserving full control geometry.
- Renderer IDs are retained for provenance. FlowDB semantics take priority when
  supplied; renderer metadata and diagnosed geometry remain deterministic
  fallbacks for direct SVG and CLI workflows.
- Export modes express user intent: `smart` prioritizes connection semantics,
  `faithful` prioritizes editable single-object geometry, and `exact` prioritizes
  appearance.
- Every fallback is observable through diagnostics and the machine-readable
  capability registry.

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
