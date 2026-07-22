import type {
  Bounds,
  ConversionDiagnostic,
  ConversionResult,
  DiagramEdge,
  DiagramIR,
  DiagramNode,
  DiagramPath,
  DiagramPathSegment,
  Point,
} from "../types.js";
import { objectMatchesLayoutIdentity } from "./identity.js";
import { parseLayoutSidecar } from "./sidecar.js";
import type { EdgeLayoutEntry, LayoutIdentity, LayoutSidecar } from "./types.js";

export function applyLayoutSidecar(
  diagram: DiagramIR,
  sidecar: LayoutSidecar,
): ConversionResult<DiagramIR> {
  let normalized: LayoutSidecar;
  try {
    normalized = parseLayoutSidecar(sidecar);
  } catch (error) {
    return result(cloneDiagram(diagram), [{
      code: "LAYOUT_SIDECAR_INVALID",
      message: error instanceof Error ? error.message : String(error),
      severity: "error",
    }]);
  }

  const diagnostics: ConversionDiagnostic[] = [];
  const output = cloneDiagram(diagram);
  const movedNodeIds = new Set<string>();

  for (const entry of normalized.nodes) {
    const node = output.nodes.find((candidate) =>
      objectMatchesLayoutIdentity(candidate, entry.identity));
    if (!node) {
      diagnostics.push({
        code: "LAYOUT_NODE_NOT_FOUND",
        message: `No diagram node matches ${entry.identity.kind}:${entry.identity.value}.`,
        severity: "warning",
      });
      continue;
    }
    if (entry.zIndex !== undefined) node.zIndex = entry.zIndex;
    if (entry.mode === "manual") {
      const boundsChanged = !sameBounds(node.bounds, entry.bounds);
      node.bounds = { ...entry.bounds };
      if (node.text) node.text.bounds = centeredTextBounds(node.text.bounds, node.bounds);
      if (boundsChanged) movedNodeIds.add(node.id);
    }
  }

  if (normalized.groups !== undefined) {
    const sourceGroups = new Map((output.groups ?? []).flatMap((group) =>
      [group.id, group.semanticId, group.sourceKey]
        .filter((value): value is string => Boolean(value))
        .map((value) => [value, group] as const)));
    const resolvedGroupIds = new Map<string, string>();
    const nextGroups = normalized.groups.map((entry) => {
      const source = sourceGroups.get(entry.id);
      const group = source
        ? { ...source, bounds: { ...entry.bounds } }
        : { bounds: { ...entry.bounds }, id: entry.id };
      if (entry.zIndex !== undefined) group.zIndex = entry.zIndex;
      if (group.text) group.text = {
        ...group.text,
        bounds: centeredTextBounds(group.text.bounds, group.bounds),
      };
      resolvedGroupIds.set(entry.id, group.id);
      return group;
    });
    for (const node of output.nodes) delete node.parentId;
    for (const entry of normalized.groups) {
      for (const identity of entry.children) {
        const node = output.nodes.find((candidate) =>
          objectMatchesLayoutIdentity(candidate, identity));
        if (node) node.parentId = resolvedGroupIds.get(entry.id) ?? entry.id;
      }
    }
    output.groups = nextGroups;
  }

  const overriddenEdgeIds = new Set<string>();
  for (const entry of normalized.edges) {
    const edge = output.edges.find((candidate) =>
      objectMatchesLayoutIdentity(candidate, entry.identity));
    if (!edge) {
      diagnostics.push({
        code: "LAYOUT_EDGE_NOT_FOUND",
        message: `No diagram edge matches ${entry.identity.kind}:${entry.identity.value}.`,
        severity: "warning",
      });
      continue;
    }
    if (!edgeEndpointsMatch(edge, output.nodes, entry)) {
      diagnostics.push({
        code: "LAYOUT_EDGE_ENDPOINT_MISMATCH",
        elementId: edge.id,
        message: "The stored edge route refers to different source or target nodes and was ignored.",
        severity: "warning",
      });
      continue;
    }
    if (entry.zIndex !== undefined) edge.zIndex = entry.zIndex;
    if (entry.labelZIndex !== undefined && edge.label) edge.label.zIndex = entry.labelZIndex;
    const source = resolveEndpointNode(edge.sourceId, output.nodes);
    const target = resolveEndpointNode(edge.targetId, output.nodes);
    const points = entry.points.map((point) => ({ ...point }));
    if (source && entry.sourcePort && entry.sourcePort !== "auto" && points[0]) {
      points[0] = portPoint(source.bounds, entry.sourcePort);
    }
    if (target && entry.targetPort && entry.targetPort !== "auto" && points.at(-1)) {
      points[points.length - 1] = portPoint(target.bounds, entry.targetPort);
    }
    const path = entry.path ? resolvePathEndpoints(entry.path, points[0]!, points.at(-1)!) : undefined;
    applyRoute(edge, points, entry.labelOffset, path);
    overriddenEdgeIds.add(edge.id);
  }

  for (const edge of output.edges) {
    if (overriddenEdgeIds.has(edge.id)) continue;
    const source = resolveEndpointNode(edge.sourceId, output.nodes);
    const target = resolveEndpointNode(edge.targetId, output.nodes);
    if (!source || !target || (!movedNodeIds.has(source.id) && !movedNodeIds.has(target.id))) {
      continue;
    }
    applyRoute(edge, rectangleConnection(source.bounds, target.bounds));
    diagnostics.push({
      code: "LAYOUT_EDGE_AUTO_REROUTED",
      elementId: edge.id,
      message: "The edge was rerouted between manually positioned node bounds.",
      severity: "info",
    });
  }

  expandCanvas(output, diagnostics);
  return result(output, diagnostics);
}

