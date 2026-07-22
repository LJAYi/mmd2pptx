import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import JSZip from "jszip";
import PptxGenJS from "pptxgenjs";

import { classifyDiagramPath } from "./diagram-ir/classify.js";
import { exportDiagramToSvg } from "./exporters/svg.js";
import { normalizeFontFamily } from "./normalize-font-family.js";
import { parseMermaidSvg } from "./parse-svg.js";
import { patchNativeConnectors } from "./pptx-connector-patch.js";
import type { NativeConnectorPatch } from "./pptx-connector-patch.js";
import { analyzeDiagramCollisions, routeOrthogonal } from "./routing/index.js";
import { effectiveDashKind } from "./stroke-style.js";
import type {
  ConversionDiagnostic,
  ConversionOptions,
  ConversionResult,
  ConversionSummary,
  DiagramIR,
  DiagramArrowKind,
  DiagramEdge,
  DiagramGroup,
  DiagramLineDash,
  DiagramNode,
  DiagramNodeKind,
  DiagramPathSegment,
  DiagramText,
  Point,
} from "./types.js";

const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const CUSTOM_GEOMETRY = "custGeom" as unknown as PptxGenJS.ShapeType;
const STRAIGHT_CONNECTOR = "straightConnector1" as unknown as PptxGenJS.ShapeType;
const ELBOW_CONNECTOR = "bentConnector3" as unknown as PptxGenJS.ShapeType;
const CURVED_CONNECTOR = "curvedConnector3" as unknown as PptxGenJS.ShapeType;

type CustomGeometryPoint = NonNullable<PptxGenJS.ShapeProps["points"]>[number];

/** Inspect the PPTX mode without building a ZIP package. */
export function preflightDiagramToPptx(
  diagram: DiagramIR,
  options: ConversionOptions = {},
): ConversionResult<null> {
  const mode = options.mode ?? "smart";
  let summary = summaryFor(diagram, mode);
  const inputDiagnostics = validatePptxInput(diagram, options);
  if (inputDiagnostics.length > 0) {
    return {
      data: null,
      diagnostics: inputDiagnostics,
      summary,
    };
  }
  if (mode === "exact") {
    return {
      data: null,
      diagnostics: [{
        code: "PPTX_EXACT_SVG_EMBEDDED",
        message: "Exact mode embeds the diagram as one vector SVG object; internal nodes and edges are not editable PowerPoint objects.",
        severity: "info",
      }],
      summary,
    };
  }
  const diagramType = diagram.source?.diagramType;
  if (diagramType && diagramType !== "flowchart" && diagramType !== "flowchart-v2") {
    return {
      data: null,
      diagnostics: [{
        code: "PPTX_MODE_UNSUPPORTED_FOR_DIAGRAM_TYPE",
        message: `PPTX ${mode} mode currently supports flowcharts; use exact mode for ${diagramType}.`,
        severity: "error",
      }],
      summary,
    };
  }

  const prepared = mode === "smart" ? prepareSmartCollisionRoutes(diagram) : {
    diagram,
    diagnostics: [] as ConversionDiagnostic[],
  };
  const workingDiagram = prepared.diagram;
  const diagnostics: ConversionDiagnostic[] = [...prepared.diagnostics];
  let editableEdgeObjects = 0;
  let fallbackObjects = 0;
  for (const edge of workingDiagram.edges) {
    diagnostics.push(...pptxStrokeDiagnostics(edge));
    const kind = smartConnectorKind(edge);
    if (mode === "faithful") {
      if (kind === "straight") {
        editableEdgeObjects += 1;
        const bindingDiagnostics = preflightEndpointBindings(workingDiagram, edge, "faithful");
        diagnostics.push(...bindingDiagnostics);
        if (bindingDiagnostics.length > 0) fallbackObjects += 1;
        continue;
      }
      const faithful = faithfulGeometry(edge, 1, 0, 0);
      if (faithful.ok) {
        editableEdgeObjects += 1;
        continue;
      }
      fallbackObjects += 1;
      diagnostics.push({
        code: "PPTX_FAITHFUL_EDGE_SVG_FALLBACK",
        elementId: edge.id,
        message: `Edge ${edge.id} cannot be represented as one open PowerPoint freeform (${faithful.reason}); one SVG edge object will be used.`,
        severity: "warning",
      });
      continue;
    }

    if (kind) {
      editableEdgeObjects += 1;
      const bindingDiagnostics = preflightEndpointBindings(workingDiagram, edge, "smart");
      diagnostics.push(...bindingDiagnostics);
      if (bindingDiagnostics.length > 0) fallbackObjects += 1;
      continue;
    }
    const faithful = faithfulGeometry(edge, 1, 0, 0);
    diagnostics.push({
      code: faithful.ok
        ? "PPTX_SMART_EDGE_FREEFORM_FALLBACK"
        : "PPTX_SMART_EDGE_SVG_FALLBACK",
      elementId: edge.id,
      message: faithful.ok
        ? `Edge ${edge.id} is not representable by a native connector; faithful editable freeform fallback will be used.`
        : `Edge ${edge.id} is not representable by a native connector or faithful freeform (${faithful.reason}); one SVG edge object will be used.`,
      severity: "warning",
    });
    if (faithful.ok) editableEdgeObjects += 1;
    fallbackObjects += 1;
  }
  summary = actualSummary(workingDiagram, editableEdgeObjects, fallbackObjects);
  return { data: null, diagnostics, summary };
}

function preflightEndpointBindings(
  diagram: DiagramIR,
  edge: DiagramEdge,
  mode: "faithful" | "smart",
): ConversionDiagnostic[] {
  const diagnostics: ConversionDiagnostic[] = [];
  if (edge.sourceId && !resolveEndpointNode(diagram, edge.sourceId, edge.start)) {
    diagnostics.push(unboundEndpointDiagnostic(edge, "source", edge.sourceId, mode));
  }
  if (edge.targetId && !resolveEndpointNode(diagram, edge.targetId, edge.end)) {
    diagnostics.push(unboundEndpointDiagnostic(edge, "target", edge.targetId, mode));
  }
  return diagnostics;
}

