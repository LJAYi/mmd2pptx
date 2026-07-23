import { DOMParser } from "@xmldom/xmldom";
import { describe, expect, it } from "vitest";

import { exportDiagramToDrawio } from "../../src/exporters/drawio.js";
import type { ExportDiagram } from "../../src/exporters/model.js";
import { exportDiagramToSvg } from "../../src/exporters/svg.js";

const DIAGRAM: ExportDiagram = {
  backgroundColor: "f8fafc",
  width: 360,
  height: 180,
  nodes: [
    {
      id: "source & one",
      kind: "roundRect",
      bounds: { x: 20, y: 50, width: 110, height: 60 },
      fill: "eef4f7",
      stroke: "24323d",
      strokeWidth: 1.5,
      text: {
        text: "Start <safe>",
        bounds: { x: 30, y: 60, width: 90, height: 40 },
        color: "24323d",
        fontFamily: "Arial",
        fontSize: 14,
      },
    },
    {
      id: "target/two",
      kind: "diamond",
      bounds: { x: 250, y: 45, width: 90, height: 70 },
      fill: "faf0e6",
      stroke: "24323d",
      text: {
        text: "Finish",
        bounds: { x: 260, y: 55, width: 70, height: 50 },
      },
    },
  ],
  edges: [
    {
      id: "edge A→B",
      sourceId: "source & one",
      targetId: "target/two",
      start: { x: 130, y: 80 },
      end: { x: 250, y: 80 },
      points: [
        { x: 130, y: 80 },
        { x: 190, y: 80 },
        { x: 190, y: 120 },
        { x: 250, y: 80 },
      ],
      color: "24323d",
      dash: "dash",
      endArrow: "triangle",
      strokeWidth: 2,
      label: {
        text: "Yes & go",
        bounds: { x: 175, y: 85, width: 55, height: 20 },
      },
    },
  ],
};

describe("exportDiagramToSvg", () => {
  it("writes deterministic standalone geometry with stable IDs and inline styles", () => {
    const first = exportDiagramToSvg(DIAGRAM, { title: "Forward export" });
    const second = exportDiagramToSvg(DIAGRAM, { title: "Forward export" });

    expect(first).toBe(second);
    expect(first).toContain('data-source-id="source &amp; one"');
    expect(first).toContain('style="fill:#eef4f7;stroke:#24323d;stroke-width:1.5"');
    expect(first).toContain('points="130,80 190,80 190,120 250,80"');
    expect(first).toContain("stroke-dasharray:8 5");
    expect(first).toContain("Start &lt;safe&gt;");

    const document = new DOMParser().parseFromString(first, "image/svg+xml");
    expect(document.documentElement.tagName).toBe("svg");
    expect(document.getElementsByTagName("parsererror")).toHaveLength(0);
    expect(document.getElementsByTagName("polyline")).toHaveLength(1);
    expect(document.getElementsByTagName("marker")).toHaveLength(1);
  });

  it("rejects non-finite geometry rather than emitting invalid XML", () => {
    expect(() => exportDiagramToSvg({ ...DIAGRAM, width: Number.NaN })).toThrow(
      /positive finite/,
    );
  });

  it("preserves canonical cubic paths and structured stroke style", () => {
    const curved: ExportDiagram = {
      ...DIAGRAM,
      edges: [{
        ...DIAGRAM.edges[0]!,
        path: { segments: [
          { kind: "move", to: { x: 130, y: 80 } },
          {
            kind: "cubic",
            control1: { x: 165, y: 25 },
            control2: { x: 215, y: 135 },
            to: { x: 250, y: 80 },
          },
        ] },
        stroke: {
          color: "#a21caf",
          dashArray: [3, 2],
          lineCap: "square",
          lineJoin: "bevel",
          opacity: 0.75,
          width: 2.5,
        },
      }],
    };
    const output = exportDiagramToSvg(curved);

    expect(output).toContain('d="M 130,80 C 165,25 215,135 250,80"');
    expect(output).toContain("stroke:#a21caf;stroke-width:2.5");
    expect(output).toContain("stroke-linecap:square;stroke-linejoin:bevel");
    expect(output).toContain('data-source-id="edge A→B" opacity="0.75"');
    expect(output).toContain("stroke-dasharray:3 2");
  });
});

