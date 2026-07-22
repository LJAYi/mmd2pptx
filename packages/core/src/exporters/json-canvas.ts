import type {
  DiagramExporter,
  DiagramExportOptions,
} from "../export-contract.js";
import type { ConversionDiagnostic, ConversionResult, DiagramIR } from "../types.js";
import type {
  ExportBounds,
  ExportDiagram,
  ExportEdge,
  ExportNode,
  ExportPoint,
} from "./model.js";
import { assertUniqueIds, stableId } from "./xml.js";
import { exporterFailure, unsupportedMermaidDiagramResult } from "./result.js";

export type JsonCanvasSide = "top" | "right" | "bottom" | "left";
export type JsonCanvasEnd = "none" | "arrow";

export interface JsonCanvasNode {
  readonly color?: string;
  readonly height: number;
  readonly id: string;
  readonly text: string;
  readonly type: "text";
  readonly width: number;
  readonly x: number;
  readonly y: number;
}

export interface JsonCanvasEdge {
  readonly color?: string;
  readonly fromEnd: JsonCanvasEnd;
  readonly fromNode: string;
  readonly fromSide?: JsonCanvasSide;
  readonly id: string;
  readonly label?: string;
  readonly toEnd: JsonCanvasEnd;
  readonly toNode: string;
  readonly toSide?: JsonCanvasSide;
}

export interface JsonCanvasDocument {
  readonly edges: readonly JsonCanvasEdge[];
  readonly nodes: readonly JsonCanvasNode[];
}

export interface JsonCanvasExportOptions extends DiagramExportOptions {
  readonly connectionTolerance?: number;
  readonly indent?: number;
  readonly inferConnections?: boolean;
}

/** Public high-level JSON Canvas exporter using the shared exporter/result contract. */
export const jsonCanvasExporter: DiagramExporter<string, JsonCanvasExportOptions> = {
  format: "json-canvas",
  export(diagram, options = {}) {
    try {
      return exportDiagramToJsonCanvas(diagram, options);
    } catch (error) {
      return exporterFailure(diagram, "json-canvas", error);
    }
  },
};

/**
 * Serialize Diagram IR to the open JSON Canvas 1.0 shape.
 *
 * JSON Canvas deliberately has no arbitrary path or rich stroke model. Those
 * losses are reported per element so callers can surface them before export.
 */