function prepareSmartCollisionRoutes(
  diagram: DiagramIR,
): { diagram: DiagramIR; diagnostics: ConversionDiagnostic[] } {
  const diagnostics: ConversionDiagnostic[] = [];
  const collidingEdgeIds = [...new Set(
    analyzeDiagramCollisions(diagram)
      .filter(({ kind }) => kind === "node-edge")
      .map(({ second }) => second.id),
  )].sort();
  if (collidingEdgeIds.length === 0) return { diagram, diagnostics };

  let working = diagram;
  for (const edgeId of collidingEdgeIds) {
    const edge = working.edges.find(({ id }) => id === edgeId);
    if (!edge) continue;
    const source = resolveEndpointNode(working, edge.sourceId, edge.start);
    const target = resolveEndpointNode(working, edge.targetId, edge.end);
    if (!source || !target || source.id === target.id) {
      diagnostics.push({
        code: "PPTX_SMART_EDGE_REROUTE_FAILED",
        elementId: edge.id,
        message: `Edge ${edge.id} crosses a non-endpoint node, but its two endpoint nodes could not be resolved uniquely; the original geometry was kept.`,
        severity: "warning",
      });
      continue;
    }

    const sourcePort = recognizedPort(edge.sourcePort);
    const targetPort = recognizedPort(edge.targetPort);
    const routed = routeOrthogonal({
      obstacles: working.nodes
        .filter((node) => node.id !== source.id && node.id !== target.id)
        .map(({ bounds }) => ({ ...bounds })),
      source: { ...source.bounds },
      ...(sourcePort ? { sourcePort } : {}),
      target: { ...target.bounds },
      ...(targetPort ? { targetPort } : {}),
    });
    const reroutedEdge: DiagramEdge = {
      ...edge,
      end: { ...routed.points.at(-1)! },
      ...(edge.label ? { label: centeredRouteLabel(edge.label, routed.points) } : {}),
      path: { segments: routed.path.segments.map(clonePathSegment) },
      points: routed.points.map((point) => ({ ...point })),
      start: { ...routed.points[0]! },
    };
    const candidate: DiagramIR = {
      ...working,
      edges: working.edges.map((current) => current.id === edge.id ? reroutedEdge : current),
    };
    const stillCrossesNode = analyzeDiagramCollisions(candidate).some((collision) =>
      collision.kind === "node-edge" && collision.second.id === edge.id);
    if (routed.usedFallback || stillCrossesNode) {
      const reason = routed.diagnostics[0]?.message
        ?? "the candidate route still intersects a non-endpoint node";
      diagnostics.push({
        code: "PPTX_SMART_EDGE_REROUTE_FAILED",
        elementId: edge.id,
        message: `Edge ${edge.id} crosses a non-endpoint node and could not be safely rerouted (${reason}); the original geometry was kept.`,
        severity: "warning",
      });
      continue;
    }
    working = candidate;
    diagnostics.push({
      code: "PPTX_SMART_EDGE_REROUTED",
      elementId: edge.id,
      message: `Edge ${edge.id} crossed a non-endpoint node and was rerouted orthogonally without moving nodes.`,
      severity: "info",
    });
  }
  return { diagram: working, diagnostics };
}

function centeredRouteLabel(label: DiagramText, points: readonly Point[]): DiagramText {
  const lengths = points.slice(1).map((point, index) =>
    Math.hypot(point.x - points[index]!.x, point.y - points[index]!.y));
  const total = lengths.reduce((sum, length) => sum + length, 0);
  let remaining = total / 2;
  let center = points[0] ?? { x: 0, y: 0 };
  for (let index = 0; index < lengths.length; index += 1) {
    const length = lengths[index]!;
    if (remaining <= length) {
      const start = points[index]!;
      const end = points[index + 1]!;
      const amount = length === 0 ? 0 : remaining / length;
      center = {
        x: start.x + (end.x - start.x) * amount,
        y: start.y + (end.y - start.y) * amount,
      };
      break;
    }
    remaining -= length;
  }
  return {
    ...label,
    bounds: {
      ...label.bounds,
      x: center.x - label.bounds.width / 2,
      y: center.y - label.bounds.height / 2,
    },
  };
}

function recognizedPort(
  value: string | undefined,
): "bottom" | "left" | "right" | "top" | undefined {
  const token = value?.trim().toLowerCase().split(/[:/.]/).at(-1);
  switch (token) {
    case "top": case "north": case "n": return "top";
    case "right": case "east": case "e": return "right";
    case "bottom": case "south": case "s": return "bottom";
    case "left": case "west": case "w": return "left";
    default: return undefined;
  }
}

function clonePathSegment(segment: DiagramPathSegment): DiagramPathSegment {
  if (segment.kind === "close") return segment;
  if (segment.kind === "cubic") return {
    ...segment,
    control1: { ...segment.control1 },
    control2: { ...segment.control2 },
    to: { ...segment.to },
  };
  if (segment.kind === "quadratic") return {
    ...segment,
    control: { ...segment.control },
    to: { ...segment.to },
  };
  return { ...segment, to: { ...segment.to } };
}


export async function diagramToPptxBuffer(
  diagram: DiagramIR,
  options: ConversionOptions = {},
): Promise<ConversionResult<Uint8Array>> {
  const diagnostics: ConversionDiagnostic[] = [];
  const mode = options.mode ?? "smart";
  let summary = summaryFor(diagram, mode);
  const inputDiagnostics = validatePptxInput(diagram, options);
  if (inputDiagnostics.length > 0) {
    return {
      data: new Uint8Array(),
      diagnostics: inputDiagnostics,
      summary,
    };
  }
  if (mode === "exact") {
    return exactSvgToPptxBuffer(exportDiagramToSvg(diagram), diagram, options);
  }
  const diagramType = diagram.source?.diagramType;
  if (diagramType && diagramType !== "flowchart" && diagramType !== "flowchart-v2") {
    return {
      data: new Uint8Array(),
      diagnostics: [{
        code: "PPTX_MODE_UNSUPPORTED_FOR_DIAGRAM_TYPE",
        message: `PPTX ${mode} mode currently supports flowcharts; use exact mode for ${diagramType}.`,
        severity: "error",
      }],
      summary,
    };
  }

  const prepared = mode === "smart" ? prepareSmartCollisionRoutes(diagram) : {
    diagram,
    diagnostics: [] as ConversionDiagnostic[],
  };
  const workingDiagram = prepared.diagram;
  diagnostics.push(...prepared.diagnostics);

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
    (slideWidth - paddingIn * 2) / workingDiagram.width,
    (slideHeight - paddingIn * 2) / workingDiagram.height,
  );
  const contentWidth = workingDiagram.width * scale;
  const contentHeight = workingDiagram.height * scale;
  const offsetX = (slideWidth - contentWidth) / 2;
  const offsetY = (slideHeight - contentHeight) / 2;

  let emittedEdgeObjects = 0;
  let editableEdgeObjects = 0;
  let fallbackObjects = 0;
  const connectorPatches: NativeConnectorPatch[] = [];
  for (const group of stableZOrder(workingDiagram.groups ?? [])) {
    addEditableGroup(slide, pptx, group, scale, offsetX, offsetY);
  }

  for (const edge of stableZOrder(workingDiagram.edges)) {
    diagnostics.push(...pptxStrokeDiagnostics(edge));
    if (mode === "faithful") {
      const native = addFaithfulNativeEdge(slide, edge, workingDiagram, scale, offsetX, offsetY);
      if (native) {
        emittedEdgeObjects += 1;
        editableEdgeObjects += 1;
        fallbackObjects += native.fallbackObjects;
        diagnostics.push(...native.diagnostics);
        connectorPatches.push(native.patch);
        continue;
      }
      const faithful = addFaithfulEdge(slide, edge, scale, offsetX, offsetY);
      if (faithful.ok) {
        emittedEdgeObjects += 1;
        editableEdgeObjects += 1;
        continue;
      }
      diagnostics.push({
        code: "PPTX_FAITHFUL_EDGE_SVG_FALLBACK",
        elementId: edge.id,
        message: `Edge ${edge.id} could not be represented as one open PowerPoint freeform (${faithful.reason}); embedded one SVG edge fallback.`,
        severity: "warning",
      });
      addSvgEdgeFallback(slide, edge, workingDiagram, offsetX, offsetY, contentWidth, contentHeight);
      emittedEdgeObjects += 1;
      fallbackObjects += 1;
      continue;
    }
    if (mode === "smart") {
      const smart = addSmartEdge(
        slide,
        edge,
        workingDiagram,
        scale,
        offsetX,
        offsetY,
        contentWidth,
        contentHeight,
      );
      emittedEdgeObjects += smart.objects;
      editableEdgeObjects += smart.editableObjects;
      fallbackObjects += smart.fallbackObjects;
      diagnostics.push(...smart.diagnostics);
      if (smart.patch) connectorPatches.push(smart.patch);
      continue;
    }
    const count = addSegmentedEdge(slide, pptx, edge, scale, offsetX, offsetY);
    emittedEdgeObjects += count;
    editableEdgeObjects += count;
  }

  for (const node of stableZOrder(workingDiagram.nodes)) {
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

    slide.addShape(shape, { objectName: nodeObjectName(node.id), x, y, w, h, fill, line });
  }

  // Cross-category stacking is fixed: groups, connectors, nodes, then labels.
  // zIndex only refines stable ordering inside one category.
  for (const label of stableZOrder(diagramTextObjects(workingDiagram))) {
    addEditableText(
      slide,
      label.text,
      options,
      scale,
      offsetX,
      offsetY,
      textObjectName(label.ownerKind, label.ownerId),
    );
  }

  summary = actualSummary(workingDiagram, editableEdgeObjects, fallbackObjects);

  const raw = await pptx.write({ outputType: "arraybuffer", compression: true });
  let data = toUint8Array(raw);
  if (connectorPatches.length > 0) {
    const patched = await patchNativeConnectors(data, connectorPatches);
    data = patched.data;
    const bindingFallbacks = new Set(patched.diagnostics
      .filter(({ code }) => code.endsWith("CONNECTOR_BINDING_FALLBACK"))
      .map(({ elementId }, index) => elementId ?? `document-${index}`));
    if (bindingFallbacks.size > 0) {
      summary = { ...summary, fallbackObjects: summary.fallbackObjects + bindingFallbacks.size };
    }
    diagnostics.push(...patched.diagnostics, {
      code: mode === "faithful"
        ? "PPTX_FAITHFUL_CONNECTOR_CROSS_PLATFORM_UNVERIFIED"
        : "PPTX_SMART_CONNECTOR_CROSS_PLATFORM_UNVERIFIED",
      message: "Native connector OOXML is structurally verified, but node-following behavior has not yet been manually certified across PowerPoint Windows/macOS/web and LibreOffice.",
      severity: "info",
    });
  }
  const labels = diagramTextObjects(workingDiagram).length;
  diagnostics.push(...await validatePowerPointXml(
    data,
    (workingDiagram.groups?.length ?? 0) + workingDiagram.nodes.length + emittedEdgeObjects + labels,
  ));
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
  if (options.mode === "exact") {
    const generated = await exactSvgToPptxBuffer(svg, parsed.data, options);
    return {
      data: generated.data,
      diagnostics: [...parsed.diagnostics, ...generated.diagnostics],
      summary: generated.summary,
    };
  }
  const generated = await diagramToPptxBuffer(parsed.data, options);
  return {
    data: generated.data,
    diagnostics: [...parsed.diagnostics, ...generated.diagnostics],
    summary: generated.summary,
  };
}

