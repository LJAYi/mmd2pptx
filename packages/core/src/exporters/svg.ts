import type {
  DiagramExporter,
  DiagramExportOptions,
} from "../export-contract.js";
import type { ConversionDiagnostic, DiagramIR } from "../types.js";
import { svgDashArray } from "../stroke-style.js";
import type {
  ExportBounds,
  ExportDiagram,
  ExportEdge,
  ExportGroup,
  ExportNode,
  ExportPath,
  ExportPathSegment,
  ExportPoint,
  ExportText,
} from "./model.js";
import { assertUniqueIds, number, stableId, styleColor, styleFontFamily, xml } from "./xml.js";
import {
  exporterFailure,
  exporterResult,
  unsupportedMermaidDiagramResult,
} from "./result.js";

export interface SvgExportOptions extends DiagramExportOptions {
  readonly includeXmlDeclaration?: boolean;
  readonly title?: string;
}

/** Public high-level SVG exporter using the shared exporter/result contract. */
export const svgExporter: DiagramExporter<string, SvgExportOptions> = {
  format: "svg",
  export(diagram, options = {}) {
    const unsupported = unsupportedMermaidDiagramResult(diagram, "svg");
    if (unsupported) return unsupported;
    const diagnostics = svgDiagnostics(diagram);
    try {
      return exporterResult(diagram, exportDiagramToSvg(diagram, options), diagnostics);
    } catch (error) {
      return exporterFailure(diagram, "svg", error);
    }
  },
};

/** Serialize target-neutral diagram geometry as a deterministic standalone SVG. */
export function exportDiagramToSvg(
  diagram: ExportDiagram,
  options: SvgExportOptions = {},
): string {
  if (options.backgroundColor !== undefined) {
    diagram = { ...diagram, backgroundColor: options.backgroundColor };
  }
  assertCanvas(diagram);
  assertUniqueIds("node", diagram.nodes);
  assertUniqueIds("edge", diagram.edges);
  assertUniqueIds("group", diagram.groups ?? []);
  const body: string[] = [];

  if (options.title) {
    body.push(`  <title>${xml(options.title)}</title>`);
  }
  if (diagram.backgroundColor) {
    body.push(
      `  <rect id="diagram-background" x="0" y="0" width="${number(diagram.width, "diagram.width")}" height="${number(diagram.height, "diagram.height")}" style="fill:${xml(styleColor(diagram.backgroundColor, "transparent"))};stroke:none"/>`,
    );
  }

  body.push('  <g id="diagram-objects">');
  body.push(...svgLayerItems(diagram)
    .flatMap(({ lines }) => lines.map((line) => `    ${line}`)));
  body.push("  </g>");

  const declaration = options.includeXmlDeclaration === false
    ? ""
    : '<?xml version="1.0" encoding="UTF-8"?>\n';
  const root = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${number(diagram.width, "diagram.width")} ${number(diagram.height, "diagram.height")}" width="${number(diagram.width, "diagram.width")}" height="${number(diagram.height, "diagram.height")}">`;
  return `${declaration}${root}\n${body.join("\n")}\n</svg>`;
}

interface SvgLayerItem {
  id: string;
  lines: string[];
  order: number;
  zIndex: number;
}

function svgLayerItems(diagram: ExportDiagram): SvgLayerItem[] {
  const items: SvgLayerItem[] = [];
  for (const [index, group] of (diagram.groups ?? []).entries()) {
    items.push({ id: `group:${group.id}`, lines: groupSvg(group), order: index, zIndex: layerZ(group.zIndex, 0, `group ${group.id}`) });
    if (group.text) items.push({ id: `group-label:${group.id}`, lines: labelSvg(group.text, "group", group.id), order: index, zIndex: layerZ(group.text.zIndex, 300, `group ${group.id} label`) });
  }
  for (const [index, edge] of diagram.edges.entries()) {
    items.push({ id: `edge:${edge.id}`, lines: edgeSvg(edge), order: 1_000_000 + index, zIndex: layerZ(edge.zIndex, 100, `edge ${edge.id}`) });
    if (edge.label) items.push({ id: `edge-label:${edge.id}`, lines: labelSvg(edge.label, "edge", edge.id), order: 3_000_000 + index, zIndex: layerZ(edge.label.zIndex, 300, `edge ${edge.id} label`) });
  }
  for (const [index, node] of diagram.nodes.entries()) {
    items.push({ id: `node:${node.id}`, lines: nodeSvg(node), order: 2_000_000 + index, zIndex: layerZ(node.zIndex, 200, `node ${node.id}`) });
    if (node.text) items.push({ id: `node-label:${node.id}`, lines: labelSvg(node.text, "node", node.id), order: 4_000_000 + index, zIndex: layerZ(node.text.zIndex, 300, `node ${node.id} label`) });
  }
  return items.sort((left, right) => left.zIndex - right.zIndex
    || left.order - right.order
    || left.id.localeCompare(right.id));
}

