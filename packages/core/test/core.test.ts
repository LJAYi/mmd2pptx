import JSZip from "jszip";
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
});
