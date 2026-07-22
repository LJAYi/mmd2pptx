import { describe, expect, it } from "vitest";

import {
  CAPABILITY_MERMAID_VERSION,
  EXPORTER_CAPABILITIES,
  MERMAID_DIAGRAM_CAPABILITIES,
  exporterCapabilities,
  mermaidDiagramCapabilities,
} from "../../src/exporters/capabilities.js";
import { exportDiagramToJsonCanvas } from "../../src/exporters/json-canvas.js";
import type { ExportDiagram } from "../../src/exporters/model.js";

const DIAGRAM: ExportDiagram = {
  width: 400,
  height: 220,
  nodes: [
    {
      id: "start node",
      kind: "roundRect",
      bounds: { x: 20, y: 60, width: 120, height: 64 },
      fill: "#eef4f7",
      text: { text: "Start", bounds: { x: 30, y: 70, width: 100, height: 44 } },
    },
    {
      id: "decision/node",
      kind: "diamond",
      bounds: { x: 260, y: 50, width: 100, height: 84 },
      fill: "faf0e6",
      stroke: "#24323d",
      text: { text: "Continue?", bounds: { x: 270, y: 60, width: 80, height: 64 } },
    },
  ],
  edges: [
    {
      id: "route A",
      sourceId: "start node",
      targetId: "decision/node",
      sourcePort: "east",
      targetPort: "west",
      start: { x: 140, y: 92 },
      end: { x: 260, y: 92 },
      points: [
        { x: 140, y: 92 },
        { x: 200, y: 92 },
        { x: 260, y: 92 },
      ],
      color: "24323d",
      dash: "dash",
      endArrow: "triangle",
      label: { text: "Yes", bounds: { x: 180, y: 70, width: 40, height: 20 } },
    },
  ],
};

describe("exportDiagramToJsonCanvas", () => {
  it("writes stable text nodes, connected edges, sides, labels, and ends", () => {
    const first = exportDiagramToJsonCanvas(DIAGRAM);
    const second = exportDiagramToJsonCanvas(DIAGRAM);
    const canvas = JSON.parse(first.data) as {
      nodes: Array<Record<string, unknown>>;
      edges: Array<Record<string, unknown>>;
    };

    expect(first.data).toBe(second.data);
    expect(canvas.nodes).toHaveLength(2);
    expect(canvas.nodes[0]).toMatchObject({
      type: "text",
      text: "Start",
      x: 20,
      y: 60,
      width: 120,
      height: 64,
      color: "#eef4f7",
    });
    expect(canvas.edges[0]).toMatchObject({
      fromNode: canvas.nodes[0]?.id,
      toNode: canvas.nodes[1]?.id,
      fromSide: "right",
      toSide: "left",
      fromEnd: "none",
      toEnd: "arrow",
      label: "Yes",
      color: "#24323d",
    });
    expect(first.summary).toMatchObject({ nodes: 2, edges: 1, editableObjects: 3 });
  });

  it("reports shape, style, and waypoint degradation without losing connectivity", () => {
    const result = exportDiagramToJsonCanvas(DIAGRAM);
    expect(result.diagnostics.map(({ code }) => code)).toEqual(expect.arrayContaining([
      "JSON_CANVAS_NODE_SHAPE_DOWNGRADED",
      "JSON_CANVAS_NODE_STYLE_DOWNGRADED",
      "JSON_CANVAS_EDGE_PATH_DOWNGRADED",
      "JSON_CANVAS_EDGE_STYLE_DOWNGRADED",
    ]));
    expect(result.summary.fallbackObjects).toBe(2);
  });

  it("omits an edge and diagnoses it when required node endpoints cannot resolve", () => {
    const detached: ExportDiagram = {
      ...DIAGRAM,
      edges: [{
        ...DIAGRAM.edges[0]!,
        sourceId: undefined,
        targetId: undefined,
        start: { x: 200, y: 180 },
        end: { x: 230, y: 180 },
      }],
    };
    const result = exportDiagramToJsonCanvas(detached, { inferConnections: false });
    const canvas = JSON.parse(result.data) as { edges: unknown[] };

    expect(canvas.edges).toEqual([]);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "JSON_CANVAS_EDGE_ENDPOINT_UNRESOLVED",
      elementId: "route A",
    }));
  });

  it("falls back to geometry side inference and diagnoses unknown named ports", () => {
    const result = exportDiagramToJsonCanvas({
      ...DIAGRAM,
      edges: [{ ...DIAGRAM.edges[0]!, sourcePort: "custom-17", targetPort: undefined }],
    });
    const canvas = JSON.parse(result.data) as { edges: Array<Record<string, unknown>> };

    expect(canvas.edges[0]).toMatchObject({ fromSide: "right", toSide: "left" });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "JSON_CANVAS_PORT_DOWNGRADED",
    }));
  });

  it("resolves fromNode and toNode through semantic IDs and source keys", () => {
    const result = exportDiagramToJsonCanvas({
      ...DIAGRAM,
      nodes: [
        { ...DIAGRAM.nodes[0]!, semanticId: "semantic-start" },
        { ...DIAGRAM.nodes[1]!, sourceKey: "source:decision" },
      ],
      edges: [{
        ...DIAGRAM.edges[0]!,
        sourceId: "semantic-start",
        targetId: "source:decision",
      }],
    });
    const canvas = JSON.parse(result.data) as {
      nodes: Array<{ id: string }>;
      edges: Array<{ fromNode: string; toNode: string }>;
    };
    expect(canvas.edges[0]).toMatchObject({
      fromNode: canvas.nodes[0]?.id,
      toNode: canvas.nodes[1]?.id,
    });
  });
});

