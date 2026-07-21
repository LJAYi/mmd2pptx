import JSZip from "jszip";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  normalizeFontFamily,
  parseMermaidSvg,
  svgStringToPptxBuffer,
} from "../src/index.js";

const SIMPLE_FLOW = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 180">
  <g class="nodes">
    <g class="node default" id="flowchart-A-0" transform="translate(90,90)">
      <rect class="basic label-container" x="-60" y="-30" width="120" height="60"
        rx="6" fill="#eef4f7" stroke="#202830" stroke-width="2" />
      <foreignObject x="-50" y="-20" width="100" height="40"
        style="font-family: &quot;Trebuchet MS&quot;, Arial, sans-serif; font-size: 16px; color: #202830">
        <div xmlns="http://www.w3.org/1999/xhtml">Start<br/>here</div>
      </foreignObject>
    </g>
    <g class="node default" id="flowchart-B-1" transform="translate(330,90)">
      <polygon points="0,-40 70,0 0,40 -70,0" fill="#ffffff" stroke="#202830" />
      <foreignObject x="-50" y="-20" width="100" height="40" style="font-family: Arial">
        <div xmlns="http://www.w3.org/1999/xhtml">Check</div>
      </foreignObject>
    </g>
  </g>
  <g class="edgePaths">
    <path id="L_A_B_0" class="flowchart-link" d="M150,90 L260,90" stroke="#202830" stroke-width="2" fill="none" />
  </g>
</svg>`;

const EDGE_FIDELITY = readFileSync(
  new URL("./fixtures/edge-fidelity.svg", import.meta.url),
  "utf8",
);
const NODE_SHAPES = readFileSync(
  new URL("./fixtures/node-shapes-transforms.svg", import.meta.url),
  "utf8",
);

describe("normalizeFontFamily", () => {
  it("keeps one safe PowerPoint typeface", () => {
    expect(normalizeFontFamily('"Trebuchet MS", Arial, sans-serif')).toBe("Trebuchet MS");
    expect(normalizeFontFamily("Arial, sans-serif")).toBe("Arial");
  });
});

describe("parseMermaidSvg", () => {
  it("creates editable flowchart IR from SVG attributes", () => {
    const result = parseMermaidSvg(SIMPLE_FLOW);
    expect(result.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
    expect(result.summary).toMatchObject({ nodes: 2, edges: 1, editableObjects: 3 });
    expect(result.data.nodes[0]).toMatchObject({ kind: "roundRect" });
    expect(result.data.nodes[0]?.text?.fontFamily).toBe("Trebuchet MS");
    expect(result.data.nodes[0]?.text?.text).toBe("Start\nhere");
    expect(result.data.nodes[1]).toMatchObject({ kind: "diamond" });
  });

  it("prefers a direct polygon over zero-sized rects nested in its label", () => {
    const result = parseMermaidSvg(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 120">
        <g class="node" id="diamond" transform="translate(100,60)">
          <polygon points="0,-40 60,0 0,40 -60,0" />
          <g class="label"><rect width="0" height="0" /></g>
        </g>
      </svg>
    `);

    expect(result.data.nodes).toHaveLength(1);
    expect(result.data.nodes[0]).toMatchObject({ id: "diamond", kind: "diamond" });
    expect(result.diagnostics).not.toContainEqual(
      expect.objectContaining({ code: "NODE_GEOMETRY_INVALID" }),
    );
  });

  it("includes shape-level transforms when positioning Mermaid v11 diamonds", () => {
    const result = parseMermaidSvg(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 200">
        <g class="node" id="translated-diamond" transform="translate(120,20)">
          <polygon transform="translate(-50,60)"
            points="0,-20 30,0 0,20 -30,0" />
          <g class="label"><rect width="0" height="0" /></g>
        </g>
      </svg>
    `);

    expect(result.data.nodes).toHaveLength(1);
    expect(result.data.nodes[0]).toMatchObject({
      id: "translated-diamond",
      kind: "diamond",
      bounds: { x: 40, y: 60, width: 60, height: 40 },
    });
  });

  it("uses a Mermaid v11 outer-path outline for stadium nodes", () => {
    const result = parseMermaidSvg(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 140">
        <g class="node" id="stadium" transform="translate(120,70)">
          <g class="label"><rect width="0" height="0" /></g>
          <g class="label-container outer-path">
            <path d="M-70,-30 L70,-30 L70,30 L-70,30 Z" />
          </g>
        </g>
      </svg>
    `);

    expect(result.data.nodes).toHaveLength(1);
    expect(result.data.nodes[0]).toMatchObject({ id: "stadium", kind: "roundRect" });
    expect(result.diagnostics).not.toContainEqual(
      expect.objectContaining({ code: "NODE_GEOMETRY_INVALID" }),
    );
  });
});

