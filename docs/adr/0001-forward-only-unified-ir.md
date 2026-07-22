# ADR 0001: Forward-only conversion through a unified diagram IR

Status: accepted

## Context

The initial PowerPoint exporter reduced every SVG edge to endpoint pairs. That
made a logical Mermaid edge become several PowerPoint line objects, discarded
Bézier controls, and restarted dash patterns at every bend. Future SVG, draw.io,
JSON Canvas, and visual-layout features would multiply this loss if they each
defined their own intermediate model.

## Decision

Mermaid remains the only authoring source. Core accepts an optional,
target-neutral semantic graph structurally extracted from Mermaid FlowDB and
merges it with renderer SVG geometry before export. The web app enables this for
Flowcharts. This is not a claim that all Mermaid diagram databases expose one
complete common AST.

The IR stores canonical absolute path segments, stable semantic/source keys,
computed stroke metadata, endpoint ownership when known, and source provenance.
Visual edits are stored in a versioned layout sidecar keyed by stable IDs.

For current Flowchart input, the FlowDB adapter supplies stable node and edge
identity, endpoint ownership, parallel-edge order, and nested subgraphs. Direct
SVG/CLI paths recover keys from `data-id`, explicit endpoint attributes, and
tested renderer-ID conventions, with diagnosed geometry fallbacks. The adapter
is structural so `@mmd2pptx/core` does not depend on Mermaid at runtime.

All current format work is forward-only:

```text
Mermaid + optional layout sidecar
  -> Unified Diagram IR
  -> PPTX | SVG | draw.io | JSON Canvas
```

Reverse importers from PPTX, SVG, draw.io, or JSON Canvas are explicitly deferred.

## Consequences

- Exporters cannot introduce target-specific fields into the shared IR.
- Renderer IDs may be retained for diagnostics, but layout persistence must use
  semantic/source keys where available.
- Flowchart source semantics are stronger when FlowDB is supplied; direct SVG
  and CLI identity remains limited by renderer metadata or unambiguous geometry.
- FlowDB read failures, unsupported database shapes, missing elements, and
  ambiguous matches remain observable through diagnostics.
- Unsupported features require explicit diagnostics and capability fallbacks.
- PowerPoint `smart`, `faithful`, and `exact` modes can share geometry without
  forcing other exporters to understand DrawingML.
- The visual editor edits layout overrides rather than rewriting Mermaid source.