function layerZ(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) throw new TypeError(`${label} zIndex must be finite.`);
  return value;
}

function groupSvg(group: ExportGroup): string[] {
  assertBounds(group.bounds, `group ${group.id}`);
  const id = stableId("group", group.id);
  const style = `fill:${xml(styleColor(group.fill, "transparent"))};stroke:${xml(styleColor(group.stroke, "#777777"))};stroke-width:${number(group.strokeWidth ?? 1, `group ${group.id} strokeWidth`)}`;
  return [
    `<g id="${id}" data-source-id="${xml(group.id)}" data-diagram-group="true"${group.parentId ? ` data-parent-group-id="${xml(group.parentId)}"` : ""}>`,
    `  ${nodeShape("roundRect", group.bounds, style, `${id}-shape`)}`,
    "</g>",
  ];
}

function assertCanvas(diagram: ExportDiagram): void {
  if (!(diagram.width > 0) || !(diagram.height > 0)) {
    throw new RangeError("Diagram width and height must be positive finite numbers.");
  }
  number(diagram.width, "diagram.width");
  number(diagram.height, "diagram.height");
}

function svgDiagnostics(diagram: DiagramIR): ConversionDiagnostic[] {
  const diagnostics: ConversionDiagnostic[] = [];
  for (const edge of diagram.edges) {
    if (edge.sourceId || edge.targetId || edge.sourcePort || edge.targetPort) {
      diagnostics.push({
        code: "SVG_EDGE_CONNECTIVITY_DOWNGRADED",
        elementId: edge.id,
        message: "SVG preserves edge geometry but has no portable editable node attachment model.",
        severity: "warning",
      });
    }
  }
  return diagnostics;
}

function nodeSvg(node: ExportNode): string[] {
  assertBounds(node.bounds, `node ${node.id}`);
  const id = stableId("node", node.id);
  const fill = styleColor(node.fill, "#ffffff");
  const stroke = styleColor(node.stroke, "#333333");
  const strokeWidth = number(node.strokeWidth ?? 1, `node ${node.id} strokeWidth`);
  const style = `fill:${xml(fill)};stroke:${xml(stroke)};stroke-width:${strokeWidth}`;
  const lines = [`<g id="${id}" data-source-id="${xml(node.id)}"${node.parentId ? ` data-parent-group-id="${xml(node.parentId)}"` : ""}>`];
  lines.push(`  ${nodeShape(node.kind, node.bounds, style, `${id}-shape`)}`);
  lines.push("</g>");
  return lines;
}

function nodeShape(kind: string, bounds: ExportBounds, style: string, id: string): string {
  const x = number(bounds.x);
  const y = number(bounds.y);
  const width = number(bounds.width);
  const height = number(bounds.height);
  const cx = number(bounds.x + bounds.width / 2);
  const cy = number(bounds.y + bounds.height / 2);
  const right = number(bounds.x + bounds.width);
  const bottom = number(bounds.y + bounds.height);
  const quarter = bounds.width / 4;

  switch (kind) {
    case "ellipse":
      return `<ellipse id="${id}" cx="${cx}" cy="${cy}" rx="${number(bounds.width / 2)}" ry="${number(bounds.height / 2)}" style="${style}"/>`;
    case "diamond":
      return `<polygon id="${id}" points="${cx},${y} ${right},${cy} ${cx},${bottom} ${x},${cy}" style="${style}"/>`;
    case "hexagon":
      return `<polygon id="${id}" points="${number(bounds.x + quarter)},${y} ${number(bounds.x + 3 * quarter)},${y} ${right},${cy} ${number(bounds.x + 3 * quarter)},${bottom} ${number(bounds.x + quarter)},${bottom} ${x},${cy}" style="${style}"/>`;
    case "parallelogram":
      return `<polygon id="${id}" points="${number(bounds.x + quarter)},${y} ${right},${y} ${number(bounds.x + 3 * quarter)},${bottom} ${x},${bottom}" style="${style}"/>`;
    case "trapezoid":
      return `<polygon id="${id}" points="${number(bounds.x + quarter)},${y} ${number(bounds.x + 3 * quarter)},${y} ${right},${bottom} ${x},${bottom}" style="${style}"/>`;
    case "cylinder":
      return `<path id="${id}" d="M ${x} ${number(bounds.y + bounds.height / 8)} A ${number(bounds.width / 2)} ${number(bounds.height / 8)} 0 0 1 ${right} ${number(bounds.y + bounds.height / 8)} L ${right} ${number(bounds.y + 7 * bounds.height / 8)} A ${number(bounds.width / 2)} ${number(bounds.height / 8)} 0 0 1 ${x} ${number(bounds.y + 7 * bounds.height / 8)} Z M ${x} ${number(bounds.y + bounds.height / 8)} A ${number(bounds.width / 2)} ${number(bounds.height / 8)} 0 0 0 ${right} ${number(bounds.y + bounds.height / 8)}" style="${style}"/>`;
    default: {
      const radius = kind === "roundRect" ? Math.min(8, bounds.height / 4) : 0;
      return `<rect id="${id}" x="${x}" y="${y}" width="${width}" height="${height}" rx="${number(radius)}" style="${style}"/>`;
    }
  }
}

