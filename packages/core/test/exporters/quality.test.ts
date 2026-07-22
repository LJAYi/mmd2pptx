import { performance } from "node:perf_hooks";

import { DOMParser } from "@xmldom/xmldom";
import { describe, expect, it } from "vitest";

import { parseSvgPathData } from "../../src/diagram-ir/path.js";
import { drawioExporter } from "../../src/exporters/drawio.js";
import { jsonCanvasExporter } from "../../src/exporters/json-canvas.js";
import { svgExporter } from "../../src/exporters/svg.js";
import { parseMermaidSvg } from "../../src/parse-svg.js";
import type { ConversionResult, DiagramIR } from "../../src/types.js";

const ADVERSARIAL_TEXT = `</text><script>alert("unsafe")</script>&amp;\nnext <img src=x onerror=alert(1)>`;

describe("malformed geometry and identity safety", () => {
  it.each([
    "M 0 0 L",
    "M 0 0 X 10 10",
    "M 0 0 C 1 2 3",
    "M 0 0 L 1e999 2",
    "0 0 L 1 1",
  ])("rejects malformed or non-finite SVG path data: %s", (path) => {
    expect(() => parseSvgPathData(path)).toThrow();
  });

  it("reports malformed XML and malformed Mermaid edge paths", () => {
    expect(parseMermaidSvg("<svg><").diagnostics)
      .toContainEqual(expect.objectContaining({ severity: "error" }));

    const malformedEdge = parseMermaidSvg(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
        <path id="bad" class="flowchart-link" d="M 0 0 C 1"/>
      </svg>
    `);
    expect(malformedEdge.data.edges).toEqual([]);
    expect(malformedEdge.diagnostics).toContainEqual(expect.objectContaining({
      code: "EDGE_PATH_UNSUPPORTED",
      elementId: "bad",
    }));
  });

  it("reports duplicate renderer IDs before they reach an exporter", () => {
    const parsed = parseMermaidSvg(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">
        <g class="node" id="duplicate"><rect x="0" y="0" width="50" height="30"/></g>
        <g class="node" id="duplicate"><rect x="100" y="0" width="50" height="30"/></g>
        <path class="flowchart-link" id="duplicate-edge" d="M50,15 L100,15"/>
        <path class="flowchart-link" id="duplicate-edge" d="M50,25 L100,25"/>
      </svg>
    `);
    expect(parsed.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "DUPLICATE_NODE_ID", severity: "error" }),
      expect.objectContaining({ code: "DUPLICATE_EDGE_ID", severity: "error" }),
    ]));
  });

  it.each([
    ["SVG", svgExporter],
    ["draw.io", drawioExporter],
    ["JSON Canvas", jsonCanvasExporter],
  ] as const)("returns an error diagnostic for duplicate IDs in %s", (_name, exporter) => {
    const diagram: DiagramIR = {
      ...safeDiagram(),
      nodes: [safeDiagram().nodes[0]!, { ...safeDiagram().nodes[0]! }],
    };
    const result = sync(exporter.export(diagram));

    expect(result.data).toHaveLength(0);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ severity: "error" }));
  });

  it.each([
    ["SVG", svgExporter],
    ["draw.io", drawioExporter],
    ["JSON Canvas", jsonCanvasExporter],
  ] as const)("returns an error diagnostic for non-finite geometry in %s", (_name, exporter) => {
    const base = safeDiagram();
    const diagram: DiagramIR = {
      ...base,
      nodes: [{ ...base.nodes[0]!, bounds: { ...base.nodes[0]!.bounds, x: Number.NaN } }],
    };
    const result = sync(exporter.export(diagram));

    expect(result.data).toHaveLength(0);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ severity: "error" }));
  });
});

