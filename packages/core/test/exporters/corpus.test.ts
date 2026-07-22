import { readFileSync } from "node:fs";

import { DOMParser } from "@xmldom/xmldom";
import { describe, expect, it } from "vitest";

import { drawioExporter } from "../../src/exporters/drawio.js";
import { jsonCanvasExporter } from "../../src/exporters/json-canvas.js";
import { svgExporter } from "../../src/exporters/svg.js";
import { parseMermaidSvg } from "../../src/parse-svg.js";
import { FORWARD_EXPORT_CORPUS } from "../fixtures/forward-export-corpus.js";

const MERMAID_11_PREFIX = readFileSync(
  new URL("../fixtures/mermaid-11-renderer-prefix.svg", import.meta.url),
  "utf8",
);

describe("synthetic forward-export corpus", () => {
  it("exports deterministic, parseable SVG with stable objects and cubic geometry", () => {
    const first = sync(svgExporter.export(FORWARD_EXPORT_CORPUS));
    const second = sync(svgExporter.export(FORWARD_EXPORT_CORPUS));
    const document = new DOMParser().parseFromString(first.data, "image/svg+xml");
    const sourceObjects = Array.from(document.getElementsByTagName("g"))
      .filter((element) => element.hasAttribute("data-source-id"));

    expect(first.data).toBe(second.data);
    expect(document.getElementsByTagName("parsererror")).toHaveLength(0);
    expect(sourceObjects).toHaveLength(9);
    expect(new Set(sourceObjects.map((element) => element.getAttribute("id"))).size).toBe(9);
    expect(Array.from(document.getElementsByTagName("path"))
      .some((path) => path.getAttribute("d")?.includes("C"))).toBe(true);
    expect(first.data).toContain("C 172,220 148,340 140,280");
    expect(first.data).toContain("Start</tspan>");
    expect(first.data).toContain("here</tspan>");
    expect(first.summary).toMatchObject({ nodes: 5, edges: 4, editableObjects: 9 });
    expect(first.diagnostics.filter(({ code }) =>
      code === "SVG_EDGE_CONNECTIVITY_DOWNGRADED")).toHaveLength(4);
  });

  it("exports connected draw.io vertices and preserves routing intent without rerouting diagonals", () => {
    const first = sync(drawioExporter.export(FORWARD_EXPORT_CORPUS));
    const second = sync(drawioExporter.export(FORWARD_EXPORT_CORPUS));
    const document = new DOMParser().parseFromString(first.data, "application/xml");
    const cells = Array.from(document.getElementsByTagName("mxCell"));
    const nodeVertices = cells.filter((cell) => cell.getAttribute("vertex") === "1"
      && cell.hasAttribute("data-source-id")
      && cell.getAttribute("data-diagram-group") !== "true");
    const groupVertices = cells.filter((cell) => cell.getAttribute("data-diagram-group") === "true");
    const labelVertices = cells.filter((cell) => cell.hasAttribute("data-label-for"));
    const edges = cells.filter((cell) => cell.getAttribute("edge") === "1");
    const bySourceId = new Map(edges.map((edge) => [edge.getAttribute("data-source-id"), edge]));

    expect(first.data).toBe(second.data);
    expect(document.getElementsByTagName("parsererror")).toHaveLength(0);
    expect(nodeVertices).toHaveLength(FORWARD_EXPORT_CORPUS.nodes.length);
    expect(groupVertices).toHaveLength(FORWARD_EXPORT_CORPUS.groups?.length ?? 0);
    expect(labelVertices).toHaveLength(
      FORWARD_EXPORT_CORPUS.nodes.filter(({ text }) => text).length
      + FORWARD_EXPORT_CORPUS.edges.filter(({ label }) => label).length
      + (FORWARD_EXPORT_CORPUS.groups?.filter(({ text }) => text).length ?? 0),
    );
    expect(edges).toHaveLength(4);
    expect(edges.every((edge) => edge.hasAttribute("source") && edge.hasAttribute("target"))).toBe(true);
    expect(bySourceId.get("renderer-edge-orthogonal")?.getAttribute("style"))
      .toContain("edgeStyle=orthogonalEdgeStyle");
    expect(bySourceId.get("renderer-edge-nonorthogonal")?.getAttribute("style"))
      .toContain("edgeStyle=none");
    expect(bySourceId.get("renderer-edge-curve")?.getAttribute("style"))
      .toContain("edgeStyle=none");
    expect(first.diagnostics).toContainEqual(expect.objectContaining({
      code: "DRAWIO_EDGE_PATH_DOWNGRADED",
      elementId: "renderer-edge-curve",
    }));
  });

  it("exports connected JSON Canvas cards and reports unsupported fidelity", () => {
    const first = sync(jsonCanvasExporter.export(FORWARD_EXPORT_CORPUS));
    const second = sync(jsonCanvasExporter.export(FORWARD_EXPORT_CORPUS));
    const canvas = JSON.parse(first.data) as {
      nodes: Array<{ id: string; text: string }>;
      edges: Array<{ fromNode: string; fromSide?: string; toNode: string; toSide?: string }>;
    };
    const nodeIds = new Set(canvas.nodes.map(({ id }) => id));

    expect(first.data).toBe(second.data);
    expect(canvas.nodes).toHaveLength(5);
    expect(canvas.edges).toHaveLength(4);
    expect(canvas.nodes[0]?.text).toBe("Start\nhere");
    expect(canvas.edges.every(({ fromNode, toNode }) =>
      nodeIds.has(fromNode) && nodeIds.has(toNode))).toBe(true);
    expect(canvas.edges[0]).toMatchObject({ fromSide: "right", toSide: "left" });
    expect(first.diagnostics.map(({ code }) => code)).toEqual(expect.arrayContaining([
      "JSON_CANVAS_NODE_SHAPE_DOWNGRADED",
      "JSON_CANVAS_EDGE_PATH_DOWNGRADED",
      "JSON_CANVAS_EDGE_STYLE_DOWNGRADED",
      "JSON_CANVAS_ARROW_DOWNGRADED",
    ]));
    expect(first.summary).toMatchObject({ nodes: 5, edges: 4, editableObjects: 9 });
  });
});

describe("Mermaid 11.16 renderer-prefix fixture", () => {
  it("recovers semantic node IDs and data-id terminals with underscores", () => {
    const parsed = parseMermaidSvg(MERMAID_11_PREFIX);

    expect(parsed.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
    expect(parsed.data.nodes.map(({ semanticId }) => semanticId)).toEqual([
      "start_node",
      "finish",
    ]);
    expect(parsed.data.edges[0]).toMatchObject({
      sourceKey: "L_start_node_finish_0",
      sourceId: "start_node",
      targetId: "finish",
    });

    const drawio = sync(drawioExporter.export(parsed.data));
    const document = new DOMParser().parseFromString(drawio.data, "application/xml");
    const edge = Array.from(document.getElementsByTagName("mxCell"))
      .find((cell) => cell.getAttribute("edge") === "1");
    expect(edge?.hasAttribute("source")).toBe(true);
    expect(edge?.hasAttribute("target")).toBe(true);
  });
});

function sync<T>(value: T | Promise<T>): T {
  if (value instanceof Promise) throw new Error("Expected a synchronous exporter.");
  return value;
}
