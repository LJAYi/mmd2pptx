# PowerPoint edge capability spike

Status: structurally verified against the repository's pinned `pptxgenjs@3.12.0`.

This spike answers one narrow question: which edge primitives can the current
PptxGenJS output path represent as a single editable PowerPoint object, and
which features require a small OOXML layer of our own?

The executable probe lives in
`packages/core/test/fixtures/pptx-edge-capability.ts`. Its tests unzip the
generated presentation and assert the DrawingML in
`packages/core/test/pptx-edge-capability.test.ts`.

## Results

| Edge feature | Current output | One object | Dash and arrows | Follows moved nodes |
| --- | --- | ---: | ---: | ---: |
| Straight line | preset `line` in `<p:sp>` | yes | yes | no |
| Orthogonal polyline | open custom geometry in `<p:sp>` | yes | yes | no |
| Cubic Bézier | open custom geometry in `<p:sp>` | yes | yes | no |
| Quadratic Bézier | open custom geometry in `<p:sp>` | yes | yes | no |
| Arc | open custom geometry in `<p:sp>` | yes | yes | no |
| Native straight/elbow/curved connector | not exposed by PptxGenJS 3.12 | n/a | n/a | n/a |
| Endpoint attachment to a node site | not exposed by PptxGenJS 3.12 | n/a | n/a | no |

### What works now

The PptxGenJS runtime accepts `"custGeom"` with an open point list containing
line, cubic Bézier, quadratic Bézier, and arc commands. It emits one
`<a:custGeom>` with one open `<a:path>`, so a logical edge does not need to be
split at bends or curve segments. A single `<a:ln>` applies the dash pattern
and terminal arrowheads to the whole edge. This is the right primitive for the
future `faithful` mode.

There is one API defect to isolate in an internal adapter: PptxGenJS 3.12 types
the `points` option but omits `"custGeom"` from its public `ShapeType` and
`SHAPE_NAME` declarations. The probe uses one narrow cast; exporter code should
not spread this cast across call sites.

The preset straight line also remains one editable object and supports native
PowerPoint line width, dash, start arrow, and end arrow properties.

### What does not work now

PptxGenJS serializes both primitives as ordinary shapes (`<p:sp>`), not DrawingML
connectors (`<p:cxnSp>`). Its custom geometry includes an empty `<a:cxnLst>`, and
the public API has no way to emit `<a:stCxn>` or `<a:endCxn>` references to a
node shape ID and connection-site index. Consequently:

- moving a node does not move or reroute an edge;
- a custom polyline is visually elbow-shaped but is not an Elbow Connector;
- a custom curve is visually curved but is not a Curved Connector;
- PptxGenJS cannot currently satisfy the defining promise of `smart` mode.

PptxGenJS also exposes arrowhead kinds but not arrowhead size. Edge labels remain
separate editable text objects, as they are in the current exporter.

## Implication for conversion modes

- `faithful`: uses a native connector only for geometry-safe straight edges;
  orthogonal, curved, arc, and complex supported paths use one open Freeform.
- `exact`: remains an SVG fallback and does not depend on native connectors.
- `smart`: now emits native straight, bent, and simple curved connector OOXML,
  with endpoint bindings when a unique node can be resolved. Complex edges
  degrade to faithful Freeform and then a per-edge SVG object.

We do not call an unbound custom polyline an "Elbow Connector" in the API, UI,
diagnostics, or documentation.

`exact` embeds the original SVG (or normalized IR SVG when no source SVG is
available) as one vector picture. Its internal nodes and edges are deliberately
reported as non-editable. Active content and external references are sanitized
before embedding and reported through `PPTX_EXACT_ACTIVE_CONTENT_REMOVED`.

The current `faithful` hybrid deliberately keeps single-bend orthogonal and
simple curved edges as Freeforms because PowerPoint presets may move their bend
or control points. Straight edges are native connectors because that conversion
does not change their geometry. Additional native cases should be enabled only
after their path equivalence is proven.

## Isolated OOXML extension point

Keep the OOXML detail internal to the PPTX exporter. The smallest useful patch
contract is based on stable object names, because PptxGenJS assigns numeric
shape IDs only while writing the package:

```ts
interface NativeConnectorEndpoint {
  nodeObjectName: string;
  siteIndex: number;
}

interface NativeConnectorPatch {
  edgeObjectName: string;
  elementId: string;
  start?: NativeConnectorEndpoint;
  end?: NativeConnectorEndpoint;
}

async function patchNativeConnectors(
  packageData: Uint8Array,
  patches: readonly NativeConnectorPatch[],
): Promise<{ data: Uint8Array; diagnostics: ConversionDiagnostic[] }>;
```

The implemented patcher resolves each unique `objectName` to its generated
`<p:cNvPr id="…">`, replaces only the targeted edge's `<p:sp>`/non-visual shape
properties with `<p:cxnSp>`/`<p:nvCxnSpPr>`, retains the requested connector
preset, and adds `<a:stCxn>`/`<a:endCxn>` bindings. Missing or duplicate names
produce diagnostics instead of relying on object order.

This boundary lets the normal PptxGenJS code continue to own package creation,
themes, shapes, text, and relationships. It also gives tests one isolated
post-processing step to validate or remove if upstream support arrives.

## Remaining manual compatibility check

The automated spike proves package structure, object count, open path geometry,
line styles, and arrowheads. Exporter tests additionally prove the patched
`p:cxnSp`, `a:stCxn`, and `a:endCxn` structure. Before shipping `faithful` or
`smart`, generate the probe presentation and record a manual open/edit/save/
reopen result for:

- PowerPoint for Windows;
- PowerPoint for macOS;
- PowerPoint for the web;
- LibreOffice Impress (best effort).

For freeform edges, verify continuous dashes, arrow direction, Edit Points, and
that saving does not close the open path. For patched connectors, additionally
move and resize both endpoint nodes and verify attachment after save/reopen.
Until that matrix is recorded, smart mode emits
`PPTX_SMART_CONNECTOR_CROSS_PLATFORM_UNVERIFIED`; the implementation only
claims structural OOXML verification.

## Local import smoke test

On 2026-07-22 the synthetic `smart`, `faithful`, and `exact` presentations were
generated and imported headlessly on macOS 26.5.2 arm64 with:

```text
LibreOfficeDev 26.8.0.0.alpha0
commit 2c87e51eeaa2b413ff4ae097b2705eea1995d8e5
```

All three imports exited successfully without repair, corruption, or crash
messages and produced a one-page non-empty PDF:

| Mode | Approx. PPTX size | PDF bytes |
| --- | ---: | ---: |
| `smart` | 15.1 KB | 15,455 |
| `faithful` | 15.1 KB | 15,454 |
| `exact` | 50.1 KB | 14,327 |

The reusable command is:

```bash
pnpm pptx:compatibility
```

It creates synthetic files in a temporary directory, converts each with
`soffice --headless`, checks the PDF header, size, and page count when `pdfinfo`
is available, then deletes the temporary binaries. No generated PPTX or PDF is
tracked in the repository.

Automated package tests additionally verify that connector references resolve
to existing node `cNvPr` IDs, shape IDs are unique, SVG relationships point to
present media files, and `[Content_Types].xml` declares SVG correctly.

This is a LibreOffice import smoke test, not a rendering-fidelity certification.
Microsoft PowerPoint for Windows, macOS, and the web have not been manually
validated. The presence of PowerPoint on the test Mac was not treated as proof,
and Quick Look was not used as a substitute for open/edit/save/reopen testing.
