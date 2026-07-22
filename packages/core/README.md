# `@mmd2pptx/core`

Clean-room conversion primitives for turning Mermaid-rendered SVG into a
target-neutral Diagram IR, then exporting it forward to editable PowerPoint,
normalized SVG, draw.io, or JSON Canvas.

Browser callers can parse a live SVG element and receive a PPTX `Blob`:

```ts
const parsed = parseMermaidSvgElement(svg);
const pptx = await diagramToPptxBlob(parsed.data, {
  layout: "wide",
  mode: "smart",
});
```

Node callers can convert an SVG string directly:

```ts
const result = await svgStringToPptxBuffer(svgSource);
```

Every operation returns `data`, `diagnostics`, and an editable-object summary.
Generated slide XML is parsed before success is reported.

The diagnostic-aware forward exporters share the same contract:

```ts
const parsed = parseMermaidSvg(svgSource);
const normalizedSvg = await svgExporter.export(parsed.data);
const drawio = await drawioExporter.export(parsed.data);
const canvas = await jsonCanvasExporter.export(parsed.data);
```

Low-level deterministic serializers are also exported as
`exportDiagramToSvg`, `exportDiagramToDrawio`, and
`exportDiagramToJsonCanvas`. Reverse import is outside the current scope.

Flowchart callers with access to Mermaid's parsed diagram database can merge
source semantics before export without adding Mermaid as a core dependency:

```ts
const extracted = extractMermaidFlowchartSemantics(mermaidDiagram);
const parsed = parseMermaidSvg(svgSource,
  extracted.graph ? { semantics: extracted.graph } : {});
```

FlowDB supplies stable node/edge identity, endpoint ownership, parallel-edge
order, and nested subgraphs; SVG geometry and computed appearance remain
authoritative. Missing or ambiguous matches are returned as diagnostics.

Layout edits use a versioned sidecar keyed by semantic/source identity and are
applied to the same Diagram IR before any forward exporter runs:

```ts
const sidecar = parseLayoutSidecar(savedLayoutJson);
const laidOut = applyLayoutSidecar(parsed.data, sidecar);
const result = await drawioExporter.export(laidOut.data);
```

`reconcileLayout` carries stable overrides across a fresh Mermaid render,
places new colliding nodes, and drops stale edge routes with explicit change
metadata. Sidecars never replace Mermaid as the semantic source.

Optional sidecar fields preserve cubic/quadratic control geometry, connection
ports, edge labels, z-order, and layout-only groups while remaining compatible
with earlier v1 sidecars.

For automatic layout adjustments, `routeOrthogonal` provides deterministic,
target-neutral obstacle routing from node bounds and optional four-side ports.
It returns compressed M/L geometry plus diagnostics, and uses a bounded search
with an explicit straight-line fallback when no safe route is found.

## Flowchart fidelity

The SVG parser currently preserves:

- rectangle, rounded rectangle/stadium, ellipse, diamond, hexagon,
  parallelogram, trapezoid, and cylinder nodes;
- nested `matrix`, `translate`, and `scale` transforms; rotated/skewed node
  outlines are reduced to diagnosed axis-aligned bounds;
- connector bends expressed by SVG path commands, solid/dashed/dotted lines,
  and common point, arrow, circle, and diamond markers;
- flowchart subgraphs as nested Diagram IR groups, including geometry-based
  ownership recovery for Mermaid's sibling cluster/node layers;
- deterministic tag, class, ID, compound, and descendant stylesheet rules;
- HTML or SVG edge-label text and bounds for target-specific editable output.

Canonical line, cubic Bézier, quadratic Bézier, and arc segments are retained
in the Diagram IR. PPTX offers `smart`, `faithful`, and `exact` modes: native
connectors with per-edge fallback, one open editable Freeform for supported
paths, or one embedded SVG vector object. `svgStringToPptxBuffer` exact mode
sanitizes and embeds the supplied renderer SVG; `diagramToPptxBuffer` has no raw
SVG and therefore embeds a normalized SVG serialized from the IR. Unsupported CSS selectors/variables,
SVG filters, `<use>` references, and unknown path/marker semantics are reported
through diagnostics instead of being silently guessed or omitted.

Before exact mode embeds either SVG form, it removes scripts, event-handler
attributes, active embedded elements, external references, and external CSS
URLs. A warning diagnostic reports when sanitization changes the SVG.

draw.io edges become native source/target references only when explicit
semantic IDs resolve or endpoint geometry identifies a node. Unresolved
endpoints remain detached with a diagnostic; connectivity is therefore a
fallback capability, not an unconditional guarantee.

Licensed under Apache-2.0 as part of the mmd2pptx project.
