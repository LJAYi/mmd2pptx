import { DOMParser } from "@xmldom/xmldom";
import JSZip from "jszip";
import PptxGenJS from "pptxgenjs";

import { normalizeFontFamily } from "./normalize-font-family.js";
import { parseMermaidSvg } from "./parse-svg.js";
import type {
  ConversionDiagnostic,
  ConversionOptions,
  ConversionResult,
  ConversionSummary,
  DiagramIR,
  DiagramNodeKind,
} from "./types.js";

const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

export async function diagramToPptxBuffer(
  diagram: DiagramIR,
  options: ConversionOptions = {},
): Promise<ConversionResult<Uint8Array>> {
  const diagnostics: ConversionDiagnostic[] = [];
  const summary = summaryFor(diagram);
  if (!isFiniteDiagram(diagram)) {
    return {
      data: new Uint8Array(),
      diagnostics: [{
        code: "DIAGRAM_DIMENSIONS_INVALID",
        message: "Diagram dimensions must be finite positive numbers.",
        severity: "error",
      }],
      summary,
    };
  }

  const pptx = new PptxGenJS();
  const wide = (options.layout ?? "wide") === "wide";
  pptx.layout = wide ? "LAYOUT_WIDE" : "LAYOUT_4x3";
  pptx.author = "mmd2pptx contributors";
  pptx.company = "mmd2pptx";
  pptx.subject = "Editable diagram generated from Mermaid SVG";
  pptx.title = options.title ?? "Mermaid diagram";

  const slide = pptx.addSlide();
  slide.background = { color: normalizePptxColor(options.backgroundColor) ?? "FFFFFF" };

  const slideWidth = wide ? 13.333 : 10;
  const slideHeight = 7.5;
  const paddingIn = Math.max(0, options.padding ?? 24) / 96;
  const scale = Math.min(
    (slideWidth - paddingIn * 2) / diagram.width,
    (slideHeight - paddingIn * 2) / diagram.height,
  );
  const contentWidth = diagram.width * scale;
  const contentHeight = diagram.height * scale;
  const offsetX = (slideWidth - contentWidth) / 2;
  const offsetY = (slideHeight - contentHeight) / 2;

  for (const edge of diagram.edges) {
    const startX = offsetX + edge.start.x * scale;
    const startY = offsetY + edge.start.y * scale;
    const endX = offsetX + edge.end.x * scale;
    const endY = offsetY + edge.end.y * scale;
    slide.addShape(pptx.ShapeType.line, {
      x: Math.min(startX, endX),
      y: Math.min(startY, endY),
      w: Math.max(Math.abs(endX - startX), 0.001),
      h: Math.max(Math.abs(endY - startY), 0.001),
      flipH: endX < startX,
      flipV: endY < startY,
      line: {
        color: normalizePptxColor(edge.color) ?? "333333",
        endArrowType: "triangle",
        width: Math.max(edge.strokeWidth ?? 1.5, 0.5),
      },
    });
  }

  for (const node of diagram.nodes) {
    const bounds = node.bounds;
    const x = offsetX + bounds.x * scale;
    const y = offsetY + bounds.y * scale;
    const w = Math.max(bounds.width * scale, 0.02);
    const h = Math.max(bounds.height * scale, 0.02);
    const shape = shapeType(pptx, node.kind);
    const line = {
      color: normalizePptxColor(node.stroke) ?? "333333",
      width: Math.max(node.strokeWidth ?? 1.25, 0.5),
    };
    const fill = { color: normalizePptxColor(node.fill) ?? "FFFFFF" };

    if (node.text?.text) {
      slide.addText(node.text.text, {
        x,
        y,
        w,
        h,
        shape,
        fill,
        line,
        align: "center",
        valign: "middle",
        fit: "shrink",
        margin: 0.04,
        breakLine: false,
        color: normalizePptxColor(node.text.color) ?? "202830",
        fontFace: normalizeFontFamily(options.fontFamily ?? node.text.fontFamily) ?? "Arial",
        fontSize: Math.max(((node.text.fontSize ?? 16) * 72) / 96, 6),
      });
    } else {
      slide.addShape(shape, { x, y, w, h, fill, line });
    }
  }

  const raw = await pptx.write({ outputType: "arraybuffer", compression: true });
  const data = toUint8Array(raw);
  diagnostics.push(...await validatePowerPointXml(data));
  return { data, diagnostics, summary };
}