export function exportDiagramToJsonCanvas(
  diagram: ExportDiagram | DiagramIR,
  options: JsonCanvasExportOptions = {},
): ConversionResult<string> {
  const unsupported = unsupportedMermaidDiagramResult(diagram, "json-canvas");
  if (unsupported) return unsupported;
  if (options.backgroundColor !== undefined) {
    diagram = { ...diagram, backgroundColor: options.backgroundColor };
  }
  const diagnostics: ConversionDiagnostic[] = [];
  assertCanvas(diagram);
  assertUniqueIds("node", diagram.nodes);
  assertUniqueIds("edge", diagram.edges);
  assertUniqueIds("group", diagram.groups ?? []);
  for (const group of diagram.groups ?? []) {
    reportZIndex(group.id, group.zIndex, group.text?.zIndex, diagnostics);
    diagnostics.push({
      code: "JSON_CANVAS_GROUP_UNSUPPORTED",
      elementId: group.id,
      message: "JSON Canvas 1.0 has no portable group/container object; this subgraph was omitted.",
      severity: "warning",
    });
  }
  if (diagram.backgroundColor) {
    diagnostics.push({
      code: "JSON_CANVAS_BACKGROUND_DOWNGRADED",
      message: "JSON Canvas has no document background color field.",
      severity: "warning",
    });
  }
  const nodeIds = new Map(diagram.nodes.map((node) => [node.id, stableId("node", node.id)]));
  for (const node of diagram.nodes) reportZIndex(node.id, node.zIndex, node.text?.zIndex, diagnostics);
  for (const edge of diagram.edges) reportZIndex(edge.id, edge.zIndex, edge.label?.zIndex, diagnostics);
  const nodes = diagram.nodes.map((node) => jsonCanvasNode(node, nodeIds.get(node.id)!, diagnostics));
  const edges: JsonCanvasEdge[] = [];
  const infer = options.inferConnections ?? true;
  const tolerance = options.connectionTolerance ?? 8;

  for (const edge of diagram.edges) {
    assertPoint(edge.start, `edge ${edge.id} start`);
    assertPoint(edge.end, `edge ${edge.id} end`);
    edge.points?.forEach((point, index) => assertPoint(point, `edge ${edge.id} point ${index}`));
    const sourceId = resolveNodeId(edge.sourceId, edge.start, diagram.nodes, infer, tolerance);
    const targetId = resolveNodeId(edge.targetId, edge.end, diagram.nodes, infer, tolerance);
    const fromNode = sourceId ? nodeIds.get(sourceId) : undefined;
    const toNode = targetId ? nodeIds.get(targetId) : undefined;
    if (!fromNode || !toNode) {
      diagnostics.push({
        code: "JSON_CANVAS_EDGE_ENDPOINT_UNRESOLVED",
        elementId: edge.id,
        message: "JSON Canvas requires both edge endpoints to reference nodes; this edge was omitted.",
        severity: "warning",
      });
      continue;
    }

    const sourceNode = diagram.nodes.find((node) => node.id === sourceId);
    const targetNode = diagram.nodes.find((node) => node.id === targetId);
    const fromSide = resolveSide(edge.sourcePort, edge.start, sourceNode?.bounds, edge.id, "source", diagnostics);
    const toSide = resolveSide(edge.targetPort, edge.end, targetNode?.bounds, edge.id, "target", diagnostics);
    const fromEnd = mapEnd(edge.startArrow, edge.id, "start", diagnostics);
    const toEnd = mapEnd(edge.endArrow, edge.id, "end", diagnostics);
    reportEdgeDegradations(edge, diagnostics);

    const color = jsonCanvasColor(
      edge.stroke?.color ?? edge.color,
      edge.id,
      "edge",
      diagnostics,
    );
    edges.push({
      ...(color ? { color } : {}),
      fromEnd,
      fromNode,
      ...(fromSide ? { fromSide } : {}),
      id: stableId("edge", edge.id),
      ...(edge.label?.text ? { label: edge.label.text } : {}),
      toEnd,
      toNode,
      ...(toSide ? { toSide } : {}),
    });
  }

  const document: JsonCanvasDocument = { edges, nodes };
  const fallbackIds = new Set(
    diagnostics
      .filter(({ severity, elementId }) => severity !== "info" && elementId)
      .map(({ elementId }) => elementId!),
  );
  return {
    data: JSON.stringify(document, undefined, normalizeIndent(options.indent)),
    diagnostics,
    summary: {
      editableObjects: nodes.length + edges.length,
      edges: edges.length,
      fallbackObjects: fallbackIds.size,
      nodes: nodes.length,
    },
  };
}

function reportZIndex(
  elementId: string,
  objectZIndex: number | undefined,
  labelZIndex: number | undefined,
  diagnostics: ConversionDiagnostic[],
): void {
  if (objectZIndex === undefined && labelZIndex === undefined) return;
  diagnostics.push({
    code: "JSON_CANVAS_Z_INDEX_UNSUPPORTED",
    elementId,
    message: "JSON Canvas 1.0 has no reliable z-order field; this object's explicit zIndex was omitted.",
    severity: "warning",
  });
}

function jsonCanvasNode(
  node: ExportNode,
  id: string,
  diagnostics: ConversionDiagnostic[],
): JsonCanvasNode {
  validateBounds(node.bounds, node.id);
  if (node.kind !== "rect" && node.kind !== "roundRect") {
    diagnostics.push({
      code: "JSON_CANVAS_NODE_SHAPE_DOWNGRADED",
      elementId: node.id,
      message: `JSON Canvas text cards cannot preserve the ${node.kind} node shape.`,
      severity: "warning",
    });
  }
  if (node.stroke || node.strokeWidth !== undefined || node.text?.color
    || node.text?.fontFamily || node.text?.fontSize !== undefined) {
    diagnostics.push({
      code: "JSON_CANVAS_NODE_STYLE_DOWNGRADED",
      elementId: node.id,
      message: "JSON Canvas does not support this node's border or rich text style.",
      severity: "warning",
    });
  }
  const color = jsonCanvasColor(node.fill, node.id, "node", diagnostics);
  return {
    ...(color ? { color } : {}),
    height: node.bounds.height,
    id,
    text: node.text?.text ?? node.id,
    type: "text",
    width: node.bounds.width,
    x: node.bounds.x,
    y: node.bounds.y,
  };
}