describe("exportDiagramToDrawio", () => {
  it("writes vertices, connected edges, waypoints, geometry, and basic styles", () => {
    const output = exportDiagramToDrawio(DIAGRAM, { pageName: "Demo & QA" });
    const document = new DOMParser().parseFromString(output, "application/xml");

    expect(document.getElementsByTagName("parsererror")).toHaveLength(0);
    expect(document.documentElement.tagName).toBe("mxfile");
    const cells = Array.from(document.getElementsByTagName("mxCell"));
    const vertices = cells.filter((cell) => cell.getAttribute("vertex") === "1"
      && !cell.hasAttribute("data-label-for"));
    const edge = cells.find((cell) => cell.getAttribute("edge") === "1");
    expect(vertices).toHaveLength(2);
    expect(edge?.getAttribute("source")).toMatch(/^node-/);
    expect(edge?.getAttribute("target")).toMatch(/^node-/);
    expect(edge?.getAttribute("style")).toContain("edgeStyle=none");
    expect(edge?.getAttribute("style")).toContain("endArrow=block");
    expect(edge?.getAttribute("style")).toContain("dashed=1");
    const edgeLabel = cells.find((cell) => cell.getAttribute("data-label-for") === "edge A→B");
    expect(edge?.getAttribute("value")).toBe("");
    expect(edgeLabel?.getAttribute("value")).toBe("Yes &amp; go");
    expect(edge?.getElementsByTagName("Array")[0]?.getAttribute("as")).toBe("points");
    expect(edge?.getElementsByTagName("Array")[0]?.getElementsByTagName("mxPoint")).toHaveLength(2);
  });

  it("uses orthogonal routing only when every waypoint segment is orthogonal", () => {
    const orthogonal: ExportDiagram = {
      ...DIAGRAM,
      edges: [{
        ...DIAGRAM.edges[0]!,
        points: [
          { x: 130, y: 80 },
          { x: 190, y: 80 },
          { x: 190, y: 120 },
          { x: 250, y: 120 },
        ],
        end: { x: 250, y: 120 },
      }],
    };
    const document = new DOMParser().parseFromString(
      exportDiagramToDrawio(orthogonal),
      "application/xml",
    );
    const edge = Array.from(document.getElementsByTagName("mxCell"))
      .find((cell) => cell.getAttribute("edge") === "1");
    expect(edge?.getAttribute("style")).toContain("edgeStyle=orthogonalEdgeStyle");
  });

  it("resolves edge terminals through semantic IDs and stable source keys", () => {
    const aliases: ExportDiagram = {
      ...DIAGRAM,
      nodes: [
        { ...DIAGRAM.nodes[0]!, semanticId: "start" },
        { ...DIAGRAM.nodes[1]!, sourceKey: "flowchart:finish" },
      ],
      edges: [{
        ...DIAGRAM.edges[0]!,
        sourceId: "start",
        targetId: "flowchart:finish",
      }],
    };
    const document = new DOMParser().parseFromString(
      exportDiagramToDrawio(aliases),
      "application/xml",
    );
    const edge = Array.from(document.getElementsByTagName("mxCell"))
      .find((cell) => cell.getAttribute("edge") === "1");
    expect(edge?.getAttribute("source")).toMatch(/^node-/);
    expect(edge?.getAttribute("target")).toMatch(/^node-/);
  });

  it("infers terminal ownership from endpoints for today's DiagramIR shape", () => {
    const withoutOwnership: ExportDiagram = {
      ...DIAGRAM,
      edges: DIAGRAM.edges.map(({ sourceId: _source, targetId: _target, ...edge }) => edge),
    };
    const output = exportDiagramToDrawio(withoutOwnership);
    const document = new DOMParser().parseFromString(output, "application/xml");
    const edge = Array.from(document.getElementsByTagName("mxCell"))
      .find((cell) => cell.getAttribute("edge") === "1");

    expect(edge?.getAttribute("source")).toMatch(/^node-/);
    expect(edge?.getAttribute("target")).toMatch(/^node-/);
  });

  it("keeps unattached endpoints as explicit draw.io geometry", () => {
    const output = exportDiagramToDrawio(DIAGRAM, { inferConnections: false });
    const document = new DOMParser().parseFromString(output, "application/xml");
    const edge = Array.from(document.getElementsByTagName("mxCell"))
      .find((cell) => cell.getAttribute("edge") === "1");

    // Explicit sourceId/targetId remain authoritative even if inference is off.
    expect(edge?.hasAttribute("source")).toBe(true);
    expect(edge?.hasAttribute("target")).toBe(true);

    const detached: ExportDiagram = {
      ...DIAGRAM,
      edges: DIAGRAM.edges.map(({ sourceId: _source, targetId: _target, ...edgeValue }) => edgeValue),
    };
    const detachedOutput = exportDiagramToDrawio(detached, { inferConnections: false });
    const detachedDocument = new DOMParser().parseFromString(detachedOutput, "application/xml");
    const detachedEdge = Array.from(detachedDocument.getElementsByTagName("mxCell"))
      .find((cell) => cell.getAttribute("edge") === "1");
    expect(detachedEdge?.hasAttribute("source")).toBe(false);
    expect(detachedEdge?.hasAttribute("target")).toBe(false);
    expect(detachedEdge?.getElementsByTagName("mxPoint")).toHaveLength(4);
  });
});