describe("adversarial text escaping", () => {
  it("keeps SVG well-formed and never creates injected elements", () => {
    const result = sync(svgExporter.export(adversarialDiagram(), {
      title: `</title><script>title()</script>`,
    }));
    const document = new DOMParser().parseFromString(result.data, "image/svg+xml");

    expect(document.getElementsByTagName("parsererror")).toHaveLength(0);
    expect(document.getElementsByTagName("script")).toHaveLength(0);
    expect(document.getElementsByTagName("img")).toHaveLength(0);
    expect(document.getElementsByTagName("text")[0]?.textContent).toContain("<script>");
  });

  it("double-escapes draw.io HTML cell values inside XML attributes", () => {
    const result = sync(drawioExporter.export(adversarialDiagram()));
    const document = new DOMParser().parseFromString(result.data, "application/xml");
    const vertex = Array.from(document.getElementsByTagName("mxCell"))
      .find((cell) => cell.hasAttribute("data-label-for"));
    const value = vertex?.getAttribute("value") ?? "";

    expect(document.getElementsByTagName("parsererror")).toHaveLength(0);
    expect(document.getElementsByTagName("script")).toHaveLength(0);
    expect(value).toContain("&lt;script&gt;");
    expect(value).not.toContain("<script>");
    expect(value).toContain("<br>");
  });

  it("round-trips JSON Canvas text as inert JSON string data", () => {
    const result = sync(jsonCanvasExporter.export(adversarialDiagram()));
    const parsed = JSON.parse(result.data) as { nodes: Array<{ text: string }> };
    expect(parsed.nodes[0]?.text).toBe(ADVERSARIAL_TEXT);
  });

  it("contains public-IR style values inside their SVG and draw.io properties", () => {
    const base = safeDiagram();
    const diagram: DiagramIR = {
      ...base,
      nodes: [{
        ...base.nodes[0]!,
        fill: "#fff;stroke:red",
        stroke: "url(javascript:alert(1))",
        text: {
          ...base.nodes[0]!.text!,
          color: "red;display:none",
          fontFamily: "Arial;evilKey=enabled{color:red}",
        },
      }],
      edges: [],
    };

    const svg = sync(svgExporter.export(diagram)).data;
    const drawio = sync(drawioExporter.export(diagram)).data;
    const svgDocument = new DOMParser().parseFromString(svg, "image/svg+xml");
    const drawioDocument = new DOMParser().parseFromString(drawio, "application/xml");
    const svgShapeStyle = svgDocument.getElementsByTagName("rect")[0]?.getAttribute("style") ?? "";
    const svgTextStyle = svgDocument.getElementsByTagName("text")[0]?.getAttribute("style") ?? "";
    const drawioStyle = Array.from(drawioDocument.getElementsByTagName("mxCell"))
      .find((cell) => cell.getAttribute("vertex") === "1")?.getAttribute("style") ?? "";

    expect(svgShapeStyle).toBe("fill:#ffffff;stroke:#333333;stroke-width:1");
    expect(svgTextStyle).toContain("fill:#222222;font-family:Arial;");
    expect(svg).not.toContain("javascript:");
    expect(drawioStyle).toContain("fillColor=#ffffff;strokeColor=#333333");
    expect(drawioStyle).toContain("fontColor=#222222;fontFamily=Arial;");
    expect(drawioStyle).not.toContain("evilKey");
  });

  it("emits only JSON Canvas 1.0 colors and diagnoses mappings or omissions", () => {
    const base = safeDiagram();
    const second = {
      ...base.nodes[0]!,
      bounds: { x: 120, y: 20, width: 60, height: 40 },
      fill: "not-a-json-canvas-color;evil=1",
      id: "second",
    };
    const diagram: DiagramIR = {
      ...base,
      nodes: [{ ...base.nodes[0]!, fill: "red" }, second],
      edges: [{
        color: "url(javascript:alert(1))",
        end: { x: 120, y: 40 },
        id: "unsafe-edge",
        sourceId: "safe-node",
        start: { x: 100, y: 40 },
        targetId: "second",
      }],
    };
    const result = sync(jsonCanvasExporter.export(diagram));
    const document = JSON.parse(result.data) as {
      edges: Array<{ color?: string }>;
      nodes: Array<{ color?: string }>;
    };
    const colors = [
      ...document.nodes.map(({ color }) => color),
      ...document.edges.map(({ color }) => color),
    ].filter((color): color is string => color !== undefined);

    expect(colors).toEqual(["#ff0000"]);
    expect(colors.every((color) => /^#[0-9a-f]{6}$/i.test(color) || /^[1-6]$/.test(color))).toBe(true);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "JSON_CANVAS_COLOR_MAPPED", elementId: "safe-node" }),
      expect.objectContaining({ code: "JSON_CANVAS_COLOR_OMITTED", elementId: "second" }),
      expect.objectContaining({ code: "JSON_CANVAS_COLOR_OMITTED", elementId: "unsafe-edge" }),
    ]));
  });
});

