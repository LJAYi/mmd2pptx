import JSZip from "jszip";
import { DOMParser } from "@xmldom/xmldom";
import { describe, expect, it } from "vitest";

import { drawioExporter } from "../../src/exporters/drawio.js";
import { svgExporter } from "../../src/exporters/svg.js";
import { parseMermaidSvg } from "../../src/parse-svg.js";
import { diagramToPptxBuffer } from "../../src/pptx.js";
import type { DiagramIR } from "../../src/types.js";

describe("cross-exporter stroke consistency", () => {
  it("normalizes Mermaid's all-zero solid dash without creating PPTX dots or Illustrator-invisible SVG", async () => {
    const parsed = parseMermaidSvg(svgShell(`
      <style>.edge-pattern-solid { stroke-dasharray: 0; }</style>
      <path id="L_A_B_0" class="flowchart-link edge-pattern-solid"
        d="M40,35 L160,35" stroke="#333333" marker-end="url(#pointEnd)"/>
    `));
    const edge = parsed.data.edges[0]!;

    expect(edge.dash).toBeUndefined();
    expect(edge.stroke?.dashArray).toBeUndefined();

    const normalized = sync(svgExporter.export(parsed.data)).data;
    expect(normalized).not.toContain("stroke-dasharray:0");
    expect(normalized).toContain("marker-end=");

    const drawio = sync(drawioExporter.export(parsed.data)).data;
    const drawioEdge = drawioCell(drawio, "L_A_B_0");
    expect(drawioEdge?.getAttribute("style")).toContain("dashed=0");
    expect(drawioEdge?.getAttribute("style")).not.toContain("dashPattern=0");

    const pptx = await diagramToPptxBuffer(parsed.data);
    const zip = await JSZip.loadAsync(pptx.data);
    const slideXml = await zip.file("ppt/slides/slide1.xml")?.async("string") ?? "";
    expect(slideXml).not.toContain('<a:prstDash val="sysDot"/>');
  });

  it("honors stylesheet !important before source order for animated Mermaid edges", () => {
    const parsed = parseMermaidSvg(svgShell(`
      <style>
        .edge-animation-slow { stroke-dasharray: 9,5 !important; }
        .edge-pattern-solid { stroke-dasharray: 0; }
      </style>
      <path id="L_A_B_0"
        class="flowchart-link edge-animation-slow edge-pattern-solid"
        d="M40,35 L160,35" stroke="#333333"/>
    `));

    expect(parsed.data.edges[0]).toMatchObject({
      dash: "dash",
      stroke: { dashArray: [9, 5] },
    });
    expect(drawioCell(sync(drawioExporter.export(parsed.data)).data, "L_A_B_0")
      ?.getAttribute("style")).toContain("dashed=1;dashPattern=9 5");
    expect(sync(svgExporter.export(parsed.data)).data).toContain("stroke-dasharray:9 5");
  });

  it("inherits SVG stroke dash, line, opacity, marker, and currentColor semantics", () => {
    const parsed = parseMermaidSvg(svgShell(`
      <g color="#1256a0" style="stroke:currentColor;stroke-dasharray:6 3;
        stroke-dashoffset:2;stroke-linecap:square;stroke-linejoin:bevel;
        stroke-opacity:0.4" marker-end="url(#pointEnd)">
        <path id="L_A_B_0" class="flowchart-link" d="M40,35 L160,35"/>
      </g>
    `));

    expect(parsed.data.edges[0]).toMatchObject({
      color: "1256A0",
      dash: "dash",
      endArrow: "triangle",
      stroke: {
        color: "1256A0",
        dashArray: [6, 3],
        dashOffset: 2,
        lineCap: "square",
        lineJoin: "bevel",
        opacity: 0.4,
      },
    });
    expect(sync(svgExporter.export(parsed.data)).data).not.toContain("currentColor");
  });

  it("defensively treats contradictory public IR zero-dash metadata as solid and applies opacity to line plus marker", async () => {
    const diagram = publicDiagram();
    const svg = sync(svgExporter.export(diagram)).data;
    const svgDocument = new DOMParser().parseFromString(svg, "image/svg+xml");
    const edgeGroup = Array.from(svgDocument.getElementsByTagName("g"))
      .find((element) => element.getAttribute("data-source-id") === "edge");
    const edgePath = edgeGroup?.getElementsByTagName("path")[0]
      ?? edgeGroup?.getElementsByTagName("polyline")[0];

    expect(edgeGroup?.getAttribute("opacity")).toBe("0.25");
    expect(edgePath?.getAttribute("style")).not.toContain("stroke-dasharray");
    expect(edgePath?.getAttribute("style")).not.toContain("stroke-opacity");
    expect(svg).not.toContain("currentColor");

    const drawioStyle = drawioCell(sync(drawioExporter.export(diagram)).data, "edge")
      ?.getAttribute("style") ?? "";
    expect(drawioStyle).toContain("dashed=0");
    expect(drawioStyle).not.toContain("dashPattern=0");

    const pptx = await diagramToPptxBuffer(diagram);
    const zip = await JSZip.loadAsync(pptx.data);
    const slideXml = await zip.file("ppt/slides/slide1.xml")?.async("string") ?? "";
    expect(slideXml).not.toContain('<a:prstDash val="sysDot"/>');
  });
});

function svgShell(content: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 80">
    <defs><marker id="pointEnd"><path d="M0,0 L10,5 L0,10 Z"/></marker></defs>
    <g class="node" id="flowchart-A-0"><rect x="0" y="20" width="40" height="30"/></g>
    <g class="node" id="flowchart-B-1"><rect x="160" y="20" width="40" height="30"/></g>
    ${content}
  </svg>`;
}

function publicDiagram(): DiagramIR {
  return {
    edges: [{
      color: "currentColor",
      dash: "dot",
      end: { x: 160, y: 35 },
      endArrow: "triangle",
      id: "edge",
      sourceId: "A",
      start: { x: 40, y: 35 },
      stroke: { color: "currentColor", dashArray: [0, 0], opacity: 0.25 },
      targetId: "B",
    }],
    height: 80,
    nodes: [
      { bounds: { x: 0, y: 20, width: 40, height: 30 }, id: "A", kind: "rect" },
      { bounds: { x: 160, y: 20, width: 40, height: 30 }, id: "B", kind: "rect" },
    ],
    width: 200,
  };
}

function drawioCell(xml: string, sourceId: string): Element | undefined {
  const document = new DOMParser().parseFromString(xml, "application/xml");
  return Array.from(document.getElementsByTagName("mxCell"))
    .find((cell) => cell.getAttribute("data-source-id") === sourceId);
}

function sync<T>(value: T | Promise<T>): T {
  if (value instanceof Promise) throw new Error("Expected synchronous exporter.");
  return value;
}