function edgeSvg(edge: ExportEdge): string[] {
  const id = stableId("edge", edge.id);
  const points = edgePoints(edge);
  const color = styleColor(edge.stroke?.color ?? edge.color, "#333333");
  const dashArray = svgDashArray(edge);
  const dash = dashArray && dashArray.length > 0
    ? `;stroke-dasharray:${dashArray.map((value) => number(value, `edge ${edge.id} dash`)).join(" ")}`
    : "";
  const dashAttribute = dashArray && dashArray.length > 0
    ? ` stroke-dasharray="${dashArray.map((value) => number(value, `edge ${edge.id} dash`)).join(" ")}"`
    : "";
  const dashOffset = edge.stroke?.dashOffset === undefined
    ? ""
    : `;stroke-dashoffset:${number(edge.stroke.dashOffset, `edge ${edge.id} dashOffset`)}`;
  const opacity = edge.stroke?.opacity === undefined
    ? ""
    : ` opacity="${number(edge.stroke.opacity, `edge ${edge.id} opacity`)}"`;
  const strokeWidth = number(edge.stroke?.width ?? edge.strokeWidth ?? 1.5, `edge ${edge.id} strokeWidth`);
  const lineCap = edge.stroke?.lineCap ?? "round";
  const lineJoin = edge.stroke?.lineJoin ?? "round";
  const presentation = ` fill="none" stroke="${xml(color)}" stroke-width="${strokeWidth}" stroke-linecap="${lineCap}" stroke-linejoin="${lineJoin}"${dashAttribute}`;
  const style = `fill:none;stroke:${xml(color)};stroke-width:${strokeWidth};stroke-linecap:${lineCap};stroke-linejoin:${lineJoin}${dash}${dashOffset}`;
  const geometry = edge.path
    ? `<path id="${id}-path" d="${pathData(edge.path, edge.id)}"${presentation} style="${style}"/>`
    : `<polyline id="${id}-path" points="${points.map(pointPair).join(" ")}"${presentation} style="${style}"/>`;
  const arrows = [
    explicitArrowSvg(edge, "start", edge.startArrow, color, Number(strokeWidth), id),
    explicitArrowSvg(edge, "end", edge.endArrow, color, Number(strokeWidth), id),
  ].filter((line): line is string => Boolean(line));
  const lines = [
    `<g id="${id}" data-source-id="${xml(edge.id)}"${opacity}>`,
    `  ${geometry}`,
    ...arrows.map((arrow) => `  ${arrow}`),
  ];
  lines.push("</g>");
  return lines;
}

function labelSvg(text: ExportText, ownerKind: string, ownerId: string): string[] {
  const id = stableId(`${ownerKind}-label`, ownerId);
  return [
    `<g id="${id}" data-label-for="${xml(ownerId)}">`,
    ...textSvg(text, `${id}-text`).map((line) => `  ${line}`),
    "</g>",
  ];
}

