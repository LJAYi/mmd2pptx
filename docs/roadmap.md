# Forward conversion roadmap

The current roadmap is exclusively forward: Mermaid source plus optional layout
overrides are exported to other formats. Reverse importers are deferred.

## Shared foundation

- Unified Diagram IR v1 with stable semantic/source keys
- optional Mermaid FlowDB semantic graph merged with authoritative SVG geometry
- canonical path geometry and computed stroke metadata
- versioned layout sidecar
- exporter contract and capability diagnostics
- synthetic fixtures and generated compatibility documentation

This foundation is shared by all three product stages and must remain independent
of PowerPoint units, draw.io style strings, and editor-specific state.

## Stage 1: tiered PowerPoint conversion

- `smart`: native straight, elbow, and curved connectors with endpoint binding
- `faithful`: one open Freeform for complex paths and continuous dash/arrow style
- `exact`: SVG fallback for appearance-first output

The current PptxGenJS capability spike is documented in
[`edge-capability.md`](edge-capability.md). `faithful` can use existing custom
geometry; `smart` requires a narrowly scoped OOXML connector patch and manual
cross-platform verification.

## Stage 2: forward format ecosystem

- deterministic normalized SVG
- editable draw.io graph export
- JSON Canvas export for knowledge-canvas workflows
- one machine-readable capability registry shared by SDK, CLI, web, and docs

No draw.io, SVG, or JSON Canvas importer is included in this stage.

## Stage 3: visual adjustment workspace

- Mermaid remains the semantic source
- a versioned sidecar stores positions, sizes, ports, full curve paths, labels,
  groups, and layers
- source reconciliation retains overrides for stable nodes and removes stale data
- the workspace exports through the same PPTX, SVG, draw.io, and JSON Canvas
  implementations as the SDK and CLI

## Parallel delivery lanes

1. IR, source mapping, capability contracts, and integration
2. PowerPoint edge primitives and conversion modes
3. SVG, draw.io, and JSON Canvas exporters
4. layout sidecar and visual editor interactions

Each lane ships independently testable slices, but output integration waits for
the shared IR and stable-ID contracts rather than inventing format-specific
models.