function sameBounds(left: Bounds, right: Bounds): boolean {
  const epsilon = 1e-6;
  return (
    Math.abs(left.x - right.x) <= epsilon
    && Math.abs(left.y - right.y) <= epsilon
    && Math.abs(left.width - right.width) <= epsilon
    && Math.abs(left.height - right.height) <= epsilon
  );
}

function applyRoute(
  edge: DiagramEdge,
  route: readonly Point[],
  labelOffset?: Point,
  canonicalPath?: DiagramPath,
): void {
  const points = route.map((point) => ({ ...point }));
  const start = points[0];
  const end = points.at(-1);
  if (!start || !end) return;
  edge.points = points;
  edge.path = canonicalPath ? clonePath(canonicalPath) : {
    segments: points.map((to, index): DiagramPathSegment => ({
      kind: index === 0 ? "move" : "line",
      to: { ...to },
    })),
  };
  edge.start = { ...start };
  edge.end = { ...end };
  if (edge.label) {
    const center = canonicalPath ? canonicalPathMidpoint(canonicalPath) : polylineMidpoint(points);
    edge.label.bounds = {
      ...edge.label.bounds,
      x: center.x - edge.label.bounds.width / 2,
      y: center.y - edge.label.bounds.height / 2,
    };
    if (labelOffset) {
      edge.label.bounds.x += labelOffset.x;
      edge.label.bounds.y += labelOffset.y;
    }
  }
}

function resolvePathEndpoints(path: DiagramPath, start: Point, end: Point): DiagramPath {
  const resolved = clonePath(path);
  const first = resolved.segments[0];
  if (first?.kind === "move") first.to = { ...start };
  for (let index = resolved.segments.length - 1; index >= 1; index -= 1) {
    const segment = resolved.segments[index];
    if (segment && segment.kind !== "close") {
      segment.to = { ...end };
      break;
    }
  }
  return resolved;
}

function clonePath(path: DiagramPath): DiagramPath {
  return { segments: path.segments.map(cloneSegment) };
}

function portPoint(bounds: Bounds, side: "top" | "right" | "bottom" | "left"): Point {
  const middle = center(bounds);
  switch (side) {
    case "top": return { x: middle.x, y: bounds.y };
    case "right": return { x: bounds.x + bounds.width, y: middle.y };
    case "bottom": return { x: middle.x, y: bounds.y + bounds.height };
    case "left": return { x: bounds.x, y: middle.y };
  }
}

