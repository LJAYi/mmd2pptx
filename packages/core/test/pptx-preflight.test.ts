import { describe, expect, it } from "vitest";

import { diagramToPptxBuffer, preflightDiagramToPptx } from "../src/pptx.js";
import type { DiagramIR } from "../src/types.js";

const DIAGRAM: DiagramIR = {
  edges: [{
    end: { x: 180, y: 20 },
    id: "edge-a-b",
    path: { segments: [
      { kind: "move", to: { x: 40, y: 20 } },
      { kind: "line", to: { x: 80, y: 20 } },
      { kind: "line", to: { x: 100, y: 60 } },
      { kind: "line", to: { x: 180, y: 20 } },
    ] },
    sourceId: "a",
    start: { x: 40, y: 20 },
    targetId: "b",
  }],
  height: 100,
  nodes: [
    { bounds: { height: 40, width: 40, x: 0, y: 0 }, id: "a", kind: "rect" },
    { bounds: { height: 40, width: 40, x: 180, y: 0 }, id: "b", kind: "rect" },
  ],
  source: { diagramType: "flowchart", kind: "mermaid" },
  width: 220,
};

describe("preflightDiagramToPptx", () => {
  it("reports smart edge fallback without generating a package", () => {
    const result = preflightDiagramToPptx(DIAGRAM, { mode: "smart" });

    expect(result.data).toBeNull();
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "PPTX_SMART_EDGE_FREEFORM_FALLBACK",
      elementId: "edge-a-b",
    }));
    expect(result.summary.fallbackObjects).toBe(1);
  });

  it("describes exact mode as one non-editable SVG object", () => {
    const result = preflightDiagramToPptx(DIAGRAM, { mode: "exact" });

    expect(result.summary.editableObjects).toBe(0);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "PPTX_EXACT_SVG_EMBEDDED",
      severity: "info",
    }));
  });

  it("blocks non-flowchart smart mode while leaving exact available", () => {
    const sequence: DiagramIR = {
      ...DIAGRAM,
      source: { diagramType: "sequenceDiagram", kind: "mermaid" },
    };

    expect(preflightDiagramToPptx(sequence, { mode: "smart" }).diagnostics)
      .toContainEqual(expect.objectContaining({
        code: "PPTX_MODE_UNSUPPORTED_FOR_DIAGRAM_TYPE",
        severity: "error",
      }));
    expect(preflightDiagramToPptx(sequence, { mode: "exact" }).diagnostics)
      .not.toContainEqual(expect.objectContaining({ severity: "error" }));
  });

  it("rejects padding that leaves no drawable slide area", async () => {
    const preflight = preflightDiagramToPptx(DIAGRAM, { mode: "exact", padding: 360 });
    expect(preflight.diagnostics).toContainEqual(expect.objectContaining({
      code: "PPTX_PADDING_EXCEEDS_SLIDE",
      severity: "error",
    }));

    const generated = await diagramToPptxBuffer(DIAGRAM, { mode: "exact", padding: 360 });
    expect(generated.data).toHaveLength(0);
    expect(generated.diagnostics).toEqual(preflight.diagnostics);
  });

  it("rejects invalid node, text, and edge geometry before package generation", () => {
    const invalid: DiagramIR = {
      ...DIAGRAM,
      edges: [{
        ...DIAGRAM.edges[0]!,
        end: { x: Number.NaN, y: 20 },
        label: {
          bounds: { height: 0, width: 20, x: 0, y: 0 },
          text: "invalid",
        },
      }],
      nodes: [{
        ...DIAGRAM.nodes[0]!,
        bounds: { height: 40, width: -1, x: 0, y: 0 },
      }, DIAGRAM.nodes[1]!],
    };

    const result = preflightDiagramToPptx(invalid, { mode: "smart" });
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "PPTX_NODE_BOUNDS_INVALID", elementId: "a" }),
      expect.objectContaining({ code: "PPTX_EDGE_GEOMETRY_INVALID", elementId: "edge-a-b" }),
      expect.objectContaining({ code: "PPTX_TEXT_BOUNDS_INVALID", elementId: "edge-a-b" }),
    ]));
  });

  it("rejects malformed canonical paths and non-finite style values", async () => {
    const invalid: DiagramIR = {
      ...DIAGRAM,
      edges: [{
        ...DIAGRAM.edges[0]!,
        path: { segments: [{ kind: "line", to: { x: 180, y: 20 } }] },
        stroke: { dashArray: [Number.NaN], width: Number.POSITIVE_INFINITY },
      }],
    };

    const preflight = preflightDiagramToPptx(invalid, { mode: "smart" });
    expect(preflight.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "PPTX_EDGE_GEOMETRY_INVALID" }),
      expect.objectContaining({ code: "PPTX_EDGE_STYLE_INVALID" }),
    ]));
    const generated = await diagramToPptxBuffer(invalid, { mode: "smart" });
    expect(generated.data).toHaveLength(0);
    expect(generated.diagnostics).toEqual(preflight.diagnostics);
  });

  it("accepts zero-radius arcs as SVG straight-line degenerations", () => {
    const arc: DiagramIR = {
      ...DIAGRAM,
      edges: [{
        ...DIAGRAM.edges[0]!,
        path: { segments: [
          { kind: "move", to: { x: 40, y: 20 } },
          {
            kind: "arc",
            largeArc: false,
            radiusX: 0,
            radiusY: 0,
            rotation: 0,
            sweep: true,
            to: { x: 180, y: 20 },
          },
        ] },
      }],
    };

    expect(preflightDiagramToPptx(arc, { mode: "exact" }).diagnostics)
      .not.toContainEqual(expect.objectContaining({ severity: "error" }));
  });

  it("reroutes smart edges around non-endpoint nodes without mutating input", async () => {
    const crossing = collisionDiagram();
    const snapshot = structuredClone(crossing);

    const preflight = preflightDiagramToPptx(crossing, { mode: "smart" });
    expect(preflight.diagnostics).toContainEqual(expect.objectContaining({
      code: "PPTX_SMART_EDGE_REROUTED",
      elementId: "edge-a-b",
      severity: "info",
    }));
    expect(crossing).toEqual(snapshot);

    const generated = await diagramToPptxBuffer(crossing, { mode: "smart" });
    expect(generated.diagnostics).toContainEqual(expect.objectContaining({
      code: "PPTX_SMART_EDGE_REROUTED",
      elementId: "edge-a-b",
    }));
    expect(generated.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
    expect(crossing).toEqual(snapshot);
  });

  it("keeps faithful and exact collision geometry isolated from smart rerouting", async () => {
    const crossing = collisionDiagram();
    for (const mode of ["faithful", "exact"] as const) {
      const preflight = preflightDiagramToPptx(crossing, { mode });
      expect(preflight.diagnostics.some(({ code }) => code.includes("REROUTE"))).toBe(false);
      const generated = await diagramToPptxBuffer(crossing, { mode });
      expect(generated.diagnostics.some(({ code }) => code.includes("REROUTE"))).toBe(false);
    }
  });

  it("diagnoses a smart reroute failure per edge when endpoints are unresolved", () => {
    const crossing = collisionDiagram();
    crossing.edges[0] = { ...crossing.edges[0]!, sourceId: "missing" };

    expect(preflightDiagramToPptx(crossing, { mode: "smart" }).diagnostics)
      .toContainEqual(expect.objectContaining({
        code: "PPTX_SMART_EDGE_REROUTE_FAILED",
        elementId: "edge-a-b",
        severity: "warning",
      }));
  });
});

function collisionDiagram(): DiagramIR {
  return {
    width: 220,
    height: 100,
    nodes: [
      { bounds: { height: 40, width: 40, x: 0, y: 20 }, id: "a", kind: "rect" },
      { bounds: { height: 40, width: 40, x: 180, y: 20 }, id: "b", kind: "rect" },
      { bounds: { height: 60, width: 40, x: 90, y: 10 }, id: "blocker", kind: "rect" },
    ],
    edges: [{
      end: { x: 180, y: 40 },
      id: "edge-a-b",
      path: { segments: [
        { kind: "move", to: { x: 40, y: 40 } },
        { kind: "line", to: { x: 180, y: 40 } },
      ] },
      sourceId: "a",
      start: { x: 40, y: 40 },
      targetId: "b",
    }],
    source: { diagramType: "flowchart", kind: "mermaid" },
  };
}