describe("exporter capability entries", () => {
  it("provides machine-readable coverage for every forward format", () => {
    expect(new Set(EXPORTER_CAPABILITIES.map(({ format }) => format))).toEqual(
      new Set(["pptx", "svg", "drawio", "json-canvas"]),
    );
    expect(exporterCapabilities("json-canvas")).toEqual(
      EXPORTER_CAPABILITIES.filter(({ format }) => format === "json-canvas"),
    );
    expect(exporterCapabilities("json-canvas")).toContainEqual(expect.objectContaining({
      feature: "edge-paths",
      support: "unsupported",
    }));
    expect(exporterCapabilities("pptx")).toEqual(expect.arrayContaining([
      expect.objectContaining({ mode: "smart", feature: "edge-connectivity" }),
      expect.objectContaining({ mode: "faithful", feature: "edge-paths" }),
      expect.objectContaining({ mode: "exact", feature: "visual-fidelity" }),
    ]));
    expect(exporterCapabilities("drawio")).toContainEqual(expect.objectContaining({
      feature: "edge-connectivity",
      support: "fallback",
    }));
    expect(exporterCapabilities("pptx")).toContainEqual(expect.objectContaining({
      feature: "visual-fidelity",
      mode: "exact",
      support: "fallback",
    }));
  });

  it("binds a complete diagram-type matrix to Mermaid 11.16", () => {
    expect(CAPABILITY_MERMAID_VERSION).toBe("11.16.0");
    const flowchart = MERMAID_DIAGRAM_CAPABILITIES.filter(
      ({ diagramType }) => diagramType === "flowchart",
    );
    expect(flowchart).toHaveLength(4);
    expect(flowchart).toEqual(expect.arrayContaining([
      expect.objectContaining({ format: "pptx", status: "smart" }),
      expect.objectContaining({ format: "svg", status: "editable" }),
      expect.objectContaining({ format: "drawio", status: "editable" }),
      expect.objectContaining({ format: "json-canvas", status: "hybrid" }),
    ]));
    expect(mermaidDiagramCapabilities("pptx")).toContainEqual(expect.objectContaining({
      diagramType: "sequenceDiagram",
      mermaidVersion: "11.16.0",
      status: "exact",
    }));
  });
});
