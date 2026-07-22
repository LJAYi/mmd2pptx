import { DOMParser } from "@xmldom/xmldom";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { diagramToPptxBuffer } from "../src/pptx.js";
import type { DiagramIR } from "../src/types.js";

const DIAGRAM: DiagramIR = {
  edges: [{
    end: { x: 220, y: 60 },
    endArrow: "triangle",
    id: "A-to-B",
    path: { segments: [
      { kind: "move", to: { x: 80, y: 60 } },
      { kind: "line", to: { x: 220, y: 60 } },
    ] },
    sourceId: "A",
    start: { x: 80, y: 60 },
    targetId: "B",
  }],
  height: 120,
  nodes: [{ bounds: { height: 60, width: 60, x: 20, y: 30 }, id: "A", kind: "rect" },
    { bounds: { height: 60, width: 60, x: 220, y: 30 }, id: "B", kind: "rect" }],
  width: 300,
};

describe("PPTX package integrity", () => {
  it.each(["smart", "faithful"] as const)("keeps %s connector references resolvable", async (mode) => {
    const result = await diagramToPptxBuffer(DIAGRAM, { mode });
    expect(result.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
    const zip = await JSZip.loadAsync(result.data);
    const xml = await zip.file("ppt/slides/slide1.xml")?.async("string");
    expect(xml).toBeTruthy();
    const document = new DOMParser().parseFromString(xml ?? "", "application/xml");
    const shapeIds = new Set(Array.from(document.getElementsByTagName("p:cNvPr"))
      .map((element) => element.getAttribute("id"))
      .filter((id): id is string => Boolean(id)));
    const nodeIds = new Set(Array.from(document.getElementsByTagName("p:cNvPr"))
      .filter((element) => element.getAttribute("name")?.startsWith("mmd2pptx-node:"))
      .map((element) => element.getAttribute("id"))
      .filter((id): id is string => Boolean(id)));
    expect(shapeIds.size).toBe(document.getElementsByTagName("p:cNvPr").length);
    expect(document.getElementsByTagName("p:cxnSp")).toHaveLength(1);
    expect(document.getElementsByTagName("p:cNvCxnSpPr")).toHaveLength(1);
    for (const name of ["a:stCxn", "a:endCxn"]) {
      const connections = Array.from(document.getElementsByTagName(name));
      expect(connections).toHaveLength(1);
      expect(shapeIds.has(connections[0]?.getAttribute("id") ?? "")).toBe(true);
      expect(nodeIds.has(connections[0]?.getAttribute("id") ?? "")).toBe(true);
      expect(connections[0]?.getAttribute("idx")).toMatch(/^\d+$/);
    }
  });

  it("keeps exact SVG media and relationships complete", async () => {
    const result = await diagramToPptxBuffer(DIAGRAM, { mode: "exact" });
    expect(result.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
    const zip = await JSZip.loadAsync(result.data);
    const slideXml = await zip.file("ppt/slides/slide1.xml")?.async("string") ?? "";
    const relsXml = await zip.file("ppt/slides/_rels/slide1.xml.rels")?.async("string") ?? "";
    const typesXml = await zip.file("[Content_Types].xml")?.async("string") ?? "";
    const slide = new DOMParser().parseFromString(slideXml, "application/xml");
    const relationships = new DOMParser().parseFromString(relsXml, "application/xml");
    const svgBlip = slide.getElementsByTagName("asvg:svgBlip")[0];
    const relationshipId = svgBlip?.getAttribute("r:embed");
    expect(relationshipId).toBeTruthy();
    const relationship = Array.from(relationships.getElementsByTagName("Relationship"))
      .find((candidate) => candidate.getAttribute("Id") === relationshipId);
    expect(relationship?.getAttribute("Type")).toContain("/image");
    const target = relationship?.getAttribute("Target") ?? "";
    const mediaName = `ppt/${target.replace(/^\.\.\//, "")}`;
    expect(zip.file(mediaName)).toBeTruthy();
    expect(mediaName).toMatch(/\.svg$/);
    for (const imageRelationship of Array.from(relationships.getElementsByTagName("Relationship"))
      .filter((candidate) => candidate.getAttribute("Type")?.endsWith("/image"))) {
      const imageTarget = imageRelationship.getAttribute("Target") ?? "";
      expect(zip.file(`ppt/${imageTarget.replace(/^\.\.\//, "")}`)).toBeTruthy();
    }
    expect(typesXml).toContain('Extension="svg" ContentType="image/svg+xml"');
    expect((await zip.file(mediaName)?.async("string"))?.startsWith("<?xml")).toBe(true);
  });
});