describe("synthetic compatibility corpus", () => {
  it("marks every standalone fixture as synthetic", () => {
    expect(EDGE_FIDELITY).toContain("mmd2pptx synthetic fixture");
    expect(NODE_SHAPES).toContain("mmd2pptx synthetic fixture");
  });

  it("preserves connector bends, dash patterns, markers, and editable labels", () => {
    const result = parseMermaidSvg(EDGE_FIDELITY);
    expect(result.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
    expect(result.summary).toMatchObject({ nodes: 3, edges: 2, editableObjects: 10 });
    expect(result.data.edges[0]).toMatchObject({
      dash: "dash",
      endArrow: "triangle",
      points: [
        { x: 100, y: 60 },
        { x: 170, y: 60 },
        { x: 170, y: 130 },
        { x: 220, y: 130 },
      ],
      label: { text: "e1" },
    });
    expect(result.data.edges[1]).toMatchObject({
      dash: "dot",
      startArrow: "oval",
      endArrow: "diamond",
      label: { text: "e2" },
    });
  });

  it("maps common shapes and composes nested affine transforms", () => {
    const result = parseMermaidSvg(NODE_SHAPES);
    expect(result.data.nodes.map(({ kind }) => kind)).toEqual([
      "roundRect",
      "ellipse",
      "diamond",
      "hexagon",
      "roundRect",
      "parallelogram",
      "trapezoid",
      "cylinder",
      "rect",
      "rect",
    ]);
    expect(result.data.nodes.at(-2)?.bounds).toEqual({
      x: 470,
      y: 146,
      width: 80,
      height: 48,
    });
    expect(result.data.nodes.at(-1)?.bounds).toEqual({
      x: 560,
      y: 155,
      width: 60,
      height: 30,
    });
  });
});

describe("svgStringToPptxBuffer", () => {
  it("writes a non-empty package with well-formed slide XML and safe fonts", async () => {
    const result = await svgStringToPptxBuffer(SIMPLE_FLOW, { layout: "wide" });
    expect(result.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
    expect(result.data.byteLength).toBeGreaterThan(10_000);

    const zip = await JSZip.loadAsync(result.data);
    const slideXml = await zip.file("ppt/slides/slide1.xml")?.async("string");
    expect(slideXml).toBeTruthy();
    expect(slideXml).toContain("<p:sp>");
    expect(slideXml).toContain('typeface="Trebuchet MS"');
    expect(slideXml).not.toContain('typeface=""Trebuchet');
  });

  it("emits one native object per connector segment, label, and node", async () => {
    const result = await svgStringToPptxBuffer(EDGE_FIDELITY);
    expect(result.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
    expect(result.summary.editableObjects).toBe(10);

    const zip = await JSZip.loadAsync(result.data);
    const slideXml = await zip.file("ppt/slides/slide1.xml")?.async("string");
    expect(slideXml).toBeTruthy();
    expect(slideXml?.match(/<p:sp(?:\s|>)/g)).toHaveLength(10);
    expect(slideXml).toContain(">e1</a:t>");
    expect(slideXml).toContain(">e2</a:t>");
    expect(slideXml).toContain('type="triangle"');
    expect(slideXml).toContain('type="diamond"');
    expect(slideXml).toContain('type="oval"');
  });
});
