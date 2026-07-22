import type {
  ExportBounds,
  ExportDiagram,
  ExportEdge,
  ExportGroup,
  ExportNode,
  ExportPoint,
} from "./model.js";
import { effectiveDashKind, nonZeroDashArray } from "../stroke-style.js";
import { assertUniqueIds, number, stableId, styleColor, styleFontFamily, xml } from "./xml.js";
import {
  exporterFailure,
  exporterResult,
  unsupportedMermaidDiagramResult,
} from "./result.js";

export interface DrawioExportOptions extends DiagramExportOptions {
  readonly connectionTolerance?: number;
  readonly inferConnections?: boolean;
  readonly pageName?: string;
}

/** Public high-level draw.io exporter using the shared exporter/result contract. */
export const drawioExporter: DiagramExporter<string, DrawioExportOptions> = {
  format: "drawio",
  export(diagram, options = {}) {
    const unsupported = unsupportedMermaidDiagramResult(diagram, "drawio");
    if (unsupported) return unsupported;
    const diagnostics = drawioDiagnostics(diagram, options);
    try {
      return exporterResult(diagram, exportDiagramToDrawio(diagram, options), diagnostics);
    } catch (error) {
      return exporterFailure(diagram, "drawio", error);
    }
  },
};

/** Serialize target-neutral diagram geometry as an uncompressed draw.io file. */
export function exportDiagramToDrawio(
  diagram: ExportDiagram,
  options: DrawioExportOptions = {},
): string {
  if (options.backgroundColor !== undefined) {
    diagram = { ...diagram, backgroundColor: options.backgroundColor };
  }
  assertCanvas(diagram);
  assertUniqueIds("node", diagram.nodes);
  assertUniqueIds("edge", diagram.edges);
  assertUniqueIds("group", diagram.groups ?? []);
  const pageName = options.pageName ?? "Page-1";
  const nodeIds = new Map(diagram.nodes.map((node) => [node.id, stableId("node", node.id)]));
  const groups = diagram.groups ?? [];
  const groupIds = new Map(groups.map((group) => [group.id, stableId("group", group.id)]));
  const tolerance = options.connectionTolerance ?? 8;
  const inferConnections = options.inferConnections ?? true;
  const layeredCells: DrawioLayerItem[] = [
    ...orderedGroups(groups).map((group, index) => ({
      cell: groupCell(group, groups, groupIds),
      id: `group:${group.id}`,
      order: index,
      zIndex: drawioZ(group.zIndex, 0, `group ${group.id}`),
    })),
    ...diagram.edges.map((edge, index) => ({
      cell: edgeCell(edge, diagram.nodes, nodeIds, inferConnections, tolerance),
      id: `edge:${edge.id}`,
      order: 1_000_000 + index,
      zIndex: drawioZ(edge.zIndex, 100, `edge ${edge.id}`),
    })),
    ...diagram.nodes.map((node, index) => ({
      cell: nodeCell(node, nodeIds.get(node.id)!, groups, groupIds),
      id: `node:${node.id}`,
      order: 2_000_000 + index,
      zIndex: drawioZ(node.zIndex, 200, `node ${node.id}`),
    })),
    ...(groups.flatMap((group, index) => !group.text ? [] : [{
      cell: textCell(group.text, "group", group.id),
      id: `group-label:${group.id}`,
      order: 3_000_000 + index,
      zIndex: drawioZ(group.text.zIndex, 300, `group ${group.id} label`),
    }])),
    ...(diagram.edges.flatMap((edge, index) => !edge.label ? [] : [{
      cell: textCell(edge.label, "edge", edge.id),
      id: `edge-label:${edge.id}`,
      order: 4_000_000 + index,
      zIndex: drawioZ(edge.label.zIndex, 300, `edge ${edge.id} label`),
    }])),
    ...(diagram.nodes.flatMap((node, index) => !node.text ? [] : [{
      cell: textCell(node.text, "node", node.id),
      id: `node-label:${node.id}`,
      order: 5_000_000 + index,
      zIndex: drawioZ(node.text.zIndex, 300, `node ${node.id} label`),
    }])),
  ].sort((left, right) => left.zIndex - right.zIndex
    || left.order - right.order
    || left.id.localeCompare(right.id));
  const cells = [
    '        <mxCell id="0"/>',
    '        <mxCell id="1" parent="0"/>',
    ...layeredCells.map(({ cell }) => cell),
  ];

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<mxfile host="mmd2pptx" compressed="false">',
    `  <diagram id="${stableId("page", pageName)}" name="${xml(pageName)}">`,
    `    <mxGraphModel page="1" pageWidth="${number(diagram.width, "diagram.width")}" pageHeight="${number(diagram.height, "diagram.height")}" grid="1" gridSize="10">`,
    "      <root>",
    ...cells,
    "      </root>",
    "    </mxGraphModel>",
    "  </diagram>",
    "</mxfile>",
  ].join("\n");
}