export async function svgStringToPptxBlob(
  svg: string,
  options: ConversionOptions = {},
): Promise<ConversionResult<Blob>> {
  const result = await svgStringToPptxBuffer(svg, options);
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

async function exactSvgToPptxBuffer(
  svg: string,
  diagram: DiagramIR,
  options: ConversionOptions,
): Promise<ConversionResult<Uint8Array>> {
  const inputDiagnostics = validatePptxInput(diagram, options);
  if (inputDiagnostics.length > 0) {
    return {
      data: new Uint8Array(),
      diagnostics: inputDiagnostics,
      summary: summaryFor(diagram, "exact"),
    };
  }
  const sanitized = sanitizeSvgForEmbedding(svg);
  const pptx = new PptxGenJS();
  const wide = (options.layout ?? "wide") === "wide";
  pptx.layout = wide ? "LAYOUT_WIDE" : "LAYOUT_4x3";
  pptx.author = "mmd2pptx contributors";
  pptx.company = "mmd2pptx";
  pptx.subject = "Vector diagram generated from Mermaid SVG";
  pptx.title = options.title ?? "Mermaid diagram";
  const slide = pptx.addSlide();
  slide.background = { color: normalizePptxColor(options.backgroundColor) ?? "FFFFFF" };
  const placement = diagramPlacement(diagram, options, wide);
  slide.addImage({
    altText: "Mermaid diagram (single SVG vector object)",
    data: svgDataUri(sanitized.svg),
    objectName: "mmd2pptx-exact-svg",
    x: placement.offsetX,
    y: placement.offsetY,
    w: placement.contentWidth,
    h: placement.contentHeight,
  });
  const raw = await pptx.write({ outputType: "arraybuffer", compression: true });
  const data = toUint8Array(raw);
  const diagnostics: ConversionDiagnostic[] = [...sanitized.diagnostics, {
    code: "PPTX_EXACT_SVG_EMBEDDED",
    message: "Exact mode embeds the diagram as one vector SVG object; internal nodes and edges are not editable PowerPoint objects.",
    severity: "info",
  }, {
    code: "PPTX_SVG_CROSS_PLATFORM_UNVERIFIED",
    message: "The embedded SVG package structure is verified, but PowerPoint Windows/macOS/web and LibreOffice rendering has not yet been manually certified.",
    severity: "info",
  }];
  diagnostics.push(...await validatePowerPointXml(data, 1));
  return {
    data,
    diagnostics,
    summary: {
      editableObjects: 0,
      edges: diagram.edges.length,
      fallbackObjects: 0,
      nodes: diagram.nodes.length,
    },
  };
}

function sanitizeSvgForEmbedding(
  svg: string,
): { diagnostics: ConversionDiagnostic[]; svg: string } {
  const document = new DOMParser().parseFromString(svg, "image/svg+xml");
  let removed = 0;
  for (const name of ["script", "iframe", "object", "embed"]) {
    for (const element of Array.from(document.getElementsByTagName(name))) {
      element.parentNode?.removeChild(element);
      removed += 1;
    }
  }
  for (const element of Array.from(document.getElementsByTagName("*"))) {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on")) {
        element.removeAttribute(attribute.name);
        removed += 1;
        continue;
      }
      if ((name === "href" || name === "xlink:href" || name === "src")
        && !safeEmbeddedReference(attribute.value)) {
        element.removeAttribute(attribute.name);
        removed += 1;
        continue;
      }
      if (name === "style") {
        const safe = sanitizeCssReferences(attribute.value);
        if (safe !== attribute.value) {
          element.setAttribute(attribute.name, safe);
          removed += 1;
        }
        continue;
      }
      if (/url\s*\(/i.test(attribute.value)) {
        const safe = sanitizeCssReferences(attribute.value);
        if (safe !== attribute.value) {
          element.setAttribute(attribute.name, safe);
          removed += 1;
        }
      }
    }
  }
  for (const style of Array.from(document.getElementsByTagName("style"))) {
    const original = style.textContent ?? "";
    const safe = sanitizeCssReferences(original).replace(/@import\s+[^;]+;?/gi, "");
    if (safe !== original) {
      while (style.firstChild) style.removeChild(style.firstChild);
      style.appendChild(document.createTextNode(safe));
      removed += 1;
    }
  }
  return {
    diagnostics: removed > 0 ? [{
      code: "PPTX_EXACT_ACTIVE_CONTENT_REMOVED",
      message: `Removed ${removed} active or external SVG reference${removed === 1 ? "" : "s"} before embedding.`,
      severity: "warning",
    }] : [],
    svg: new XMLSerializer().serializeToString(document),
  };
}

