import { describe, expect, it } from "vitest";

import {
  classifyDiagramPath,
  parseMermaidSvg,
  parseSvgPathData,
  transformDiagramPath,
} from "../src/index.js";

describe("canonical SVG path IR", () => {
  it("starts a new subpath for each explicit moveto command", () => {
    expect(parseSvgPathData("M 0 0 M 10 10 20 20").segments).toEqual([
      { kind: "move", to: { x: 0, y: 0 } },
      { kind: "move", to: { x: 10, y: 10 } },
      { kind: "line", to: { x: 20, y: 20 } },
    ]);
  });

  it("expands shorthand and relative commands while preserving curve controls", () => {
    const path = parseSvgPathData(
      "M10 10 h20 v10 l-5 5 C30 30 40 40 50 30 s20-10 30 0 Q90 50 100 30 t20 0 A8 6 15 0 1 140 40 z",
    );

    expect(path.segments.map(({ kind }) => kind)).toEqual([
      "move",
      "line",
      "line",
      "line",
      "cubic",
      "cubic",
      "quadratic",
      "quadratic",
      "arc",
      "close",
    ]);
    expect(path.segments[4]).toMatchObject({
      control1: { x: 30, y: 30 },
      control2: { x: 40, y: 40 },
      to: { x: 50, y: 30 },
    });
    expect(path.segments[5]).toMatchObject({
      control1: { x: 60, y: 20 },
      control2: { x: 70, y: 20 },
      to: { x: 80, y: 30 },
    });
    expect(path.segments[7]).toMatchObject({
      control: { x: 110, y: 10 },
      to: { x: 120, y: 30 },
    });
  });

  it("applies affine transforms to endpoints and Bézier controls", () => {
    const path = parseSvgPathData("M1 2 C3 4 5 6 7 8");
    const transformed = transformDiagramPath(path, {
      a: 2,
      b: 0,
      c: 0,
      d: 3,
      e: 10,
      f: -5,
    });

    expect(transformed.segments).toEqual([
      { kind: "move", to: { x: 12, y: 1 } },
      {
        control1: { x: 16, y: 7 },
        control2: { x: 20, y: 13 },
        kind: "cubic",
        to: { x: 24, y: 19 },
      },
    ]);
  });

  it("classifies paths for exporter capability decisions", () => {
    expect(classifyDiagramPath(parseSvgPathData("M0 0 L20 0"))).toBe("straight");
    expect(classifyDiagramPath(parseSvgPathData("M0 0 H20 V30"))).toBe("orthogonal");
    expect(classifyDiagramPath(parseSvgPathData("M0 0 L20 10 L30 30"))).toBe("polyline");
    expect(classifyDiagramPath(parseSvgPathData("M0 0 C10 0 20 30 30 30"))).toBe("curved");
    expect(classifyDiagramPath(parseSvgPathData("M0 0 C10 0 20 30 30 30 L40 30")))
      .toBe("complex");
  });

  it("stores complete canonical path and stroke metadata on parsed edges", () => {
    const result = parseMermaidSvg(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="10 0 100 80">
        <path id="L_A_B_0" class="flowchart-link"
          transform="translate(5 5)"
          d="M10 10 C20 0 30 20 40 10 S60 20 70 10"
          stroke="#123456" stroke-width="2" stroke-dasharray="6 3"
          stroke-dashoffset="2" stroke-linecap="round" fill="none" />
      </svg>
    `);

    expect(result.data.schemaVersion).toBe("1.0");
    expect(result.data.edges[0]).toMatchObject({
      id: "L_A_B_0",
      path: {
        segments: [
          { kind: "move", to: { x: 5, y: 15 } },
          {
            control1: { x: 15, y: 5 },
            control2: { x: 25, y: 25 },
            kind: "cubic",
            to: { x: 35, y: 15 },
          },
          {
            control1: { x: 45, y: 5 },
            control2: { x: 55, y: 25 },
            kind: "cubic",
            to: { x: 65, y: 15 },
          },
        ],
      },
      stroke: {
        color: "123456",
        dashArray: [6, 3],
        dashOffset: 2,
        lineCap: "round",
        width: 2,
      },
    });
  });

  it("recovers stable Mermaid node IDs and edge terminals with renderer prefixes", () => {
    const result = parseMermaidSvg(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 80"
        class="flowchart" aria-roledescription="flowchart-v2">
        <g class="node" id="preview-flowchart-node_with_part-0" transform="translate(40 40)">
          <rect x="-30" y="-20" width="60" height="40" />
        </g>
        <g class="node" id="preview-flowchart-target-1" transform="translate(200 40)">
          <rect x="-30" y="-20" width="60" height="40" />
        </g>
        <path id="preview-L-node_with_part-target-0" data-id="L_node_with_part_target_0"
          class="flowchart-link" d="M70 40 L170 40" />
      </svg>
    `);

    expect(result.data.nodes.map(({ semanticId }) => semanticId)).toEqual([
      "node_with_part",
      "target",
    ]);
    expect(result.data.edges[0]).toMatchObject({
      sourceId: "node_with_part",
      targetId: "target",
    });
    expect(result.data.source).toEqual({ diagramType: "flowchart", kind: "mermaid" });
  });

  it("diagnoses affine arc transforms that cannot be represented exactly", () => {
    const result = parseMermaidSvg(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 80">
        <path id="skewed-arc" class="flowchart-link"
          transform="skewX(20)" d="M10 40 A40 20 0 0 1 100 40" />
      </svg>
    `);

    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "EDGE_ARC_TRANSFORM_APPROXIMATED",
      elementId: "skewed-arc",
      severity: "warning",
    }));
  });

  it("infers a missing terminal when SVG exposes only one endpoint attribute", () => {
    const result = parseMermaidSvg(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 220 80">
        <g class="node" id="flowchart-A-0"><rect x="0" y="20" width="60" height="40" /></g>
        <g class="node" id="flowchart-B-1"><rect x="160" y="20" width="60" height="40" /></g>
        <path class="flowchart-link" data-source="A" d="M60 40 L160 40" />
      </svg>
    `);

    expect(result.data.edges[0]).toMatchObject({ sourceId: "A", targetId: "B" });
  });
});