interface DrawioLayerItem {
  cell: string;
  id: string;
  order: number;
  zIndex: number;
}

function drawioZ(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) throw new TypeError(`${label} zIndex must be finite.`);
  return value;
}

function nodeCell(
  node: ExportNode,
  id: string,
  groups: readonly ExportGroup[],
  groupIds: ReadonlyMap<string, string>,
): string {
  const { bounds } = node;
  assertBounds(bounds, `node ${node.id}`);
  const label = "";
  const style = nodeStyle(node);
  const parent = resolveGroup(node.parentId, groups);
  const x = bounds.x - (parent?.bounds.x ?? 0);
  const y = bounds.y - (parent?.bounds.y ?? 0);
  return [
    `        <mxCell id="${id}" data-source-id="${xml(node.id)}" value="${label}" style="${xml(style)}" vertex="1" parent="${parent ? groupIds.get(parent.id)! : "1"}">`,
    `          <mxGeometry x="${number(x)}" y="${number(y)}" width="${number(bounds.width)}" height="${number(bounds.height)}" as="geometry"/>`,
    "        </mxCell>",
  ].join("\n");
}

function groupCell(
  group: ExportGroup,
  groups: readonly ExportGroup[],
  groupIds: ReadonlyMap<string, string>,
): string {
  assertBounds(group.bounds, `group ${group.id}`);
  const parent = resolveGroup(group.parentId, groups);
  const style = [
    "container=1",
    "recursiveResize=0",
    "collapsible=0",
    "whiteSpace=wrap",
    "html=1",
    "rounded=1",
    `fillColor=${styleColor(group.fill, "none")}`,
    `strokeColor=${styleColor(group.stroke, "#777777")}`,
    `strokeWidth=${number(group.strokeWidth ?? 1)}`,
    `fontColor=${styleColor(group.text?.color, "#222222")}`,
    `fontFamily=${styleFontFamily(group.text?.fontFamily)}`,
    `fontSize=${number(group.text?.fontSize ?? 14)}`,
  ].join(";") + ";";
  return [
    `        <mxCell id="${groupIds.get(group.id)!}" data-source-id="${xml(group.id)}" data-diagram-group="true" value="" style="${xml(style)}" vertex="1" parent="${parent ? groupIds.get(parent.id)! : "1"}">`,
    `          <mxGeometry x="${number(group.bounds.x - (parent?.bounds.x ?? 0))}" y="${number(group.bounds.y - (parent?.bounds.y ?? 0))}" width="${number(group.bounds.width)}" height="${number(group.bounds.height)}" as="geometry"/>`,
    "        </mxCell>",
  ].join("\n");
}