function textSvg(text: ExportText, id: string): string[] {
  assertBounds(text.bounds, `text ${id}`);
  const x = number(text.bounds.x + text.bounds.width / 2);
  const lines = text.text.split(/\r?\n/);
  const fontSize = text.fontSize ?? 14;
  const lineHeight = fontSize * 1.2;
  // SVG's dominant-baseline support differs across browsers, PowerPoint, and
  // Illustrator. Use explicit alphabetic baselines instead. The 0.35em shift
  // is the conventional optical-centering offset from an em-box center to an
  // alphabetic baseline, so importers that ignore dominant-baseline still
  // render the same vertical position.
  const firstBaseline = text.bounds.y + text.bounds.height / 2
    - ((lines.length - 1) * lineHeight) / 2
    + fontSize * 0.35;
  const style = [
    `fill:${xml(styleColor(text.color, "#222222"))}`,
    `font-family:${xml(styleFontFamily(text.fontFamily))}`,
    `font-size:${number(fontSize)}px`,
    "text-anchor:middle",
  ].join(";");
  return [
    `<text id="${id}" x="${x}" y="${number(firstBaseline)}" style="${style}">`,
    ...lines.map((line, index) => `  <tspan x="${x}" y="${number(firstBaseline + index * lineHeight)}">${xml(line)}</tspan>`),
    "</text>",
  ];
}

function explicitArrowSvg(
  edge: ExportEdge,
  position: "end" | "start",
  kind: string | undefined,
  color: string,
  strokeWidth: number,
  edgeId: string,
): string | undefined {
  if (!kind || kind === "none") return undefined;
  const { direction, point } = arrowPlacement(edge, position);
  const size = Math.max(8, strokeWidth * 8);
  const halfWidth = size * 0.45;
  const perpendicular = { x: -direction.y, y: direction.x };
  const behind = (distance: number): ExportPoint => ({
    x: point.x - direction.x * distance,
    y: point.y - direction.y * distance,
  });
  const offset = (origin: ExportPoint, distance: number): ExportPoint => ({
    x: origin.x + perpendicular.x * distance,
    y: origin.y + perpendicular.y * distance,
  });
  const id = `${edgeId}-arrow-${position}`;
  const metadata = `id="${id}" data-diagram-arrow="${position}" data-arrow-kind="${xml(kind)}"`;
  if (kind === "oval") {
    const radiusX = size * 0.55;
    const center = behind(radiusX);
    const angle = number(Math.atan2(direction.y, direction.x) * 180 / Math.PI);
    return `<ellipse ${metadata} cx="${number(center.x)}" cy="${number(center.y)}" rx="${number(radiusX)}" ry="${number(size * 0.35)}" fill="${xml(color)}" stroke="${xml(color)}" stroke-width="${number(strokeWidth)}" transform="rotate(${angle} ${number(center.x)} ${number(center.y)})"/>`;
  }
  if (kind === "diamond") {
    const center = behind(size * 0.65);
    const back = behind(size * 1.3);
    const upper = offset(center, halfWidth);
    const lower = offset(center, -halfWidth);
    return `<path ${metadata} d="M ${pointPair(point)} L ${pointPair(upper)} L ${pointPair(back)} L ${pointPair(lower)} Z" fill="${xml(color)}" stroke="${xml(color)}" stroke-width="${number(strokeWidth)}" stroke-linejoin="round"/>`;
  }
  const base = behind(size);
  const upper = offset(base, halfWidth);
  const lower = offset(base, -halfWidth);
  const close = kind === "arrow" ? "" : " Z";
  return `<path ${metadata} d="M ${pointPair(upper)} L ${pointPair(point)} L ${pointPair(lower)}${close}" fill="${kind === "arrow" ? "none" : xml(color)}" stroke="${xml(color)}" stroke-width="${number(strokeWidth)}" stroke-linecap="round" stroke-linejoin="round"/>`;
}

function arrowPlacement(
  edge: ExportEdge,
  position: "end" | "start",
): { direction: ExportPoint; point: ExportPoint } {
  const directed = edge.path ? directedPathSegments(edge.path) : [];
  if (directed.length > 0) {
    const segment = position === "start" ? directed[0]! : directed.at(-1)!;
    const candidates = position === "start"
      ? startTangentCandidates(segment)
      : endTangentCandidates(segment);
    const alongPath = normalizedDirection(candidates);
    return {
      direction: position === "start"
        ? { x: -alongPath.x, y: -alongPath.y }
        : alongPath,
      point: position === "start" ? segment.from : segment.to,
    };
  }
  const points = edgePoints(edge);
  const start = points[0] ?? edge.start;
  const end = points.at(-1) ?? edge.end;
  const adjacent = position === "start" ? points[1] ?? end : points.at(-2) ?? start;
  const alongPath = position === "start"
    ? normalizedDirection([{ x: adjacent.x - start.x, y: adjacent.y - start.y }])
    : normalizedDirection([{ x: end.x - adjacent.x, y: end.y - adjacent.y }]);
  return {
    direction: position === "start" ? { x: -alongPath.x, y: -alongPath.y } : alongPath,
    point: position === "start" ? start : end,
  };
}

