# `@mmd2pptx/core`

Clean-room conversion primitives for turning Mermaid-rendered SVG into native,
editable PowerPoint shapes, text, and connectors.

Browser callers can parse a live SVG element and receive a PPTX `Blob`:

```ts
const parsed = parseMermaidSvgElement(svg);
const pptx = await diagramToPptxBlob(parsed.data, { layout: "wide" });
```

Node callers can convert an SVG string directly:

```ts
const result = await svgStringToPptxBuffer(svgSource);
```

Every operation returns `data`, `diagnostics`, and an editable-object summary.
Generated slide XML is parsed before success is reported.

## Flowchart fidelity

The SVG parser currently preserves:

- rectangle, rounded rectangle/stadium, ellipse, diamond, hexagon,
  parallelogram, trapezoid, and cylinder nodes;
- nested `matrix`, `translate`, `scale`, `rotate`, and skew transforms;
- connector bends expressed by SVG path commands, solid/dashed/dotted lines,
  and common point, arrow, circle, and diamond markers;
- HTML or SVG edge labels as independent editable PowerPoint text objects.

Curves are represented by editable straight segments between their command
endpoints. SVG filters, arbitrary custom paths, marker crosses, clusters, and
CSS rules that are not reflected in computed or inline element styles are not
yet reproduced exactly. The converter reports unsupported geometry through
diagnostics instead of silently emitting an empty slide.

Licensed under Apache-2.0 as part of the mmd2pptx project.