export async function diagramToPptxBlob(
  diagram: DiagramIR,
  options: ConversionOptions = {},
): Promise<ConversionResult<Blob>> {
  const result = await diagramToPptxBuffer(diagram, options);
  return {
    data: new Blob([
      result.data.buffer.slice(
        result.data.byteOffset,
        result.data.byteOffset + result.data.byteLength,
      ) as ArrayBuffer,
    ], { type: PPTX_MIME }),
    diagnostics: result.diagnostics,
    summary: result.summary,
  };
}

export async function svgStringToPptxBuffer(
  svg: string,
  options: ConversionOptions = {},
): Promise<ConversionResult<Uint8Array>> {
  const parsed = parseMermaidSvg(svg);
  if (parsed.diagnostics.some(({ severity }) => severity === "error")) {
    return {
      data: new Uint8Array(),
      diagnostics: parsed.diagnostics,
      summary: parsed.summary,
    };
  }
  const generated = await diagramToPptxBuffer(parsed.data, options);
  return {
    data: generated.data,
    diagnostics: [...parsed.diagnostics, ...generated.diagnostics],
    summary: generated.summary,
  };
}

async function validatePowerPointXml(data: Uint8Array): Promise<ConversionDiagnostic[]> {
  try {
    const zip = await JSZip.loadAsync(data);
    const slides = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
    if (slides.length === 0) {
      return [{
        code: "PPTX_SLIDE_MISSING",
        message: "Generated PowerPoint package contains no slide XML.",
        severity: "error",
      }];
    }

    for (const name of slides) {
      const xml = await zip.file(name)?.async("string");
      if (!xml) {
        return [{
          code: "PPTX_SLIDE_EMPTY",
          message: `${name} is empty.`,
          severity: "error",
        }];
      }
      const errors: string[] = [];
      new DOMParser({
        errorHandler: {
          error: (message) => errors.push(String(message)),
          fatalError: (message) => errors.push(String(message)),
          warning: () => undefined,
        },
      }).parseFromString(xml, "application/xml");
      if (errors.length > 0) {
        return [{
          code: "PPTX_XML_INVALID",
          message: `${name} is not well-formed XML: ${errors[0]}`,
          severity: "error",
        }];
      }
    }
    return [];
  } catch (error) {
    return [{
      code: "PPTX_PACKAGE_INVALID",
      message: error instanceof Error ? error.message : String(error),
      severity: "error",
    }];
  }
}

function shapeType(pptx: PptxGenJS, kind: DiagramNodeKind) {
  switch (kind) {
    case "roundRect":
      return pptx.ShapeType.roundRect;
    case "ellipse":
      return pptx.ShapeType.ellipse;
    case "diamond":
      return pptx.ShapeType.diamond;
    case "hexagon":
      return pptx.ShapeType.hexagon;
    case "rect":
    default:
      return pptx.ShapeType.rect;
  }
}

function normalizePptxColor(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().replace(/^#/, "");
  return /^[0-9a-f]{6}$/i.test(normalized) ? normalized.toUpperCase() : undefined;
}

function toUint8Array(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
    return new Uint8Array(value);
  }
  throw new TypeError("PptxGenJS returned an unsupported output type.");
}

function isFiniteDiagram(diagram: DiagramIR): boolean {
  return Number.isFinite(diagram.width) && diagram.width > 0 &&
    Number.isFinite(diagram.height) && diagram.height > 0;
}

function summaryFor(diagram: DiagramIR): ConversionSummary {
  return {
    editableObjects: diagram.nodes.length + diagram.edges.length,
    edges: diagram.edges.length,
    fallbackObjects: 0,
    nodes: diagram.nodes.length,
  };
}