function edgeEndpointsMatch(
  edge: DiagramEdge,
  nodes: readonly DiagramNode[],
  entry: EdgeLayoutEntry,
): boolean {
  const source = resolveEndpointNode(edge.sourceId, nodes);
  const target = resolveEndpointNode(edge.targetId, nodes);
  return Boolean(
    source && target
    && objectMatchesLayoutIdentity(source, entry.source)
    && objectMatchesLayoutIdentity(target, entry.target),
  );
}

function resolveEndpointNode(
  endpointId: string | undefined,
  nodes: readonly DiagramNode[],
): DiagramNode | undefined {
  if (!endpointId) return undefined;
  return nodes.find((node) =>
    node.id === endpointId || node.semanticId === endpointId || node.sourceKey === endpointId);
}

function rectangleConnection(source: Bounds, target: Bounds): [Point, Point] {
  const sourceCenter = center(source);
  const targetCenter = center(target);
  return [
    rectangleBoundary(source, targetCenter),
    rectangleBoundary(target, sourceCenter),
  ];
}

function rectangleBoundary(bounds: Bounds, toward: Point): Point {
  const origin = center(bounds);
  const dx = toward.x - origin.x;
  const dy = toward.y - origin.y;
  if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return origin;
  const scale = 1 / Math.max(
    Math.abs(dx) / Math.max(bounds.width / 2, 1e-9),
    Math.abs(dy) / Math.max(bounds.height / 2, 1e-9),
  );
  return { x: origin.x + dx * scale, y: origin.y + dy * scale };
}

function polylineMidpoint(points: readonly Point[]): Point {
  const lengths = points.slice(1).map((point, index) =>
    Math.hypot(point.x - points[index]!.x, point.y - points[index]!.y));
  const total = lengths.reduce((sum, length) => sum + length, 0);
  if (total === 0) return { ...points[0]! };
  let remaining = total / 2;
  for (let index = 0; index < lengths.length; index += 1) {
    const length = lengths[index]!;
    if (remaining <= length) {
      const start = points[index]!;
      const end = points[index + 1]!;
      const amount = length === 0 ? 0 : remaining / length;
      return {
        x: start.x + (end.x - start.x) * amount,
        y: start.y + (end.y - start.y) * amount,
      };
    }
    remaining -= length;
  }
  return { ...points.at(-1)! };
}

function canonicalPathMidpoint(path: DiagramPath): Point {
  const samples: Point[] = [];
  let current: Point | undefined;
  for (const segment of path.segments) {
    if (segment.kind === "close") continue;
    if (segment.kind === "move") {
      current = { ...segment.to };
      samples.push(current);
      continue;
    }
    if (!current) continue;
    const start = current;
    const count = segment.kind === "cubic" || segment.kind === "quadratic" ? 24 : 1;
    for (let index = 1; index <= count; index += 1) {
      const t = index / count;
      const inverse = 1 - t;
      samples.push(segment.kind === "cubic" ? {
        x: inverse ** 3 * start.x + 3 * inverse ** 2 * t * segment.control1.x
          + 3 * inverse * t ** 2 * segment.control2.x + t ** 3 * segment.to.x,
        y: inverse ** 3 * start.y + 3 * inverse ** 2 * t * segment.control1.y
          + 3 * inverse * t ** 2 * segment.control2.y + t ** 3 * segment.to.y,
      } : segment.kind === "quadratic" ? {
        x: inverse ** 2 * start.x + 2 * inverse * t * segment.control.x + t ** 2 * segment.to.x,
        y: inverse ** 2 * start.y + 2 * inverse * t * segment.control.y + t ** 2 * segment.to.y,
      } : {
        x: start.x + (segment.to.x - start.x) * t,
        y: start.y + (segment.to.y - start.y) * t,
      });
    }
    current = { ...segment.to };
  }
  return samples.length > 1 ? polylineMidpoint(samples) : { ...(samples[0] ?? { x: 0, y: 0 }) };
}

function centeredTextBounds(text: Bounds, node: Bounds): Bounds {
  return {
    ...text,
    x: node.x + (node.width - text.width) / 2,
    y: node.y + (node.height - text.height) / 2,
  };
}

