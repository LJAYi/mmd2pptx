import JSZip from "jszip";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  diagramToPptxBuffer,
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
const FAITHFUL_EDGES = readFileSync(
  new URL("./fixtures/faithful-edges.svg", import.meta.url),
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
    expect(result.summary).toMatchObject({ nodes: 3, edges: 2, editableObjects: 7 });
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

  it("emits one native connector per smart edge", async () => {
    const result = await svgStringToPptxBuffer(EDGE_FIDELITY);
    expect(result.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
    expect(result.summary.editableObjects).toBe(7);

    const zip = await JSZip.loadAsync(result.data);
    const slideXml = await zip.file("ppt/slides/slide1.xml")?.async("string");
    expect(slideXml).toBeTruthy();
    expect(slideXml?.match(/<p:cxnSp(?:\s|>)/g)).toHaveLength(2);
    expect(slideXml?.match(/<p:sp(?:\s|>)/g)).toHaveLength(5);
    expect(slideXml).toContain(">e1</a:t>");
    expect(slideXml).toContain(">e2</a:t>");
    expect(slideXml).toContain('type="triangle"');
    expect(slideXml).toContain('type="diamond"');
    expect(slideXml).toContain('type="oval"');
  });

  it("binds smart connector endpoints to named node shapes", async () => {
    const result = await diagramToPptxBuffer({
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
      nodes: [{
        bounds: { height: 60, width: 60, x: 20, y: 30 },
        id: "A",
        kind: "rect",
      }, {
        bounds: { height: 60, width: 60, x: 220, y: 30 },
        id: "B",
        kind: "rect",
      }],
      width: 300,
    }, { mode: "smart" });
    expect(result.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
    expect(result.summary).toMatchObject({ editableObjects: 3, fallbackObjects: 0 });

    const zip = await JSZip.loadAsync(result.data);
    const slideXml = await zip.file("ppt/slides/slide1.xml")?.async("string");
    expect(slideXml?.match(/<p:cxnSp(?:\s|>)/g)).toHaveLength(1);
    expect(slideXml).toContain("<p:cNvCxnSpPr>");
    expect(slideXml).toContain('<a:prstGeom prst="straightConnector1">');
    expect(slideXml?.match(/<a:stCxn id="\d+" idx="\d+"\/>/g)).toHaveLength(1);
    expect(slideXml?.match(/<a:endCxn id="\d+" idx="\d+"\/>/g)).toHaveLength(1);
    expect(slideXml).toContain('name="mmd2pptx-node:A"');
    expect(slideXml).toContain('name="mmd2pptx-node:B"');
    const sourceNodeId = /<p:cNvPr id="(\d+)" name="mmd2pptx-node:A"/.exec(slideXml ?? "")?.[1];
    const targetNodeId = /<p:cNvPr id="(\d+)" name="mmd2pptx-node:B"/.exec(slideXml ?? "")?.[1];
    expect(sourceNodeId).toBeTruthy();
    expect(targetNodeId).toBeTruthy();
    expect(slideXml).toContain(`<a:stCxn id="${sourceNodeId}"`);
    expect(slideXml).toContain(`<a:endCxn id="${targetNodeId}"`);
  });

  it("warns when a requested smart endpoint cannot be bound", async () => {
    const result = await diagramToPptxBuffer({
      edges: [{
        end: { x: 220, y: 60 },
        id: "missing-to-B",
        path: { segments: [
          { kind: "move", to: { x: 80, y: 60 } },
          { kind: "line", to: { x: 220, y: 60 } },
        ] },
        sourceId: "missing-node",
        start: { x: 80, y: 60 },
        targetId: "B",
      }],
      height: 120,
      nodes: [{
        bounds: { height: 60, width: 60, x: 220, y: 30 },
        id: "B",
        kind: "rect",
      }],
      width: 300,
    }, { mode: "smart" });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "PPTX_SMART_ENDPOINT_UNBOUND",
      elementId: "missing-to-B",
      severity: "warning",
    }));
    expect(result.summary.fallbackObjects).toBe(1);
    const zip = await JSZip.loadAsync(result.data);
    const slideXml = await zip.file("ppt/slides/slide1.xml")?.async("string");
    expect(slideXml?.match(/<p:cxnSp(?:\s|>)/g)).toHaveLength(1);
    expect(slideXml).not.toContain("<a:stCxn");
    expect(slideXml).toContain("<a:endCxn");
  });

  it("embeds exact mode as one SVG vector picture", async () => {
    const result = await svgStringToPptxBuffer(SIMPLE_FLOW, { mode: "exact" });
    expect(result.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
    expect(result.summary).toMatchObject({
      editableObjects: 0,
      edges: 1,
      fallbackObjects: 0,
      nodes: 2,
    });

    const zip = await JSZip.loadAsync(result.data);
    const slideXml = await zip.file("ppt/slides/slide1.xml")?.async("string");
    expect(slideXml?.match(/<p:pic(?:\s|>)/g)).toHaveLength(1);
    expect(slideXml).not.toContain("<p:cxnSp>");
    expect(slideXml).not.toContain("<p:sp>");
    expect(slideXml).toContain("<asvg:svgBlip");
    const svgMedia = Object.keys(zip.files).filter((name) => name.endsWith(".svg"));
    expect(svgMedia).toHaveLength(1);
    expect(await zip.file(svgMedia[0]!)?.async("string")).toContain("flowchart-A-0");
  });

  it("removes active content and external references from exact SVG media", async () => {
    const unsafeSvg = `
      <svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
        viewBox="0 0 100 100" onload="alert(1)">
        <script>alert(1)</script>
        <style>@import url(https://example.test/x.css); .x { fill: url(https://example.test/x); }</style>
        <image href="https://example.test/pixel.png" x="0" y="0" width="10" height="10" />
        <a xlink:href="javascript:alert(1)"><rect class="x" width="100" height="100"
          fill="url(https://example.test/fill.svg#paint)"
          filter="url(https://example.test/filter.svg#fx)" /></a>
      </svg>
    `;
    const result = await svgStringToPptxBuffer(unsafeSvg, { mode: "exact" });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "PPTX_EXACT_ACTIVE_CONTENT_REMOVED",
      severity: "warning",
    }));
    const zip = await JSZip.loadAsync(result.data);
    const mediaName = Object.keys(zip.files).find((name) => name.endsWith(".svg"));
    const embedded = mediaName ? await zip.file(mediaName)?.async("string") : undefined;
    expect(embedded).not.toMatch(/<script|onload=|https:\/\/|javascript:|@import/i);
  });

  it("uses normalized IR SVG when diagram exact mode has no source SVG", async () => {
    const parsed = parseMermaidSvg(SIMPLE_FLOW);
    const result = await diagramToPptxBuffer(parsed.data, { mode: "exact" });
    expect(result.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
    expect(result.summary.editableObjects).toBe(0);
    const zip = await JSZip.loadAsync(result.data);
    const svgMedia = Object.keys(zip.files).find((name) => name.endsWith(".svg"));
    const svg = svgMedia ? await zip.file(svgMedia)?.async("string") : undefined;
    expect(svg).toContain('id="diagram-objects"');
    expect(svg).toContain('data-source-id="flowchart-A-0"');
    expect(svg).toContain('data-source-id="L_A_B_0"');
  });

  it("requires exact mode for non-flowchart Mermaid diagram types", async () => {
    const sequenceSvg = `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"
        class="sequence" aria-roledescription="sequence">
        <rect x="10" y="10" width="180" height="80" fill="#fff" />
      </svg>
    `;
    const smart = await svgStringToPptxBuffer(sequenceSvg, { mode: "smart" });
    expect(smart.data).toHaveLength(0);
    expect(smart.diagnostics).toContainEqual(expect.objectContaining({
      code: "PPTX_MODE_UNSUPPORTED_FOR_DIAGRAM_TYPE",
      severity: "error",
    }));

    const exact = await svgStringToPptxBuffer(sequenceSvg, { mode: "exact" });
    expect(exact.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
    expect(exact.data.byteLength).toBeGreaterThan(10_000);
  });

  it("falls from smart connector to faithful freeform, then SVG when required", async () => {
    const result = await diagramToPptxBuffer({
      edges: [{
        end: { x: 180, y: 80 },
        id: "complex-freeform",
        path: { segments: [
          { kind: "move", to: { x: 20, y: 80 } },
          { kind: "line", to: { x: 70, y: 40 } },
          { control: { x: 120, y: 10 }, kind: "quadratic", to: { x: 180, y: 80 } },
        ] },
        start: { x: 20, y: 80 },
      }, {
        end: { x: 180, y: 120 },
        id: "closed-svg",
        path: { segments: [
          { kind: "move", to: { x: 20, y: 120 } },
          { kind: "line", to: { x: 180, y: 120 } },
          { kind: "close" },
        ] },
        start: { x: 20, y: 120 },
      }],
      height: 160,
      nodes: [],
      width: 200,
    }, { mode: "smart" });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "PPTX_SMART_EDGE_FREEFORM_FALLBACK",
      elementId: "complex-freeform",
    }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "PPTX_SMART_EDGE_SVG_FALLBACK",
      elementId: "closed-svg",
    }));
    expect(result.summary).toMatchObject({ editableObjects: 1, fallbackObjects: 2 });
    const zip = await JSZip.loadAsync(result.data);
    const slideXml = await zip.file("ppt/slides/slide1.xml")?.async("string");
    expect(slideXml?.match(/<a:custGeom>/g)).toHaveLength(1);
    expect(slideXml?.match(/<p:pic(?:\s|>)/g)).toHaveLength(1);
  });

  it("emits one open custom-geometry object per edge in faithful mode", async () => {
    const result = await svgStringToPptxBuffer(EDGE_FIDELITY, { mode: "faithful" });
    expect(result.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
    expect(result.summary).toMatchObject({ editableObjects: 7, fallbackObjects: 0 });

    const zip = await JSZip.loadAsync(result.data);
    const slideXml = await zip.file("ppt/slides/slide1.xml")?.async("string");
    expect(slideXml?.match(/<p:sp(?:\s|>)/g)).toHaveLength(7);
    expect(slideXml?.match(/<a:custGeom>/g)).toHaveLength(2);
    expect(slideXml?.match(/<a:prstDash val="dash"\/>/g)).toHaveLength(1);
    expect(slideXml?.match(/<a:prstDash val="sysDot"\/>/g)).toHaveLength(1);
    expect(slideXml).toContain('<a:tailEnd type="triangle"/>');
    expect(slideXml).toContain('<a:headEnd type="oval"/>');
    expect(slideXml).toContain('<a:tailEnd type="diamond"/>');
  });

  it("uses a bound native connector only for geometry-safe faithful straight edges", async () => {
    const result = await diagramToPptxBuffer({
      edges: [{
        dash: "dash",
        end: { x: 220, y: 60 },
        endArrow: "triangle",
        id: "faithful-straight",
        path: { segments: [
          { kind: "move", to: { x: 80, y: 60 } },
          { kind: "line", to: { x: 220, y: 60 } },
        ] },
        sourceId: "A",
        start: { x: 80, y: 60 },
        targetId: "B",
      }, {
        end: { x: 220, y: 130 },
        id: "faithful-curve",
        path: { segments: [
          { kind: "move", to: { x: 80, y: 130 } },
          {
            control1: { x: 120, y: 80 },
            control2: { x: 180, y: 180 },
            kind: "cubic",
            to: { x: 220, y: 130 },
          },
        ] },
        start: { x: 80, y: 130 },
      }],
      height: 180,
      nodes: [{
        bounds: { height: 60, width: 60, x: 20, y: 30 },
        id: "A",
        kind: "rect",
      }, {
        bounds: { height: 60, width: 60, x: 220, y: 30 },
        id: "B",
        kind: "rect",
      }],
      width: 300,
    }, { mode: "faithful" });
    expect(result.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
    expect(result.summary).toMatchObject({ editableObjects: 4, fallbackObjects: 0 });
    const zip = await JSZip.loadAsync(result.data);
    const slideXml = await zip.file("ppt/slides/slide1.xml")?.async("string");
    expect(slideXml?.match(/<p:cxnSp(?:\s|>)/g)).toHaveLength(1);
    expect(slideXml?.match(/<a:custGeom>/g)).toHaveLength(1);
    expect(slideXml).toContain('<a:prstGeom prst="straightConnector1">');
    expect(slideXml?.match(/<a:stCxn id="\d+" idx="\d+"\/>/g)).toHaveLength(1);
    expect(slideXml?.match(/<a:endCxn id="\d+" idx="\d+"\/>/g)).toHaveLength(1);
    expect(slideXml?.match(/<a:prstDash val="dash"\/>/g)).toHaveLength(1);
    expect(slideXml?.match(/<a:tailEnd type="triangle"\/>/g)).toHaveLength(1);
    expect(slideXml?.match(/<a:cubicBezTo>/g)).toHaveLength(1);
  });

  it("preserves every canonical curve command in one faithful freeform", async () => {
    const result = await svgStringToPptxBuffer(FAITHFUL_EDGES, { mode: "faithful" });
    expect(result.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
    expect(result.diagnostics).not.toContainEqual(expect.objectContaining({
      code: "PPTX_FAITHFUL_EDGE_FALLBACK",
    }));
    expect(result.summary).toMatchObject({ editableObjects: 1, fallbackObjects: 0 });

    const zip = await JSZip.loadAsync(result.data);
    const slideXml = await zip.file("ppt/slides/slide1.xml")?.async("string");
    expect(slideXml?.match(/<p:sp(?:\s|>)/g)).toHaveLength(1);
    expect(slideXml?.match(/<a:custGeom>/g)).toHaveLength(1);
    expect(slideXml).toContain("<a:lnTo>");
    expect(slideXml).toContain("<a:cubicBezTo>");
    expect(slideXml).toContain("<a:quadBezTo>");
    expect(slideXml).toContain("<a:arcTo");
    expect(slideXml).not.toContain("<a:close/>");
    expect(slideXml?.match(/<a:prstDash val="dash"\/>/g)).toHaveLength(1);
    expect(slideXml?.match(/<a:tailEnd type="arrow"\/>/g)).toHaveLength(1);
  });

  it("keeps a legacy points-only edge as one faithful open polyline", async () => {
    const result = await diagramToPptxBuffer({
      edges: [{
        color: "345678",
        dash: "dash",
        end: { x: 180, y: 80 },
        endArrow: "triangle",
        id: "legacy-polyline",
        points: [
          { x: 20, y: 20 },
          { x: 80, y: 20 },
          { x: 80, y: 80 },
          { x: 180, y: 80 },
        ],
        start: { x: 20, y: 20 },
      }],
      height: 100,
      nodes: [],
      width: 200,
    }, { mode: "faithful" });
    expect(result.diagnostics).toEqual([]);
    expect(result.summary).toMatchObject({ editableObjects: 1, fallbackObjects: 0 });

    const zip = await JSZip.loadAsync(result.data);
    const slideXml = await zip.file("ppt/slides/slide1.xml")?.async("string");
    expect(slideXml?.match(/<a:custGeom>/g)).toHaveLength(1);
    expect(slideXml?.match(/<a:lnTo>/g)).toHaveLength(3);
    expect(slideXml?.match(/<a:prstDash val="dash"\/>/g)).toHaveLength(1);
  });

  it("uses one SVG object when faithful geometry cannot stay editable", async () => {
    const result = await diagramToPptxBuffer({
      edges: [{
        end: { x: 160, y: 60 },
        id: "rotated-arc",
        path: { segments: [
          { kind: "move", to: { x: 20, y: 60 } },
          {
            kind: "arc",
            largeArc: false,
            radiusX: 80,
            radiusY: 30,
            rotation: 30,
            sweep: true,
            to: { x: 160, y: 60 },
          },
        ] },
        start: { x: 20, y: 60 },
      }],
      height: 100,
      nodes: [],
      width: 180,
    }, { mode: "faithful" });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "PPTX_FAITHFUL_EDGE_SVG_FALLBACK",
      elementId: "rotated-arc",
      severity: "warning",
    }));
    expect(result.summary).toMatchObject({ editableObjects: 0, fallbackObjects: 1 });

    const zip = await JSZip.loadAsync(result.data);
    const slideXml = await zip.file("ppt/slides/slide1.xml")?.async("string");
    expect(slideXml).not.toContain("<a:custGeom>");
    expect(slideXml?.match(/<p:pic(?:\s|>)/g)).toHaveLength(1);
  });
});
