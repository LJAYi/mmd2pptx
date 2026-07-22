import { DOMParser } from "@xmldom/xmldom";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { diagramToPptxBuffer, preflightDiagramToPptx } from "../src/pptx.js";
import type { DiagramIR } from "../src/types.js";

const ORDERED_DIAGRAM: DiagramIR = {
  edges: [{
    end: { x: 250, y: 55 },
    id: "edge-high",
    label: {
      bounds: { height: 14, width: 40, x: 130, y: 45 },
      text: "edge label",
      zIndex: 5,
    },
    sourceId: "node-low",
    start: { x: 70, y: 55 },
    targetId: "node-high",
    zIndex: 3,
  }, {
    end: { x: 250, y: 75 },
    id: "edge-low",
    sourceId: "node-low",
    start: { x: 70, y: 75 },
    targetId: "node-high",
    zIndex: -2,
  }],
  groups: [{
    bounds: { height: 120, width: 300, x: 10, y: 10 },
    id: "group-default-a",
    text: {
      bounds: { height: 16, width: 100, x: 20, y: 14 },
      text: "default a",
      zIndex: 2,
    },
  }, {
    bounds: { height: 100, width: 280, x: 20, y: 20 },
    id: "group-low",
    zIndex: -5,
  }, {
    bounds: { height: 80, width: 260, x: 30, y: 30 },
    id: "group-default-b",
  }, {
    bounds: { height: 60, width: 240, x: 40, y: 40 },
    id: "group-high",
    text: {
      bounds: { height: 16, width: 100, x: 180, y: 14 },
      text: "high group",
    },
    zIndex: 5,
  }],
  height: 150,
  nodes: [{
    bounds: { height: 50, width: 50, x: 250, y: 40 },
    id: "node-high",
    kind: "rect",
    text: {
      bounds: { height: 20, width: 40, x: 255, y: 55 },
      text: "high",
      zIndex: -3,
    },
    zIndex: 4,
  }, {
    bounds: { height: 50, width: 50, x: 20, y: 40 },
    id: "node-low",
    kind: "rect",
    text: {
      bounds: { height: 20, width: 40, x: 25, y: 55 },
      text: "low",
      zIndex: 0,
    },
    zIndex: -1,
  }],
  width: 320,
};

async function objectNames(data: Uint8Array): Promise<string[]> {
  const zip = await JSZip.loadAsync(data);
  const xml = await zip.file("ppt/slides/slide1.xml")?.async("string") ?? "";
  const document = new DOMParser().parseFromString(xml, "application/xml");
  return Array.from(document.getElementsByTagName("p:cNvPr"))
    .map((element) => element.getAttribute("name") ?? "")
    .filter((name) => name.startsWith("mmd2pptx-"));
}

describe("PPTX groups and shared zIndex", () => {
  it.each(["smart", "faithful"] as const)(
    "keeps %s objects editable in category and stable z-order",
    async (mode) => {
      const result = await diagramToPptxBuffer(ORDERED_DIAGRAM, { mode });
      expect(result.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
      expect(result.summary).toMatchObject({ editableObjects: 13, fallbackObjects: 0 });
      expect(await objectNames(result.data)).toEqual([
        "mmd2pptx-group:group-low",
        "mmd2pptx-group:group-default-a",
        "mmd2pptx-group:group-default-b",
        "mmd2pptx-group:group-high",
        "mmd2pptx-edge:edge-low",
        "mmd2pptx-edge:edge-high",
        "mmd2pptx-node:node-low",
        "mmd2pptx-node:node-high",
        "mmd2pptx-label:node:node-high",
        "mmd2pptx-label:group:group-high",
        "mmd2pptx-label:node:node-low",
        "mmd2pptx-label:group:group-default-a",
        "mmd2pptx-label:edge:edge-high",
      ]);
    },
  );

  it("reports invalid group geometry and style during preflight", () => {
    const result = preflightDiagramToPptx({
      edges: [],
      groups: [{
        bounds: { height: 0, width: 100, x: 0, y: 0 },
        id: "invalid-group",
        strokeWidth: -1,
        text: {
          bounds: { height: 10, width: 30, x: 0, y: 0 },
          text: "invalid",
          zIndex: Number.POSITIVE_INFINITY,
        },
      }],
      height: 100,
      nodes: [],
      width: 100,
    }, { mode: "smart" });
    expect(result.summary.editableObjects).toBe(2);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "PPTX_GROUP_BOUNDS_INVALID", elementId: "invalid-group" }),
      expect.objectContaining({ code: "PPTX_GROUP_STYLE_INVALID", elementId: "invalid-group" }),
    ]));
  });

  it("keeps exact mode as one non-editable SVG object", async () => {
    const result = await diagramToPptxBuffer(ORDERED_DIAGRAM, { mode: "exact" });
    expect(result.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
    expect(result.summary.editableObjects).toBe(0);
    const zip = await JSZip.loadAsync(result.data);
    const xml = await zip.file("ppt/slides/slide1.xml")?.async("string") ?? "";
    expect(xml.match(/<p:pic(?:\s|>)/g)).toHaveLength(1);
    expect(xml).not.toContain("mmd2pptx-group:");
  });
});
