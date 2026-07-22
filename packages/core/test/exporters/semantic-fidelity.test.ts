import { readFileSync } from "node:fs";

import { DOMParser } from "@xmldom/xmldom";
import { describe, expect, it } from "vitest";

import {
  drawioExporter,
  jsonCanvasExporter,
  parseMermaidSvg,
  svgExporter,
} from "../../src/index.js";

const FIXTURE = readFileSync(
  new URL("../fixtures/mermaid-11-synthetic-semantics.svg", import.meta.url),
  "utf8",
);

describe("Mermaid 11 stylesheet and special-element diagnostics", () => {
  it("applies deterministic tag/class/id/descendant cascade with inline precedence", () => {
    const result = parseMermaidSvg(FIXTURE);
    const nodeA = result.data.nodes.find(({ id }) => id === "node-a");
    const nodeB = result.data.nodes.find(({ id }) => id === "node-b");

    expect(nodeA).toMatchObject({ fill: "ABCDEF", stroke: "445566", strokeWidth: 2 });
    expect(nodeB).toMatchObject({ fill: "AABBCC", stroke: "111111", strokeWidth: 2 });
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "SVG_CSS_VARIABLE_UNSUPPORTED" }),
      expect.objectContaining({ code: "SVG_CSS_SELECTOR_UNSUPPORTED" }),
      expect.objectContaining({ code: "SVG_USE_UNSUPPORTED", elementId: "unexpanded-use" }),
      expect.objectContaining({ code: "SVG_FILTER_UNSUPPORTED", elementId: "node-b" }),
      expect.objectContaining({ code: "NODE_PATH_SHAPE_UNSUPPORTED", elementId: "node-unknown" }),
      expect.objectContaining({ code: "NODE_TRANSFORM_DOWNGRADED", elementId: "node-rotated" }),
    ]));
  });

  it("maps known markers and diagnoses cross/custom markers without triangle fallback", () => {
    const result = parseMermaidSvg(FIXTURE);
    expect(result.data.edges.find(({ id }) => id === "edge-known")?.endArrow).toBe("triangle");
    expect(result.data.edges.find(({ id }) => id === "edge-cross")?.endArrow).toBeUndefined();
    expect(result.data.edges.find(({ id }) => id === "edge-custom")?.startArrow).toBeUndefined();
    expect(result.diagnostics.filter(({ code }) => code === "EDGE_MARKER_UNSUPPORTED"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ elementId: "edge-cross" }),
        expect.objectContaining({ elementId: "edge-custom" }),
      ]));
  });
});