const JSON_CANVAS_NAMED_COLORS: Readonly<Record<string, string>> = {
  black: "#000000",
  blue: "#0000ff",
  gray: "#808080",
  grey: "#808080",
  green: "#008000",
  orange: "#ffa500",
  purple: "#800080",
  red: "#ff0000",
  white: "#ffffff",
  yellow: "#ffff00",
};

/** Return only colors permitted by the JSON Canvas 1.0 schema. */
function jsonCanvasColor(
  value: string | undefined,
  elementId: string,
  elementKind: "edge" | "node",
  diagnostics: ConversionDiagnostic[],
): string | undefined {
  if (value === undefined) return undefined;
  const color = value.trim();
  if (/^[1-6]$/.test(color)) return color;
  if (/^#[0-9a-f]{6}$/i.test(color)) return color.toLowerCase();
  if (/^[0-9a-f]{6}$/i.test(color)) return `#${color.toLowerCase()}`;
  if (/^#?[0-9a-f]{3}$/i.test(color)) {
    const hex = color.replace(/^#/, "").toLowerCase();
    const expanded = `#${[...hex].map((digit) => digit + digit).join("")}`;
    diagnostics.push({
      code: "JSON_CANVAS_COLOR_NORMALIZED",
      elementId,
      message: `The ${elementKind} color '${value}' was expanded to JSON Canvas #RRGGBB form.`,
      severity: "warning",
    });
    return expanded;
  }
  const named = JSON_CANVAS_NAMED_COLORS[color.toLowerCase()];
  diagnostics.push({
    code: named ? "JSON_CANVAS_COLOR_MAPPED" : "JSON_CANVAS_COLOR_OMITTED",
    elementId,
    message: named
      ? `The named ${elementKind} color '${value}' was mapped to '${named}' for JSON Canvas 1.0.`
      : `The ${elementKind} color '${value}' is not a JSON Canvas 1.0 #RRGGBB or preset color and was omitted.`,
    severity: "warning",
  });
  return named;
}

function reportEdgeDegradations(
  edge: ExportEdge,
  diagnostics: ConversionDiagnostic[],
): void {
  const hasRoutedPath = Boolean(edge.path)
    || Boolean(edge.points && edge.points.length > 2);
  if (hasRoutedPath) {
    diagnostics.push({
      code: "JSON_CANVAS_EDGE_PATH_DOWNGRADED",
      elementId: edge.id,
      message: "JSON Canvas stores edge connectivity but not custom paths or waypoints.",
      severity: "warning",
    });
  }
  const stroke = edge.stroke;
  if (edge.dash && edge.dash !== "solid" || edge.strokeWidth !== undefined
    || stroke?.width !== undefined || stroke?.dashArray?.length
    || stroke?.dashOffset !== undefined || stroke?.lineCap
    || stroke?.lineJoin || stroke?.opacity !== undefined) {
    diagnostics.push({
      code: "JSON_CANVAS_EDGE_STYLE_DOWNGRADED",
      elementId: edge.id,
      message: "JSON Canvas preserves edge color but not custom stroke geometry or dash style.",
      severity: "warning",
    });
  }
  if (edge.label && (
    edge.label.color || edge.label.fontFamily || edge.label.fontSize !== undefined
  )) {
    diagnostics.push({
      code: "JSON_CANVAS_EDGE_LABEL_STYLE_DOWNGRADED",
      elementId: edge.id,
      message: "JSON Canvas preserves the edge label text but not its text style or position.",
      severity: "warning",
    });
  }
}

function mapEnd(
  arrow: ExportEdge["endArrow"],
  edgeId: string,
  endpoint: "start" | "end",
  diagnostics: ConversionDiagnostic[],
): JsonCanvasEnd {
  if (!arrow || arrow === "none") return "none";
  if (arrow === "arrow" || arrow === "triangle") return "arrow";
  diagnostics.push({
    code: "JSON_CANVAS_ARROW_DOWNGRADED",
    elementId: edgeId,
    message: `JSON Canvas cannot preserve the ${arrow} ${endpoint} marker; it was mapped to an arrow.`,
    severity: "warning",
  });
  return "arrow";
}

function resolveSide(
  port: string | undefined,
  endpoint: ExportPoint,
  bounds: ExportBounds | undefined,
  edgeId: string,
  terminal: "source" | "target",
  diagnostics: ConversionDiagnostic[],
): JsonCanvasSide | undefined {
  if (port) {
    const mapped = portSide(port);
    if (mapped) return mapped;
    diagnostics.push({
      code: "JSON_CANVAS_PORT_DOWNGRADED",
      elementId: edgeId,
      message: `The ${terminal} port '${port}' has no JSON Canvas side mapping; geometry inference was used.`,
      severity: "warning",
    });
  }
  return bounds ? closestSide(endpoint, bounds) : undefined;
}

function portSide(port: string): JsonCanvasSide | undefined {
  const token = port.trim().toLowerCase().split(/[:/.]/).at(-1);
  switch (token) {
    case "top": case "north": case "n": return "top";
    case "right": case "east": case "e": return "right";
    case "bottom": case "south": case "s": return "bottom";
    case "left": case "west": case "w": return "left";
    default: return undefined;
  }
}

function closestSide(point: ExportPoint, bounds: ExportBounds): JsonCanvasSide {
  const distances: readonly [JsonCanvasSide, number][] = [
    ["top", Math.abs(point.y - bounds.y)],
    ["right", Math.abs(point.x - (bounds.x + bounds.width))],
    ["bottom", Math.abs(point.y - (bounds.y + bounds.height))],
    ["left", Math.abs(point.x - bounds.x)],
  ];
  return [...distances].sort((left, right) => left[1] - right[1])[0]![0];
}

function resolveNodeId(
  explicitId: string | undefined,
  endpoint: ExportPoint,
  nodes: readonly ExportNode[],
  infer: boolean,
  tolerance: number,
): string | undefined {
  if (explicitId !== undefined) {
    return nodes.find((node) => nodeIdentityMatches(node, explicitId))?.id;
  }
  if (!infer) return undefined;
  let best: { distance: number; id: string } | undefined;
  for (const node of nodes) {
    const distance = distanceToBounds(endpoint, node.bounds);
    if (distance <= tolerance && (!best || distance < best.distance)) {
      best = { distance, id: node.id };
    }
  }
  return best?.id;
}

function nodeIdentityMatches(node: ExportNode, id: string): boolean {
  return node.id === id || node.semanticId === id || node.sourceKey === id;
}

function distanceToBounds(point: ExportPoint, bounds: ExportBounds): number {
  const dx = Math.max(bounds.x - point.x, 0, point.x - (bounds.x + bounds.width));
  const dy = Math.max(bounds.y - point.y, 0, point.y - (bounds.y + bounds.height));
  return Math.hypot(dx, dy);
}

function validateBounds(bounds: ExportBounds, nodeId: string): void {
  const values = [bounds.x, bounds.y, bounds.width, bounds.height];
  if (values.some((value) => !Number.isFinite(value))
    || bounds.width < 0 || bounds.height < 0) {
    throw new RangeError(`Node ${nodeId} has invalid JSON Canvas geometry.`);
  }
}

function assertCanvas(diagram: ExportDiagram | DiagramIR): void {
  if (!Number.isFinite(diagram.width) || !Number.isFinite(diagram.height)
    || diagram.width <= 0 || diagram.height <= 0) {
    throw new RangeError("Diagram width and height must be positive finite numbers.");
  }
}

function assertPoint(point: ExportPoint, label: string): void {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new RangeError(`${label} must contain finite coordinates.`);
  }
}

function normalizeIndent(indent: number | undefined): number | undefined {
  if (indent === undefined) return 2;
  if (!Number.isInteger(indent) || indent < 0 || indent > 10) {
    throw new RangeError("JSON indentation must be an integer from 0 to 10.");
  }
  return indent === 0 ? undefined : indent;
}