describe("determinism and medium graph performance", () => {
  it("exports a deterministic 200-node graph within a non-flaky smoke threshold", () => {
    const diagram = mediumDiagram(200);
    const started = performance.now();
    const outputs = [
      sync(svgExporter.export(diagram)),
      sync(drawioExporter.export(diagram)),
      sync(jsonCanvasExporter.export(diagram)),
    ];
    const elapsed = performance.now() - started;

    expect(outputs.map(({ summary }) => summary)).toEqual([
      expect.objectContaining({ nodes: 200, edges: 199 }),
      expect.objectContaining({ nodes: 200, edges: 199 }),
      expect.objectContaining({ nodes: 200, edges: 199 }),
    ]);
    expect(outputs[0]?.data).toBe(sync(svgExporter.export(diagram)).data);
    expect(outputs[1]?.data).toBe(sync(drawioExporter.export(diagram)).data);
    expect(outputs[2]?.data).toBe(sync(jsonCanvasExporter.export(diagram)).data);
    expect(elapsed).toBeLessThan(2_500);
  });
});

function safeDiagram(): DiagramIR {
  return {
    width: 200,
    height: 100,
    nodes: [{
      id: "safe-node",
      kind: "rect",
      bounds: { x: 20, y: 20, width: 80, height: 40 },
      text: { text: "safe", bounds: { x: 25, y: 25, width: 70, height: 30 } },
    }],
    edges: [],
  };
}

function adversarialDiagram(): DiagramIR {
  const diagram = safeDiagram();
  return {
    ...diagram,
    nodes: [{
      ...diagram.nodes[0]!,
      id: `node\"/><script>id()</script>`,
      text: {
        ...diagram.nodes[0]!.text!,
        fontFamily: `Arial\"/><script>font()</script>`,
        text: ADVERSARIAL_TEXT,
      },
    }],
  };
}

function mediumDiagram(size: number): DiagramIR {
  const columns = 20;
  const nodes = Array.from({ length: size }, (_, index) => ({
    id: `node-${index}`,
    semanticId: `n${index}`,
    kind: "roundRect" as const,
    bounds: {
      x: (index % columns) * 110,
      y: Math.floor(index / columns) * 70,
      width: 90,
      height: 44,
    },
    text: {
      text: `Node ${index}`,
      bounds: {
        x: (index % columns) * 110 + 5,
        y: Math.floor(index / columns) * 70 + 5,
        width: 80,
        height: 34,
      },
    },
  }));
  const edges = nodes.slice(1).map((node, index) => {
    const source = nodes[index]!;
    const start = { x: source.bounds.x + source.bounds.width, y: source.bounds.y + 22 };
    const end = { x: node.bounds.x, y: node.bounds.y + 22 };
    return {
      id: `edge-${index}`,
      sourceId: source.semanticId,
      targetId: node.semanticId,
      start,
      end,
      points: [start, end],
      endArrow: "triangle" as const,
    };
  });
  return {
    width: columns * 110,
    height: Math.ceil(size / columns) * 70,
    nodes,
    edges,
  };
}

function sync<T>(value: T | Promise<T>): T {
  if (value instanceof Promise) throw new Error("Expected synchronous exporter.");
  return value;
}