describe("flowchart group/container export", () => {
  it("recovers nested ownership from geometry when Mermaid emits sibling layers", () => {
    const result = parseMermaidSvg(FIXTURE);
    expect(result.data.groups).toHaveLength(2);
    expect(result.data.groups?.find(({ id }) => id === "group-inner")?.parentId).toBe("outer");
    expect(result.data.nodes.find(({ id }) => id === "node-a")?.parentId).toBe("outer");
    expect(result.data.nodes.find(({ id }) => id === "node-b")?.parentId).toBe("inner");
  });

  it("serializes nested SVG groups and draw.io child-parent container relationships", () => {
    const diagram = parseMermaidSvg(FIXTURE).data;
    const svg = sync(svgExporter.export(diagram)).data;
    const svgDocument = new DOMParser().parseFromString(svg, "image/svg+xml");
    const svgGroups = Array.from(svgDocument.getElementsByTagName("g"));
    expect(svgGroups.find((element) => element.getAttribute("data-source-id") === "group-inner")
      ?.getAttribute("data-parent-group-id")).toBe("outer");
    expect(svgGroups.find((element) => element.getAttribute("data-source-id") === "node-b")
      ?.getAttribute("data-parent-group-id")).toBe("inner");

    const drawio = sync(drawioExporter.export(diagram)).data;
    const drawioDocument = new DOMParser().parseFromString(drawio, "application/xml");
    const cells = Array.from(drawioDocument.getElementsByTagName("mxCell"));
    const inner = cells.find((cell) => cell.getAttribute("data-source-id") === "group-inner");
    const nodeB = cells.find((cell) => cell.getAttribute("data-source-id") === "node-b");
    const geometry = nodeB?.getElementsByTagName("mxGeometry")[0];
    expect(inner?.getAttribute("parent")).toBe(cells
      .find((cell) => cell.getAttribute("data-source-id") === "group-outer")?.getAttribute("id"));
    expect(nodeB?.getAttribute("parent")).toBe(inner?.getAttribute("id"));
    expect(geometry?.getAttribute("x")).toBe("20");
    expect(geometry?.getAttribute("y")).toBe("35");
  });

  it("diagnoses every JSON Canvas group omission", () => {
    const result = sync(jsonCanvasExporter.export(parseMermaidSvg(FIXTURE).data));
    expect(result.diagnostics.filter(({ code }) => code === "JSON_CANVAS_GROUP_UNSUPPORTED"))
      .toHaveLength(2);
    expect(result.summary.editableObjects).toBe(result.summary.nodes + result.summary.edges);
  });

  it("uses deterministic defaults and explicit zIndex overrides in SVG and draw.io", () => {
    const diagram = parseMermaidSvg(FIXTURE).data;
    const outer = diagram.groups?.find(({ id }) => id === "group-outer")!;
    const edge = diagram.edges.find(({ id }) => id === "edge-known")!;
    const node = diagram.nodes.find(({ id }) => id === "node-a")!;
    outer.zIndex = 40;
    edge.zIndex = 30;
    node.zIndex = 20;
    node.text!.zIndex = 10;

    const svgDocument = new DOMParser().parseFromString(
      sync(svgExporter.export(diagram)).data,
      "image/svg+xml",
    );
    const svgItems = Array.from(svgDocument.getElementById("diagram-objects")!.childNodes)
      .filter((item): item is Element => item.nodeType === 1);
    const svgIndex = (predicate: (element: Element) => boolean) => svgItems.findIndex(predicate);
    expect(svgIndex((item) => item.getAttribute("data-label-for") === "node-a"))
      .toBeLessThan(svgIndex((item) => item.getAttribute("data-source-id") === "node-a"));
    expect(svgIndex((item) => item.getAttribute("data-source-id") === "node-a"))
      .toBeLessThan(svgIndex((item) => item.getAttribute("data-source-id") === "edge-known"));
    expect(svgIndex((item) => item.getAttribute("data-source-id") === "edge-known"))
      .toBeLessThan(svgIndex((item) => item.getAttribute("data-source-id") === "group-outer"));

    const drawioDocument = new DOMParser().parseFromString(
      sync(drawioExporter.export(diagram)).data,
      "application/xml",
    );
    const cells = Array.from(drawioDocument.getElementsByTagName("mxCell"));
    const cellIndex = (predicate: (element: Element) => boolean) => cells.findIndex(predicate);
    expect(cellIndex((cell) => cell.getAttribute("data-label-for") === "node-a"))
      .toBeLessThan(cellIndex((cell) => cell.getAttribute("data-source-id") === "node-a"));
    expect(cellIndex((cell) => cell.getAttribute("data-source-id") === "node-a"))
      .toBeLessThan(cellIndex((cell) => cell.getAttribute("data-source-id") === "edge-known"));
    expect(cellIndex((cell) => cell.getAttribute("data-source-id") === "edge-known"))
      .toBeLessThan(cellIndex((cell) => cell.getAttribute("data-source-id") === "group-outer"));

    expect(sync(jsonCanvasExporter.export(diagram)).diagnostics)
      .toContainEqual(expect.objectContaining({
        code: "JSON_CANVAS_Z_INDEX_UNSUPPORTED",
        elementId: "node-a",
      }));
  });
});

function sync<T>(value: T | Promise<T>): T {
  if (value instanceof Promise) throw new Error("Expected synchronous exporter.");
  return value;
}