function textCell(text: NonNullable<ExportNode["text"]>, ownerKind: string, ownerId: string): string {
  assertBounds(text.bounds, `${ownerKind} ${ownerId} label`);
  const style = [
    "text",
    "html=1",
    "strokeColor=none",
    "fillColor=none",
    "align=center",
    "verticalAlign=middle",
    "whiteSpace=wrap",
    `fontColor=${styleColor(text.color, "#222222")}`,
    `fontFamily=${styleFontFamily(text.fontFamily)}`,
    `fontSize=${number(text.fontSize ?? 14)}`,
  ].join(";") + ";";
  return [
    `        <mxCell id="${stableId(`${ownerKind}-label`, ownerId)}" data-label-for="${xml(ownerId)}" value="${drawioLabel(text.text)}" style="${xml(style)}" vertex="1" connectable="0" parent="1">`,
    `          <mxGeometry x="${number(text.bounds.x)}" y="${number(text.bounds.y)}" width="${number(text.bounds.width)}" height="${number(text.bounds.height)}" as="geometry"/>`,
    "        </mxCell>",
  ].join("\n");
}

function resolveGroup(
  identity: string | undefined,
  groups: readonly ExportGroup[],
): ExportGroup | undefined {
  return identity
    ? groups.find((group) => group.id === identity
      || group.semanticId === identity
      || group.sourceKey === identity)
    : undefined;
}