function safeEmbeddedReference(value: string): boolean {
  const normalized = value.trim();
  return normalized.startsWith("#") || /^data:image\/(?:gif|jpeg|png|webp);/i.test(normalized);
}

function sanitizeCssReferences(value: string): string {
  return value.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (match, _quote, target: string) =>
    safeEmbeddedReference(target) ? match : "none");
}

function diagramPlacement(
  diagram: DiagramIR,
  options: ConversionOptions,
  wide: boolean,
): { contentHeight: number; contentWidth: number; offsetX: number; offsetY: number } {
  const slideWidth = wide ? 13.333 : 10;
  const slideHeight = 7.5;
  const paddingIn = Math.max(0, options.padding ?? 24) / 96;
  const scale = Math.min(
    (slideWidth - paddingIn * 2) / diagram.width,
    (slideHeight - paddingIn * 2) / diagram.height,
  );
  const contentWidth = diagram.width * scale;
  const contentHeight = diagram.height * scale;
  return {
    contentHeight,
    contentWidth,
    offsetX: (slideWidth - contentWidth) / 2,
    offsetY: (slideHeight - contentHeight) / 2,
  };
}

function svgDataUri(svg: string): string {
  if (typeof Buffer !== "undefined") {
    return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
  }
  const bytes = new TextEncoder().encode(svg);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}

