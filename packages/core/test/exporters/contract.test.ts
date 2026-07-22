import { describe, expect, it } from "vitest";

import type { DiagramIR } from "../../src/types.js";
import { drawioExporter } from "../../src/exporters/drawio.js";
import { jsonCanvasExporter } from "../../src/exporters/json-canvas.js";
import { svgExporter } from "../../src/exporters/svg.js";

const DIAGRAM: DiagramIR = {
  width: 300,
  height: 160,
  nodes: [
    { id: "a", kind: "rect", bounds: { x: 10, y: 50, width: 80, height: 50 } },
    { id: "b", kind: "rect", bounds: { x: 210, y: 50, width: 80, height: 50 } },
  ],
  edges: [{
    id: "a-b",
    sourceId: "a",
    sourcePort: "east",
    targetId: "b",
    targetPort: "west",
    start: { x: 90, y: 75 },
    end: { x: 210, y: 75 },
    path: { segments: [
      { kind: "move", to: { x: 90, y: 75 } },
      {
        kind: "cubic",
        control1: { x: 125, y: 20 },
        control2: { x: 175, y: 130 },
        to: { x: 210, y: 75 },
      },
    ] },
  }],
};

describe("shared DiagramExporter wrappers", () => {
  it("returns SVG data, summary, and semantic-connectivity degradation", () => {
    const result = svgExporter.export(DIAGRAM);
    expect(result).not.toBeInstanceOf(Promise);
    if (result instanceof Promise) throw new Error("Unexpected async exporter");

    expect(result.data).toContain("<svg");
    expect(result.summary).toMatchObject({ nodes: 2, edges: 1, editableObjects: 3 });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "SVG_EDGE_CONNECTIVITY_DOWNGRADED",
      elementId: "a-b",
    }));
  });

  it("reports draw.io curve and port degradation through the common contract", () => {
    const result = drawioExporter.export(DIAGRAM);
    if (result instanceof Promise) throw new Error("Unexpected async exporter");

    expect(result.data).toContain("<mxfile");
    expect(result.diagnostics.map(({ code }) => code)).toEqual(expect.arrayContaining([
      "DRAWIO_EDGE_PATH_DOWNGRADED",
      "DRAWIO_PORT_DOWNGRADED",
    ]));
    expect(result.summary.fallbackObjects).toBe(1);
  });

  it("uses the common JSON Canvas result and converts serializer throws to diagnostics", () => {
    const valid = jsonCanvasExporter.export(DIAGRAM);
    if (valid instanceof Promise) throw new Error("Unexpected async exporter");
    expect(JSON.parse(valid.data)).toMatchObject({
      nodes: expect.any(Array),
      edges: expect.any(Array),
    });

    const invalid: DiagramIR = { ...DIAGRAM, nodes: [{
      ...DIAGRAM.nodes[0]!,
      bounds: { ...DIAGRAM.nodes[0]!.bounds, width: Number.NaN },
    }] };
    const failed = jsonCanvasExporter.export(invalid);
    if (failed instanceof Promise) throw new Error("Unexpected async exporter");
    expect(failed.data).toBe("");
    expect(failed.diagnostics).toContainEqual(expect.objectContaining({
      code: "JSON_CANVAS_EXPORT_FAILED",
      severity: "error",
    }));
  });

  it("honors common background options and diagnoses unsupported targets", () => {
    const svg = svgExporter.export(DIAGRAM, { backgroundColor: "#f8fafc" });
    const drawio = drawioExporter.export(DIAGRAM, { backgroundColor: "#f8fafc" });
    const canvas = jsonCanvasExporter.export(DIAGRAM, { backgroundColor: "#f8fafc" });
    if (svg instanceof Promise || drawio instanceof Promise || canvas instanceof Promise) {
      throw new Error("Unexpected async exporter");
    }

    expect(svg.data).toContain("#f8fafc");
    expect(drawio.diagnostics).toContainEqual(expect.objectContaining({
      code: "DRAWIO_BACKGROUND_DOWNGRADED",
    }));
    expect(canvas.diagnostics).toContainEqual(expect.objectContaining({
      code: "JSON_CANVAS_BACKGROUND_DOWNGRADED",
    }));
    expect(drawio.summary.fallbackObjects).toBe(1);
    expect(canvas.summary.fallbackObjects).toBe(1);

    const empty: DiagramIR = { edges: [], height: 10, nodes: [], width: 10 };
    const emptyDrawio = drawioExporter.export(empty, { backgroundColor: "#f8fafc" });
    const emptyCanvas = jsonCanvasExporter.export(empty, { backgroundColor: "#f8fafc" });
    if (emptyDrawio instanceof Promise || emptyCanvas instanceof Promise) {
      throw new Error("Unexpected async exporter");
    }
    expect(emptyDrawio.summary.fallbackObjects).toBe(0);
    expect(emptyCanvas.summary.fallbackObjects).toBe(0);
  });

  it.each([
    ["SVG", svgExporter, "SVG_DIAGRAM_TYPE_UNSUPPORTED"],
    ["draw.io", drawioExporter, "DRAWIO_DIAGRAM_TYPE_UNSUPPORTED"],
    ["JSON Canvas", jsonCanvasExporter, "JSON_CANVAS_DIAGRAM_TYPE_UNSUPPORTED"],
  ] as const)("blocks empty %s output for unsupported Mermaid types", (_name, exporter, code) => {
    const result = exporter.export({
      edges: [],
      height: 100,
      nodes: [],
      source: { diagramType: "sequence", kind: "mermaid" },
      width: 200,
    });
    if (result instanceof Promise) throw new Error("Unexpected async exporter");

    expect(result.data).toBe("");
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code,
      severity: "error",
    }));
  });
});