function orderedGroups(groups: readonly ExportGroup[]): ExportGroup[] {
  const ordered: ExportGroup[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (group: ExportGroup): void => {
    if (visited.has(group.id) || visiting.has(group.id)) return;
    visiting.add(group.id);
    const parent = resolveGroup(group.parentId, groups);
    if (parent) visit(parent);
    visiting.delete(group.id);
    visited.add(group.id);
    ordered.push(group);
  };
  groups.forEach(visit);
  return ordered;
}

function edgeCell(
  edge: ExportEdge,
  nodes: readonly ExportNode[],
  nodeIds: ReadonlyMap<string, string>,
  inferConnections: boolean,
  tolerance: number,
): string {
  const id = stableId("edge", edge.id);
  const pathPoints = edge.path?.segments.flatMap((segment) =>
    segment.kind === "close" ? [] : [segment.to]);
  const points = pathPoints && pathPoints.length >= 2
    ? pathPoints
    : edge.points && edge.points.length >= 2
    ? edge.points
    : [edge.start, edge.end];
  points.forEach((point, index) => assertPoint(point, `edge ${edge.id} point ${index}`));
  const sourceId = resolveNodeId(edge.sourceId, edge.start, nodes, inferConnections, tolerance);
  const targetId = resolveNodeId(edge.targetId, edge.end, nodes, inferConnections, tolerance);
  const source = sourceId ? nodeIds.get(sourceId) : undefined;
  const target = targetId ? nodeIds.get(targetId) : undefined;
  const terminals = `${source ? ` source="${source}"` : ""}${target ? ` target="${target}"` : ""}`;
  const intermediate = points.slice(1, -1);
  const orthogonal = intermediate.length > 0 && isOrthogonal(points);
  const geometry = [
    '          <mxGeometry relative="1" as="geometry">',
    !source ? `            <mxPoint x="${number(edge.start.x)}" y="${number(edge.start.y)}" as="sourcePoint"/>` : undefined,
    intermediate.length > 0 ? "            <Array as=\"points\">" : undefined,
    ...intermediate.map((point) => `              <mxPoint x="${number(point.x)}" y="${number(point.y)}"/>`),
    intermediate.length > 0 ? "            </Array>" : undefined,
    !target ? `            <mxPoint x="${number(edge.end.x)}" y="${number(edge.end.y)}" as="targetPoint"/>` : undefined,
    "          </mxGeometry>",
  ].filter((line): line is string => line !== undefined);

  return [
    `        <mxCell id="${id}" data-source-id="${xml(edge.id)}" value="" style="${xml(edgeStyle(edge, orthogonal))}" edge="1" parent="1"${terminals}>`,
    ...geometry,
    "        </mxCell>",
  ].join("\n");
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
  if (!infer) {
    return undefined;
  }
  let best: { distance: number; id: string } | undefined;
  for (const node of nodes) {
    const distance = distanceToBounds(endpoint, node.bounds);
    if (distance <= tolerance && (!best || distance < best.distance)) {
      best = { distance, id: node.id };
    }
  }
  return best?.id;
}

function distanceToBounds(point: ExportPoint, bounds: ExportBounds): number {
  const dx = Math.max(bounds.x - point.x, 0, point.x - (bounds.x + bounds.width));
  const dy = Math.max(bounds.y - point.y, 0, point.y - (bounds.y + bounds.height));
  return Math.hypot(dx, dy);
}

function nodeStyle(node: ExportNode): string {
  const common = [
    "whiteSpace=wrap",
    "html=1",
    `fillColor=${styleColor(node.fill, "#ffffff")}`,
    `strokeColor=${styleColor(node.stroke, "#333333")}`,
    `strokeWidth=${number(node.strokeWidth ?? 1)}`,
    `fontColor=${styleColor(node.text?.color, "#222222")}`,
    `fontFamily=${styleFontFamily(node.text?.fontFamily)}`,
    `fontSize=${number(node.text?.fontSize ?? 14)}`,
  ];
  switch (node.kind) {
    case "roundRect": common.push("rounded=1"); break;
    case "ellipse": common.push("ellipse"); break;
    case "diamond": common.push("rhombus"); break;
    case "hexagon": common.push("shape=hexagon", "perimeter=hexagonPerimeter2"); break;
    case "parallelogram": common.push("shape=parallelogram", "perimeter=parallelogramPerimeter"); break;
    case "trapezoid": common.push("shape=trapezoid", "perimeter=trapezoidPerimeter"); break;
    case "cylinder": common.push("shape=cylinder3", "boundedLbl=1", "backgroundOutline=1"); break;
    default: common.push("rounded=0");
  }
  return `${common.join(";")};`;
}

function edgeStyle(edge: ExportEdge, orthogonal: boolean): string {
  const dashKind = effectiveDashKind(edge);
  const dash = dashKind === "dash" ? ["dashed=1", "dashPattern=8 5"]
    : dashKind === "dot" ? ["dashed=1", "dashPattern=2 4"]
      : ["dashed=0"];
  const dashArray = nonZeroDashArray(edge.stroke?.dashArray);
  const values = [
    orthogonal ? "edgeStyle=orthogonalEdgeStyle" : "edgeStyle=none",
    "html=1",
    "rounded=0",
    `strokeColor=${styleColor(edge.stroke?.color ?? edge.color, "#333333")}`,
    `strokeWidth=${number(edge.stroke?.width ?? edge.strokeWidth ?? 1.5)}`,
    `startArrow=${drawioArrow(edge.startArrow)}`,
    `endArrow=${drawioArrow(edge.endArrow)}`,
    ...(dashArray
      ? ["dashed=1", `dashPattern=${dashArray.map((value) => number(value)).join(" ")}`]
      : dash),
  ];
  if (edge.stroke?.opacity !== undefined) {
    values.push(`opacity=${number(edge.stroke.opacity * 100)}`);
  }
  return `${values.join(";")};`;
}

function drawioArrow(kind: ExportEdge["endArrow"]): string {
  switch (kind) {
    case "arrow": return "open";
    case "triangle": return "block";
    case "diamond": return "diamond";
    case "oval": return "oval";
    default: return "none";
  }
}

function isOrthogonal(points: readonly ExportPoint[]): boolean {
  return points.slice(1).every((point, index) => {
    const previous = points[index];
    if (!previous) return false;
    return Math.abs(point.x - previous.x) < 1e-6
      || Math.abs(point.y - previous.y) < 1e-6;
  });
}

function nodeIdentityMatches(node: ExportNode, id: string): boolean {
  return node.id === id || node.semanticId === id || node.sourceKey === id;
}

function drawioLabel(value: string): string {
  // draw.io cell values are HTML embedded inside an XML attribute. Escape the
  // user's text for HTML first, then escape that encoded value for XML. Only
  // the separator we add is allowed to become a draw.io <br> element.
  return xml(value.split(/\r?\n/).map(xml).join("<br>"));
}

function assertCanvas(diagram: ExportDiagram): void {
  if (!(diagram.width > 0) || !(diagram.height > 0)) {
    throw new RangeError("Diagram width and height must be positive finite numbers.");
  }
  number(diagram.width, "diagram.width");
  number(diagram.height, "diagram.height");
}

function drawioDiagnostics(
  diagram: DiagramIR,
  options: DrawioExportOptions,
): ConversionDiagnostic[] {
  const diagnostics: ConversionDiagnostic[] = [];
  if (options.backgroundColor ?? diagram.backgroundColor) {
    diagnostics.push({
      code: "DRAWIO_BACKGROUND_DOWNGRADED",
      message: "The draw.io exporter does not currently preserve the diagram background color.",
      severity: "warning",
    });
  }
  for (const edge of diagram.edges) {
    if (edge.path?.segments.some(({ kind }) =>
      kind === "arc" || kind === "cubic" || kind === "quadratic")) {
      diagnostics.push({
        code: "DRAWIO_EDGE_PATH_DOWNGRADED",
        elementId: edge.id,
        message: "Curved canonical path segments were reduced to editable draw.io waypoints.",
        severity: "warning",
      });
    }
    if (edge.sourcePort || edge.targetPort) {
      diagnostics.push({
        code: "DRAWIO_PORT_DOWNGRADED",
        elementId: edge.id,
        message: "The edge remains connected to its nodes, but named port identity is not preserved.",
        severity: "warning",
      });
    }
    if (edge.stroke?.dashOffset !== undefined || edge.stroke?.lineCap || edge.stroke?.lineJoin) {
      diagnostics.push({
        code: "DRAWIO_EDGE_STYLE_DOWNGRADED",
        elementId: edge.id,
        message: "draw.io preserves basic stroke styling but not dash offset, line cap, or line join.",
        severity: "warning",
      });
    }
    const tolerance = options.connectionTolerance ?? 8;
    const infer = options.inferConnections ?? true;
    if (!endpointResolves(edge.sourceId, edge.start, diagram.nodes, infer, tolerance)
      || !endpointResolves(edge.targetId, edge.end, diagram.nodes, infer, tolerance)) {
      diagnostics.push({
        code: "DRAWIO_EDGE_CONNECTIVITY_DOWNGRADED",
        elementId: edge.id,
        message: "A node endpoint could not be resolved; draw.io stores it as detached geometry.",
        severity: "warning",
      });
    }
  }
  return diagnostics;
}

function endpointResolves(
  explicitId: string | undefined,
  point: ExportPoint,
  nodes: readonly ExportNode[],
  infer: boolean,
  tolerance: number,
): boolean {
  if (explicitId !== undefined) return nodes.some((node) => nodeIdentityMatches(node, explicitId));
  return infer && nodes.some(({ bounds }) => distanceToBounds(point, bounds) <= tolerance);
}

function assertBounds(bounds: ExportBounds, label: string): void {
  assertPoint(bounds, label);
  if (!(bounds.width >= 0) || !(bounds.height >= 0)) {
    throw new RangeError(`${label} width and height must be non-negative.`);
  }
  number(bounds.width, `${label} width`);
  number(bounds.height, `${label} height`);
}

function assertPoint(point: ExportPoint, label: string): void {
  number(point.x, `${label} x`);
  number(point.y, `${label} y`);
}
import type {
  DiagramExporter,
  DiagramExportOptions,
} from "../export-contract.js";
import type { ConversionDiagnostic, DiagramIR } from "../types.js";