async function validatePowerPointXml(
  data: Uint8Array,
  expectedObjects: number,
): Promise<ConversionDiagnostic[]> {
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
      const nativeObjects = xml.match(/<p:(?:sp|cxnSp|pic)(?:\s|>)/g)?.length ?? 0;
      if (nativeObjects < expectedObjects) {
        return [{
          code: "PPTX_OBJECT_COUNT_MISMATCH",
          message: `${name} contains ${nativeObjects} editable objects; expected at least ${expectedObjects}.`,
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
    case "parallelogram":
      return pptx.ShapeType.parallelogram;
    case "trapezoid":
      return pptx.ShapeType.trapezoid;
    case "cylinder":
      return pptx.ShapeType.can;
    case "rect":
    default:
      return pptx.ShapeType.rect;
  }
}

function addEditableGroup(
  slide: PptxGenJS.Slide,
  pptx: PptxGenJS,
  group: DiagramGroup,
  scale: number,
  offsetX: number,
  offsetY: number,
): void {
  const fillColor = normalizePptxColor(group.fill);
  slide.addShape(pptx.ShapeType.rect, {
    objectName: groupObjectName(group.id),
    x: offsetX + group.bounds.x * scale,
    y: offsetY + group.bounds.y * scale,
    w: Math.max(group.bounds.width * scale, 0.02),
    h: Math.max(group.bounds.height * scale, 0.02),
    fill: fillColor ? { color: fillColor } : { color: "FFFFFF", transparency: 100 },
    line: {
      color: normalizePptxColor(group.stroke) ?? "7E898F",
      width: Math.max(group.strokeWidth ?? 1.25, 0.5),
    },
  });
}

interface DiagramTextObject {
  ownerId: string;
  ownerKind: "edge" | "group" | "node";
  text: DiagramText;
  zIndex: number | undefined;
}

function diagramTextObjects(diagram: DiagramIR): DiagramTextObject[] {
  return [
    ...(diagram.groups ?? []).flatMap((group): DiagramTextObject[] => group.text ? [{
      ownerId: group.id,
      ownerKind: "group",
      text: group.text,
      zIndex: group.text.zIndex,
    }] : []),
    ...diagram.nodes.flatMap((node): DiagramTextObject[] => node.text ? [{
      ownerId: node.id,
      ownerKind: "node",
      text: node.text,
      zIndex: node.text.zIndex,
    }] : []),
    ...diagram.edges.flatMap((edge): DiagramTextObject[] => edge.label ? [{
      ownerId: edge.id,
      ownerKind: "edge",
      text: edge.label,
      zIndex: edge.label.zIndex,
    }] : []),
  ];
}

/** Stable ascending z-order; an omitted zIndex occupies the default layer 0. */
function stableZOrder<T extends { zIndex?: number | undefined }>(items: readonly T[]): T[] {
  return items
    .map((item, inputIndex) => ({ inputIndex, item }))
    .sort((left, right) =>
      (left.item.zIndex ?? 0) - (right.item.zIndex ?? 0)
      || left.inputIndex - right.inputIndex)
    .map(({ item }) => item);
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

function validatePptxInput(
  diagram: DiagramIR,
  options: ConversionOptions,
): ConversionDiagnostic[] {
  const diagnostics: ConversionDiagnostic[] = [];
  if (!isFiniteDiagram(diagram)) {
    diagnostics.push({
      code: "DIAGRAM_DIMENSIONS_INVALID",
      message: "Diagram dimensions must be finite positive numbers.",
      severity: "error",
    });
  }

  if (options.mode !== undefined && !["smart", "faithful", "exact"].includes(options.mode)) {
    diagnostics.push({
      code: "PPTX_MODE_INVALID",
      message: "PPTX mode must be smart, faithful, or exact.",
      severity: "error",
    });
  }
  if (options.layout !== undefined && !["wide", "standard"].includes(options.layout)) {
    diagnostics.push({
      code: "PPTX_LAYOUT_INVALID",
      message: "PPTX layout must be wide or standard.",
      severity: "error",
    });
  }

  const padding = options.padding ?? 24;
  if (!Number.isFinite(padding) || padding < 0) {
    diagnostics.push({
      code: "PPTX_PADDING_INVALID",
      message: "PPTX padding must be a finite non-negative number of pixels.",
      severity: "error",
    });
  } else {
    const wide = (options.layout ?? "wide") === "wide";
    const slideWidthPx = (wide ? 13.333 : 10) * 96;
    const slideHeightPx = 7.5 * 96;
    if (padding * 2 >= Math.min(slideWidthPx, slideHeightPx)) {
      diagnostics.push({
        code: "PPTX_PADDING_EXCEEDS_SLIDE",
        message: "PPTX padding must leave positive drawable width and height on the slide.",
        severity: "error",
      });
    }
  }

  for (const group of diagram.groups ?? []) {
    if (!finiteBounds(group.bounds)) {
      diagnostics.push({
        code: "PPTX_GROUP_BOUNDS_INVALID",
        elementId: group.id,
        message: `Group ${group.id} must have finite coordinates and positive dimensions.`,
        severity: "error",
      });
    }
    if (group.text && !finiteBounds(group.text.bounds)) {
      diagnostics.push({
        code: "PPTX_TEXT_BOUNDS_INVALID",
        elementId: group.id,
        message: `Group ${group.id} has invalid text bounds.`,
        severity: "error",
      });
    }
    if ((group.strokeWidth !== undefined && !finitePositive(group.strokeWidth))
      || !finiteOptionalZIndex(group.zIndex)
      || !finiteOptionalZIndex(group.text?.zIndex)
      || (group.text?.fontSize !== undefined && !finitePositive(group.text.fontSize))) {
      diagnostics.push({
        code: "PPTX_GROUP_STYLE_INVALID",
        elementId: group.id,
        message: `Group ${group.id} contains a non-finite or non-positive style value.`,
        severity: "error",
      });
    }
  }

  for (const node of diagram.nodes) {
    if (!finiteBounds(node.bounds)) {
      diagnostics.push({
        code: "PPTX_NODE_BOUNDS_INVALID",
        elementId: node.id,
        message: `Node ${node.id} must have finite coordinates and positive dimensions.`,
        severity: "error",
      });
    }
    if (node.text && !finiteBounds(node.text.bounds)) {
      diagnostics.push({
        code: "PPTX_TEXT_BOUNDS_INVALID",
        elementId: node.id,
        message: `Node ${node.id} has invalid text bounds.`,
        severity: "error",
      });
    }
    if ((node.strokeWidth !== undefined && !finitePositive(node.strokeWidth))
      || !finiteOptionalZIndex(node.zIndex)
      || !finiteOptionalZIndex(node.text?.zIndex)
      || (node.text?.fontSize !== undefined && !finitePositive(node.text.fontSize))) {
      diagnostics.push({
        code: "PPTX_NODE_STYLE_INVALID",
        elementId: node.id,
        message: `Node ${node.id} contains a non-finite or non-positive style value.`,
        severity: "error",
      });
    }
  }

  for (const edge of diagram.edges) {
    const pointsValid = (!edge.points || edge.points.every(finitePoint))
      && finitePoint(edge.start)
      && finitePoint(edge.end);
    const pathValid = !edge.path || (edge.path.segments.length > 0
      && edge.path.segments[0]?.kind === "move"
      && edge.path.segments.every(finitePathSegment));
    if (!pointsValid || !pathValid) {
      diagnostics.push({
        code: "PPTX_EDGE_GEOMETRY_INVALID",
        elementId: edge.id,
        message: `Edge ${edge.id} contains non-finite or invalid path geometry.`,
        severity: "error",
      });
    }
    if (edge.label && !finiteBounds(edge.label.bounds)) {
      diagnostics.push({
        code: "PPTX_TEXT_BOUNDS_INVALID",
        elementId: edge.id,
        message: `Edge ${edge.id} has invalid label bounds.`,
        severity: "error",
      });
    }
    if ((edge.strokeWidth !== undefined && !finitePositive(edge.strokeWidth))
      || !finiteOptionalZIndex(edge.zIndex)
      || !finiteOptionalZIndex(edge.label?.zIndex)
      || (edge.stroke?.width !== undefined && !finitePositive(edge.stroke.width))
      || (edge.stroke?.opacity !== undefined
        && (!Number.isFinite(edge.stroke.opacity) || edge.stroke.opacity < 0 || edge.stroke.opacity > 1))
      || (edge.stroke?.dashOffset !== undefined && !Number.isFinite(edge.stroke.dashOffset))
      || (edge.stroke?.dashArray !== undefined
        && !edge.stroke.dashArray.every((value) => Number.isFinite(value) && value >= 0))
      || (edge.label?.fontSize !== undefined && !finitePositive(edge.label.fontSize))) {
      diagnostics.push({
        code: "PPTX_EDGE_STYLE_INVALID",
        elementId: edge.id,
        message: `Edge ${edge.id} contains a non-finite or out-of-range style value.`,
        severity: "error",
      });
    }
  }
  return diagnostics;
}

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function finiteOptionalZIndex(value: number | undefined): boolean {
  return value === undefined || Number.isFinite(value);
}

function finiteBounds(bounds: { height: number; width: number; x: number; y: number }): boolean {
  return finitePoint(bounds) && Number.isFinite(bounds.width) && bounds.width > 0
    && Number.isFinite(bounds.height) && bounds.height > 0;
}

function finitePathSegment(segment: DiagramPathSegment): boolean {
  if (segment.kind === "close") return true;
  if (!finitePoint(segment.to)) return false;
  if (segment.kind === "cubic") {
    return finitePoint(segment.control1) && finitePoint(segment.control2);
  }
  if (segment.kind === "quadratic") return finitePoint(segment.control);
  if (segment.kind === "arc") {
    return Number.isFinite(segment.radiusX) && segment.radiusX >= 0
      && Number.isFinite(segment.radiusY) && segment.radiusY >= 0
      && Number.isFinite(segment.rotation);
  }
  return true;
}

function summaryFor(
  diagram: DiagramIR,
  mode: NonNullable<ConversionOptions["mode"]>,
): ConversionSummary {
  if (mode === "exact") {
    return {
      editableObjects: 0,
      edges: diagram.edges.length,
      fallbackObjects: 0,
      nodes: diagram.nodes.length,
    };
  }
  return {
    editableObjects: (diagram.groups?.length ?? 0) + diagram.nodes.length
      + diagramTextObjects(diagram).length + diagram.edges.reduce((count, edge) =>
      count + (mode === "faithful" ? 1 : Math.max(1, edgePoints(edge).length - 1)), 0),
    edges: diagram.edges.length,
    fallbackObjects: 0,
    nodes: diagram.nodes.length,
  };
}

function actualSummary(
  diagram: DiagramIR,
  edgeObjects: number,
  fallbackObjects: number,
): ConversionSummary {
  const labels = diagramTextObjects(diagram).length;
  return {
    editableObjects: (diagram.groups?.length ?? 0) + diagram.nodes.length + edgeObjects + labels,
    edges: diagram.edges.length,
    fallbackObjects,
    nodes: diagram.nodes.length,
  };
}

function edgePoints(edge: DiagramEdge) {
  return edge.points && edge.points.length >= 2 ? edge.points : [edge.start, edge.end];
}

function addFaithfulNativeEdge(
  slide: PptxGenJS.Slide,
  edge: DiagramEdge,
  diagram: DiagramIR,
  scale: number,
  offsetX: number,
  offsetY: number,
): {
  diagnostics: ConversionDiagnostic[];
  fallbackObjects: number;
  patch: NativeConnectorPatch;
} | undefined {
  if (smartConnectorKind(edge) !== "straight") return undefined;
  const diagnostics: ConversionDiagnostic[] = [];
  const start = { x: offsetX + edge.start.x * scale, y: offsetY + edge.start.y * scale };
  const end = { x: offsetX + edge.end.x * scale, y: offsetY + edge.end.y * scale };
  const edgeName = edgeObjectName(edge.id);
  slide.addShape(STRAIGHT_CONNECTOR, {
    objectName: edgeName,
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    w: Math.max(Math.abs(end.x - start.x), 0.001),
    h: Math.max(Math.abs(end.y - start.y), 0.001),
    flipH: end.x < start.x,
    flipV: end.y < start.y,
    line: edgeLine(edge, true, true),
  });
  const sourceNode = resolveEndpointNode(diagram, edge.sourceId, edge.start);
  const targetNode = resolveEndpointNode(diagram, edge.targetId, edge.end);
  if (edge.sourceId && !sourceNode) diagnostics.push(unboundEndpointDiagnostic(
    edge,
    "source",
    edge.sourceId,
    "faithful",
  ));
  if (edge.targetId && !targetNode) diagnostics.push(unboundEndpointDiagnostic(
    edge,
    "target",
    edge.targetId,
    "faithful",
  ));
  return {
    diagnostics,
    fallbackObjects: diagnostics.length > 0 ? 1 : 0,
    patch: {
      edgeObjectName: edgeName,
      elementId: edge.id,
      mode: "faithful",
      ...(sourceNode ? { start: {
        nodeObjectName: nodeObjectName(sourceNode.id),
        siteIndex: connectionSite(sourceNode.bounds, edge.start),
      } } : {}),
      ...(targetNode ? { end: {
        nodeObjectName: nodeObjectName(targetNode.id),
        siteIndex: connectionSite(targetNode.bounds, edge.end),
      } } : {}),
    },
  };
}

function addSmartEdge(
  slide: PptxGenJS.Slide,
  edge: DiagramEdge,
  diagram: DiagramIR,
  scale: number,
  offsetX: number,
  offsetY: number,
  contentWidth: number,
  contentHeight: number,
): {
  diagnostics: ConversionDiagnostic[];
  editableObjects: number;
  fallbackObjects: number;
  objects: number;
  patch?: NativeConnectorPatch;
} {
  const diagnostics: ConversionDiagnostic[] = [];
  const kind = smartConnectorKind(edge);
  if (!kind) {
    diagnostics.push({
      code: "PPTX_SMART_EDGE_FREEFORM_FALLBACK",
      elementId: edge.id,
      message: `Edge ${edge.id} is not representable by a native straight, elbow, or simple curved connector; faithful freeform fallback was selected.`,
      severity: "warning",
    });
    const faithful = addFaithfulEdge(slide, edge, scale, offsetX, offsetY);
    if (faithful.ok) return { diagnostics, editableObjects: 1, fallbackObjects: 1, objects: 1 };
    diagnostics.push({
      code: "PPTX_SMART_EDGE_SVG_FALLBACK",
      elementId: edge.id,
      message: `Edge ${edge.id} could not be represented as a faithful freeform (${faithful.reason}); a single SVG edge object was embedded.`,
      severity: "warning",
    });
    addSvgEdgeFallback(slide, edge, diagram, offsetX, offsetY, contentWidth, contentHeight);
    return { diagnostics, editableObjects: 0, fallbackObjects: 1, objects: 1 };
  }

  const start = { x: offsetX + edge.start.x * scale, y: offsetY + edge.start.y * scale };
  const end = { x: offsetX + edge.end.x * scale, y: offsetY + edge.end.y * scale };
  const shape = kind === "straight" ? STRAIGHT_CONNECTOR
    : kind === "orthogonal" ? ELBOW_CONNECTOR
    : CURVED_CONNECTOR;
  const edgeName = edgeObjectName(edge.id);
  slide.addShape(shape, {
    objectName: edgeName,
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    w: Math.max(Math.abs(end.x - start.x), 0.001),
    h: Math.max(Math.abs(end.y - start.y), 0.001),
    flipH: end.x < start.x,
    flipV: end.y < start.y,
    line: edgeLine(edge, true, true),
  });

  const sourceNode = resolveEndpointNode(diagram, edge.sourceId, edge.start);
  const targetNode = resolveEndpointNode(diagram, edge.targetId, edge.end);
  if (edge.sourceId && !sourceNode) diagnostics.push(unboundEndpointDiagnostic(edge, "source", edge.sourceId));
  if (edge.targetId && !targetNode) diagnostics.push(unboundEndpointDiagnostic(edge, "target", edge.targetId));
  const patch: NativeConnectorPatch = {
    edgeObjectName: edgeName,
    elementId: edge.id,
    ...(sourceNode ? { start: {
      nodeObjectName: nodeObjectName(sourceNode.id),
      siteIndex: connectionSite(sourceNode.bounds, edge.start),
    } } : {}),
    ...(targetNode ? { end: {
      nodeObjectName: nodeObjectName(targetNode.id),
      siteIndex: connectionSite(targetNode.bounds, edge.end),
    } } : {}),
  };
  const bindingFallback = diagnostics.some(({ code }) => code === "PPTX_SMART_ENDPOINT_UNBOUND");
  return {
    diagnostics,
    editableObjects: 1,
    fallbackObjects: bindingFallback ? 1 : 0,
    objects: 1,
    patch,
  };
}

function smartConnectorKind(edge: DiagramEdge): "curved" | "orthogonal" | "straight" | undefined {
  if (edge.path) {
    const kind = classifyDiagramPath(edge.path);
    if (kind === "straight" || kind === "orthogonal") return kind;
    if (kind === "curved") {
      const drawable = edge.path.segments.filter(({ kind: segmentKind }) => segmentKind !== "move");
      return drawable.length === 1 ? "curved" : undefined;
    }
    return undefined;
  }
  const points = edgePoints(edge);
  if (points.length === 2) return "straight";
  if (points.length < 2) return undefined;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const point = points[index];
    if (!previous || !point) return undefined;
    if (Math.abs(previous.x - point.x) > 0.0001 && Math.abs(previous.y - point.y) > 0.0001) {
      return undefined;
    }
  }
  return "orthogonal";
}

function addSvgEdgeFallback(
  slide: PptxGenJS.Slide,
  edge: DiagramEdge,
  diagram: DiagramIR,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  const { label: _label, ...edgeWithoutLabel } = edge;
  const svg = exportDiagramToSvg({
    edges: [edgeWithoutLabel],
    height: diagram.height,
    nodes: [],
    width: diagram.width,
  }, { includeXmlDeclaration: false });
  slide.addImage({
    altText: `Fallback vector edge ${edge.id}`,
    data: svgDataUri(svg),
    objectName: `${edgeObjectName(edge.id)}:svg-fallback`,
    x,
    y,
    w: width,
    h: height,
  });
}

function resolveEndpointNode(diagram: DiagramIR, endpointId: string | undefined, point: Point) {
  if (endpointId) {
    const matches = diagram.nodes.filter((node) =>
      node.id === endpointId || node.semanticId === endpointId || node.sourceKey === endpointId);
    return matches.length === 1 ? matches[0] : undefined;
  }
  const candidates = diagram.nodes
    .map((node) => ({ distance: distanceToBounds(node.bounds, point), node }))
    .filter(({ distance }) => distance <= 1)
    .sort((left, right) => left.distance - right.distance);
  if (!candidates[0] || candidates[1]?.distance === candidates[0].distance) return undefined;
  return candidates[0].node;
}

function distanceToBounds(
  bounds: { height: number; width: number; x: number; y: number },
  point: Point,
): number {
  const right = bounds.x + bounds.width;
  const bottom = bounds.y + bounds.height;
  if (point.x >= bounds.x && point.x <= right && point.y >= bounds.y && point.y <= bottom) {
    return Math.min(
      Math.abs(point.x - bounds.x),
      Math.abs(point.x - right),
      Math.abs(point.y - bounds.y),
      Math.abs(point.y - bottom),
    );
  }
  const dx = Math.max(bounds.x - point.x, 0, point.x - right);
  const dy = Math.max(bounds.y - point.y, 0, point.y - bottom);
  return Math.hypot(dx, dy);
}

function unboundEndpointDiagnostic(
  edge: DiagramEdge,
  end: "source" | "target",
  endpointId: string,
  mode: "faithful" | "smart" = "smart",
): ConversionDiagnostic {
  return {
    code: mode === "faithful" ? "PPTX_FAITHFUL_ENDPOINT_UNBOUND" : "PPTX_SMART_ENDPOINT_UNBOUND",
    elementId: edge.id,
    message: `Edge ${edge.id} ${end} endpoint ${endpointId} did not resolve to a unique node; the connector endpoint remains unbound.`,
    severity: "warning",
  };
}

function connectionSite(bounds: { height: number; width: number; x: number; y: number }, point: Point): number {
  const distances = [
    Math.abs(point.y - bounds.y),
    Math.abs(point.x - bounds.x),
    Math.abs(point.y - (bounds.y + bounds.height)),
    Math.abs(point.x - (bounds.x + bounds.width)),
  ];
  let best = 0;
  for (let index = 1; index < distances.length; index += 1) {
    if ((distances[index] ?? Infinity) < (distances[best] ?? Infinity)) best = index;
  }
  return best;
}

function nodeObjectName(id: string): string {
  return `mmd2pptx-node:${encodeURIComponent(id)}`;
}

function groupObjectName(id: string): string {
  return `mmd2pptx-group:${encodeURIComponent(id)}`;
}

function textObjectName(ownerKind: DiagramTextObject["ownerKind"], id: string): string {
  return `mmd2pptx-label:${ownerKind}:${encodeURIComponent(id)}`;
}

function edgeObjectName(id: string): string {
  return `mmd2pptx-edge:${encodeURIComponent(id)}`;
}

function addSegmentedEdge(
  slide: PptxGenJS.Slide,
  pptx: PptxGenJS,
  edge: DiagramEdge,
  scale: number,
  offsetX: number,
  offsetY: number,
): number {
  const points = edgePoints(edge);
  let emitted = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    if (!start || !end) continue;
    const startX = offsetX + start.x * scale;
    const startY = offsetY + start.y * scale;
    const endX = offsetX + end.x * scale;
    const endY = offsetY + end.y * scale;
    slide.addShape(pptx.ShapeType.line, {
      x: Math.min(startX, endX),
      y: Math.min(startY, endY),
      w: Math.max(Math.abs(endX - startX), 0.001),
      h: Math.max(Math.abs(endY - startY), 0.001),
      flipH: endX < startX,
      flipV: endY < startY,
      line: edgeLine(edge, index === 0, index === points.length - 2),
    });
    emitted += 1;
  }
  return emitted;
}

function addFaithfulEdge(
  slide: PptxGenJS.Slide,
  edge: DiagramEdge,
  scale: number,
  offsetX: number,
  offsetY: number,
): { ok: true } | { ok: false; reason: string } {
  const geometry = faithfulGeometry(edge, scale, offsetX, offsetY);
  if (!geometry.ok) return geometry;
  slide.addShape(CUSTOM_GEOMETRY, {
    x: geometry.x,
    y: geometry.y,
    w: geometry.width,
    h: geometry.height,
    points: geometry.points,
    line: edgeLine(edge, true, true),
  });
  return { ok: true };
}

function faithfulGeometry(
  edge: DiagramEdge,
  scale: number,
  offsetX: number,
  offsetY: number,
): {
  height: number;
  ok: true;
  points: CustomGeometryPoint[];
  width: number;
  x: number;
  y: number;
} | { ok: false; reason: string } {
  const toSlide = (point: Point): Point => ({
    x: offsetX + point.x * scale,
    y: offsetY + point.y * scale,
  });
  const absolute: CustomGeometryPoint[] = [];
  const boundsPoints: Point[] = [];

  if (!edge.path) {
    const points = edgePoints(edge).map(toSlide);
    if (points.length < 2 || points.some((point) => !finitePoint(point))) {
      return { ok: false, reason: "legacy edge points are not finite" };
    }
    points.forEach((point, index) => {
      absolute.push(index === 0 ? { ...point, moveTo: true } : point);
      boundsPoints.push(point);
    });
  } else {
    if (edge.path.segments[0]?.kind !== "move") {
      return { ok: false, reason: "canonical path does not begin with a move command" };
    }
    let previous: Point | undefined;
    let drawableSegments = 0;
    for (let index = 0; index < edge.path.segments.length; index += 1) {
      const segment = edge.path.segments[index];
      if (!segment) continue;
      if (segment.kind === "close") {
        return { ok: false, reason: "canonical path is closed" };
      }
      if (segment.kind === "move") {
        if (index !== 0) return { ok: false, reason: "canonical path contains multiple subpaths" };
        const to = toSlide(segment.to);
        if (!finitePoint(to)) return { ok: false, reason: "canonical path contains non-finite coordinates" };
        absolute.push({ ...to, moveTo: true });
        boundsPoints.push(to);
        previous = to;
        continue;
      }
      if (!previous) return { ok: false, reason: "canonical path has no current point" };
      const converted = customGeometrySegment(segment, previous, toSlide, scale);
      if (!converted.ok) return converted;
      absolute.push(converted.point);
      boundsPoints.push(...converted.bounds);
      previous = converted.to;
      drawableSegments += 1;
    }
    if (drawableSegments === 0) return { ok: false, reason: "canonical path has no drawable segments" };
  }

  const minX = Math.min(...boundsPoints.map(({ x }) => x));
  const minY = Math.min(...boundsPoints.map(({ y }) => y));
  const maxX = Math.max(...boundsPoints.map(({ x }) => x));
  const maxY = Math.max(...boundsPoints.map(({ y }) => y));
  if (![minX, minY, maxX, maxY].every(Number.isFinite)) {
    return { ok: false, reason: "edge bounds are not finite" };
  }
  return {
    height: Math.max(maxY - minY, 0.001),
    ok: true,
    points: absolute.map((point) => localCustomPoint(point, minX, minY)),
    width: Math.max(maxX - minX, 0.001),
    x: minX,
    y: minY,
  };
}

function customGeometrySegment(
  segment: Exclude<DiagramPathSegment, { kind: "close" | "move" }>,
  previous: Point,
  toSlide: (point: Point) => Point,
  scale: number,
): {
  bounds: Point[];
  ok: true;
  point: CustomGeometryPoint;
  to: Point;
} | { ok: false; reason: string } {
  const to = toSlide(segment.to);
  if (!finitePoint(to)) return { ok: false, reason: "canonical path contains non-finite coordinates" };
  if (segment.kind === "line") return { bounds: [to], ok: true, point: to, to };
  if (segment.kind === "cubic") {
    const control1 = toSlide(segment.control1);
    const control2 = toSlide(segment.control2);
    if (!finitePoint(control1) || !finitePoint(control2)) {
      return { ok: false, reason: "cubic control points are not finite" };
    }
    return {
      bounds: [control1, control2, to],
      ok: true,
      point: { x: to.x, y: to.y, curve: {
        type: "cubic",
        x1: control1.x,
        y1: control1.y,
        x2: control2.x,
        y2: control2.y,
      } },
      to,
    };
  }
  if (segment.kind === "quadratic") {
    const control = toSlide(segment.control);
    if (!finitePoint(control)) return { ok: false, reason: "quadratic control point is not finite" };
    return {
      bounds: [control, to],
      ok: true,
      point: { x: to.x, y: to.y, curve: {
        type: "quadratic",
        x1: control.x,
        y1: control.y,
      } },
      to,
    };
  }
  const normalizedRotation = ((segment.rotation % 180) + 180) % 180;
  if (Math.min(normalizedRotation, 180 - normalizedRotation) > 0.0001) {
    return { ok: false, reason: "rotated SVG arcs are not supported by DrawingML arcTo" };
  }
  if (segment.radiusX === 0 || segment.radiusY === 0 || samePoint(previous, to)) {
    return { bounds: [to], ok: true, point: to, to };
  }
  const arc = svgArc(previous, to, segment.radiusX * scale, segment.radiusY * scale,
    segment.largeArc, segment.sweep);
  if (!arc) return { ok: false, reason: "SVG arc parameters could not be normalized" };
  return {
    bounds: [
      to,
      { x: arc.center.x - arc.radiusX, y: arc.center.y - arc.radiusY },
      { x: arc.center.x + arc.radiusX, y: arc.center.y + arc.radiusY },
    ],
    ok: true,
    point: { x: to.x, y: to.y, curve: {
      type: "arc",
      hR: arc.radiusY,
      wR: arc.radiusX,
      stAng: arc.startAngle,
      swAng: arc.sweepAngle,
    } },
    to,
  };
}

function svgArc(
  start: Point,
  end: Point,
  inputRadiusX: number,
  inputRadiusY: number,
  largeArc: boolean,
  sweep: boolean,
): {
  center: Point;
  radiusX: number;
  radiusY: number;
  startAngle: number;
  sweepAngle: number;
} | undefined {
  let radiusX = Math.abs(inputRadiusX);
  let radiusY = Math.abs(inputRadiusY);
  if (![radiusX, radiusY].every((value) => Number.isFinite(value) && value > 0)) return undefined;
  const halfX = (start.x - end.x) / 2;
  const halfY = (start.y - end.y) / 2;
  const lambda = halfX ** 2 / radiusX ** 2 + halfY ** 2 / radiusY ** 2;
  if (lambda > 1) {
    const correction = Math.sqrt(lambda);
    radiusX *= correction;
    radiusY *= correction;
  }
  const numerator = Math.max(0,
    radiusX ** 2 * radiusY ** 2 - radiusX ** 2 * halfY ** 2 - radiusY ** 2 * halfX ** 2);
  const denominator = radiusX ** 2 * halfY ** 2 + radiusY ** 2 * halfX ** 2;
  if (denominator === 0) return undefined;
  const coefficient = (largeArc === sweep ? -1 : 1) * Math.sqrt(numerator / denominator);
  const centerPrimeX = coefficient * radiusX * halfY / radiusY;
  const centerPrimeY = -coefficient * radiusY * halfX / radiusX;
  const center = {
    x: (start.x + end.x) / 2 + centerPrimeX,
    y: (start.y + end.y) / 2 + centerPrimeY,
  };
  const startVector = {
    x: (start.x - center.x) / radiusX,
    y: (start.y - center.y) / radiusY,
  };
  const endVector = {
    x: (end.x - center.x) / radiusX,
    y: (end.y - center.y) / radiusY,
  };
  const startAngle = Math.atan2(startVector.y, startVector.x) * 180 / Math.PI;
  let sweepAngle = vectorAngle(startVector, endVector) * 180 / Math.PI;
  if (!sweep && sweepAngle > 0) sweepAngle -= 360;
  if (sweep && sweepAngle < 0) sweepAngle += 360;
  return { center, radiusX, radiusY, startAngle, sweepAngle };
}

function vectorAngle(from: Point, to: Point): number {
  return Math.atan2(from.x * to.y - from.y * to.x, from.x * to.x + from.y * to.y);
}

function localCustomPoint(
  point: CustomGeometryPoint,
  offsetX: number,
  offsetY: number,
): CustomGeometryPoint {
  if ("close" in point) return point;
  if (!("curve" in point)) return { ...point, x: Number(point.x) - offsetX, y: Number(point.y) - offsetY };
  if (point.curve.type === "cubic") return {
    x: Number(point.x) - offsetX,
    y: Number(point.y) - offsetY,
    curve: {
      ...point.curve,
      x1: Number(point.curve.x1) - offsetX,
      x2: Number(point.curve.x2) - offsetX,
      y1: Number(point.curve.y1) - offsetY,
      y2: Number(point.curve.y2) - offsetY,
    },
  };
  if (point.curve.type === "quadratic") return {
    x: Number(point.x) - offsetX,
    y: Number(point.y) - offsetY,
    curve: {
      ...point.curve,
      x1: Number(point.curve.x1) - offsetX,
      y1: Number(point.curve.y1) - offsetY,
    },
  };
  return { ...point, x: Number(point.x) - offsetX, y: Number(point.y) - offsetY };
}

function edgeLine(
  edge: DiagramEdge,
  includeStartArrow: boolean,
  includeEndArrow: boolean,
): PptxGenJS.ShapeLineProps {
  const opacity = edge.stroke?.opacity;
  return {
    color: normalizePptxColor(edge.stroke?.color ?? edge.color) ?? "333333",
    dashType: pptxDash(effectiveDashKind(edge)),
    width: Math.max(edge.stroke?.width ?? edge.strokeWidth ?? 1.5, 0.5),
    ...(opacity !== undefined && Number.isFinite(opacity)
      ? { transparency: Math.round((1 - Math.min(1, Math.max(0, opacity))) * 100) }
      : {}),
    ...(includeStartArrow && edge.startArrow && edge.startArrow !== "none"
      ? { beginArrowType: pptxArrow(edge.startArrow) }
      : {}),
    ...(includeEndArrow && edge.endArrow && edge.endArrow !== "none"
      ? { endArrowType: pptxArrow(edge.endArrow) }
      : {}),
  };
}

function pptxStrokeDiagnostics(edge: DiagramEdge): ConversionDiagnostic[] {
  if (edge.stroke?.dashOffset === undefined
    && edge.stroke?.lineCap === undefined
    && edge.stroke?.lineJoin === undefined) {
    return [];
  }
  return [{
    code: "PPTX_EDGE_STYLE_DOWNGRADED",
    elementId: edge.id,
    message: "PowerPoint preserves this edge's basic stroke and dash pattern, but not SVG dash offset, line cap, or line join semantics.",
    severity: "warning",
  }];
}

function finitePoint(point: Point): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

function samePoint(left: Point, right: Point): boolean {
  return Math.abs(left.x - right.x) < 0.000001 && Math.abs(left.y - right.y) < 0.000001;
}

function pptxDash(dash: DiagramLineDash | undefined): "solid" | "dash" | "sysDot" {
  return dash === "dot" ? "sysDot" : dash === "dash" ? "dash" : "solid";
}

function pptxArrow(arrow: DiagramArrowKind): "none" | "arrow" | "diamond" | "oval" | "triangle" {
  return arrow;
}

function addEditableText(
  slide: PptxGenJS.Slide,
  text: DiagramText,
  options: ConversionOptions,
  scale: number,
  offsetX: number,
  offsetY: number,
  objectName: string,
): void {
  slide.addText(text.text, {
    objectName,
    x: offsetX + text.bounds.x * scale,
    y: offsetY + text.bounds.y * scale,
    w: Math.max(text.bounds.width * scale, 0.08),
    h: Math.max(text.bounds.height * scale, 0.08),
    align: "center",
    valign: "middle",
    fit: "shrink",
    margin: 0,
    color: normalizePptxColor(text.color) ?? "202830",
    fontFace: normalizeFontFamily(options.fontFamily ?? text.fontFamily) ?? "Arial",
    fontSize: scaledFontSize(text, scale),
  });
}

function scaledFontSize(text: DiagramText, scale: number): number {
  return Math.max((text.fontSize ?? 16) * scale * 72, 6);
}