interface DirectedPathSegment {
  from: ExportPoint;
  segment: ExportPathSegment;
  to: ExportPoint;
}

function directedPathSegments(path: ExportPath): DirectedPathSegment[] {
  const directed: DirectedPathSegment[] = [];
  let current: ExportPoint | undefined;
  for (const segment of path.segments) {
    if (segment.kind === "move") {
      current = segment.to;
      continue;
    }
    if (segment.kind === "close" || !current) continue;
    directed.push({ from: current, segment, to: segment.to });
    current = segment.to;
  }
  return directed;
}

function startTangentCandidates(segment: DirectedPathSegment): ExportPoint[] {
  const { from, to } = segment;
  if (segment.segment.kind === "cubic") return [
    vector(from, segment.segment.control1),
    vector(from, segment.segment.control2),
    vector(from, to),
  ];
  if (segment.segment.kind === "quadratic") return [
    vector(from, segment.segment.control),
    vector(from, to),
  ];
  return [vector(from, to)];
}

function endTangentCandidates(segment: DirectedPathSegment): ExportPoint[] {
  const { from, to } = segment;
  if (segment.segment.kind === "cubic") return [
    vector(segment.segment.control2, to),
    vector(segment.segment.control1, to),
    vector(from, to),
  ];
  if (segment.segment.kind === "quadratic") return [
    vector(segment.segment.control, to),
    vector(from, to),
  ];
  return [vector(from, to)];
}

function vector(from: ExportPoint, to: ExportPoint): ExportPoint {
  return { x: to.x - from.x, y: to.y - from.y };
}

function normalizedDirection(candidates: readonly ExportPoint[]): ExportPoint {
  for (const candidate of candidates) {
    const length = Math.hypot(candidate.x, candidate.y);
    if (length > 0.000001) return { x: candidate.x / length, y: candidate.y / length };
  }
  return { x: 1, y: 0 };
}

function edgePoints(edge: ExportEdge): readonly ExportPoint[] {
  const pathPoints = edge.path?.segments.flatMap((segment) =>
    segment.kind === "close" ? [] : [segment.to]);
  const points = pathPoints && pathPoints.length >= 2
    ? pathPoints
    : edge.points && edge.points.length >= 2
    ? edge.points
    : [edge.start, edge.end];
  for (const [index, point] of points.entries()) {
    number(point.x, `edge ${edge.id} point ${index} x`);
    number(point.y, `edge ${edge.id} point ${index} y`);
  }
  return points;
}

function pathData(path: ExportPath, edgeId: string): string {
  if (path.segments.length === 0 || path.segments[0]?.kind !== "move") {
    throw new TypeError(`edge ${edgeId} canonical path must begin with a move segment.`);
  }
  return path.segments.map((segment, index) => pathSegmentData(segment, edgeId, index)).join(" ");
}

function pathSegmentData(segment: ExportPathSegment, edgeId: string, index: number): string {
  const point = (value: ExportPoint): string => {
    number(value.x, `edge ${edgeId} path ${index} x`);
    number(value.y, `edge ${edgeId} path ${index} y`);
    return pointPair(value);
  };
  switch (segment.kind) {
    case "move": return `M ${point(segment.to)}`;
    case "line": return `L ${point(segment.to)}`;
    case "cubic": return `C ${point(segment.control1)} ${point(segment.control2)} ${point(segment.to)}`;
    case "quadratic": return `Q ${point(segment.control)} ${point(segment.to)}`;
    case "arc":
      return `A ${number(segment.radiusX, `edge ${edgeId} arc radiusX`)} ${number(segment.radiusY, `edge ${edgeId} arc radiusY`)} ${number(segment.rotation, `edge ${edgeId} arc rotation`)} ${segment.largeArc ? 1 : 0} ${segment.sweep ? 1 : 0} ${point(segment.to)}`;
    case "close": return "Z";
  }
}

function pointPair(point: ExportPoint): string {
  return `${number(point.x)},${number(point.y)}`;
}

function assertBounds(bounds: ExportBounds, label: string): void {
  number(bounds.x, `${label} x`);
  number(bounds.y, `${label} y`);
  if (!(bounds.width >= 0) || !(bounds.height >= 0)) {
    throw new RangeError(`${label} width and height must be non-negative.`);
  }
  number(bounds.width, `${label} width`);
  number(bounds.height, `${label} height`);
}