function center(bounds: Bounds): Point {
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
}

function expandCanvas(diagram: DiagramIR, diagnostics: ConversionDiagnostic[]): void {
  const points = [
    ...(diagram.groups ?? []).flatMap(({ bounds, text }) => [
      { x: bounds.x, y: bounds.y },
      { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
      ...(text ? [
        { x: text.bounds.x, y: text.bounds.y },
        { x: text.bounds.x + text.bounds.width, y: text.bounds.y + text.bounds.height },
      ] : []),
    ]),
    ...diagram.nodes.flatMap(({ bounds }) => [
      { x: bounds.x, y: bounds.y },
      { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
    ]),
    ...diagram.edges.flatMap((edge) => [
      ...(edge.points ?? [edge.start, edge.end]),
      ...(edge.path?.segments.flatMap((segment) => segment.kind === "close" ? []
        : segment.kind === "cubic" ? [segment.to, segment.control1, segment.control2]
          : segment.kind === "quadratic" ? [segment.to, segment.control]
            : [segment.to]) ?? []),
      ...(edge.label ? [
        { x: edge.label.bounds.x, y: edge.label.bounds.y },
        { x: edge.label.bounds.x + edge.label.bounds.width, y: edge.label.bounds.y + edge.label.bounds.height },
      ] : []),
    ]),
  ];
  if (points.some(({ x, y }) => x < 0 || y < 0)) {
    diagnostics.push({
      code: "LAYOUT_NEGATIVE_COORDINATE",
      message: "The layout contains negative coordinates; Diagram IR has no viewBox origin field.",
      severity: "warning",
    });
  }
  diagram.width = Math.max(diagram.width, ...points.map(({ x }) => x));
  diagram.height = Math.max(diagram.height, ...points.map(({ y }) => y));
}

function cloneDiagram(diagram: DiagramIR): DiagramIR {
  return {
    ...diagram,
    ...(diagram.groups ? { groups: diagram.groups.map((group) => ({
      ...group,
      bounds: { ...group.bounds },
      ...(group.text ? { text: { ...group.text, bounds: { ...group.text.bounds } } } : {}),
    })) } : {}),
    nodes: diagram.nodes.map((node) => ({
      ...node,
      bounds: { ...node.bounds },
      ...(node.text ? { text: { ...node.text, bounds: { ...node.text.bounds } } } : {}),
    })),
    edges: diagram.edges.map((edge) => ({
      ...edge,
      start: { ...edge.start },
      end: { ...edge.end },
      ...(edge.points ? { points: edge.points.map((point) => ({ ...point })) } : {}),
      ...(edge.path ? { path: { segments: edge.path.segments.map(cloneSegment) } } : {}),
      ...(edge.stroke ? { stroke: {
        ...edge.stroke,
        ...(edge.stroke.dashArray ? { dashArray: [...edge.stroke.dashArray] } : {}),
      } } : {}),
      ...(edge.label ? { label: { ...edge.label, bounds: { ...edge.label.bounds } } } : {}),
    })),
  };
}

function cloneSegment(segment: DiagramPathSegment): DiagramPathSegment {
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

function result(
  diagram: DiagramIR,
  diagnostics: ConversionDiagnostic[],
): ConversionResult<DiagramIR> {
  const fallbackObjects = new Set(
    diagnostics.filter(({ severity, elementId }) => severity === "warning" && elementId)
      .map(({ elementId }) => elementId!),
  ).size;
  const labels = diagram.edges.filter(({ label }) => Boolean(label)).length
    + diagram.nodes.filter(({ text }) => Boolean(text)).length
    + (diagram.groups ?? []).filter(({ text }) => Boolean(text)).length;
  return {
    data: diagram,
    diagnostics,
    summary: {
      editableObjects: diagram.nodes.length + diagram.edges.length
        + (diagram.groups?.length ?? 0) + labels,
      edges: diagram.edges.length,
      fallbackObjects,
      nodes: diagram.nodes.length,
    },
  };
}
