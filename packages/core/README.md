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

Licensed under Apache-2.0 as part of the mmd2pptx project.
