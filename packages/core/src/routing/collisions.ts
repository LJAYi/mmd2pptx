import type {
  Bounds,
  DiagramEdge,
  DiagramIR,
  DiagramNode,
  DiagramPathSegment,
  Point,
} from "../types.js";

export type DiagramCollisionKind =
  | "label-edge"
  | "node-edge"
  | "node-label"
  | "node-node";

export type DiagramCollisionParticipantKind =
  | "edge"
  | "edge-label"
  | "node"
  | "node-label";

export interface DiagramCollisionParticipant {
  id: string;
  kind: DiagramCollisionParticipantKind;
}

export interface DiagramCollision {
  first: DiagramCollisionParticipant;
  kind: DiagramCollisionKind;
  second: DiagramCollisionParticipant;
}

interface LabelGeometry {
  bounds: Bounds;
  ownerId: string;
  ownerKind: "edge" | "node";
  participant: DiagramCollisionParticipant;
}

const CURVE_STEPS = 24;
const EPSILON = 1e-7;

/**
 * Analyze target-neutral diagram geometry without mutating the input IR.
 *
 * Expected ownership intersections are deliberately excluded: a node with its
 * own text, an edge with its own label, and an edge with either endpoint node.
 */
export function analyzeDiagramCollisions(diagram: DiagramIR): DiagramCollision[] {
  const collisions: DiagramCollision[] = [];
  const flattenedEdges = new Map(
    diagram.edges.map((edge) => [edge.id, flattenEdge(edge)]),
  );
  const labels = collectLabels(diagram);

  for (let leftIndex = 0; leftIndex < diagram.nodes.length; leftIndex += 1) {
    const left = diagram.nodes[leftIndex];
    if (!left) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < diagram.nodes.length; rightIndex += 1) {
      const right = diagram.nodes[rightIndex];
      if (right && boundsOverlap(left.bounds, right.bounds)) {
        collisions.push({
          first: { id: left.id, kind: "node" },
          kind: "node-node",
          second: { id: right.id, kind: "node" },
        });
      }
    }
  }

  for (const node of diagram.nodes) {
    for (const label of labels) {
      if (label.ownerKind === "node" && label.ownerId === node.id) continue;
      if (boundsOverlap(node.bounds, label.bounds)) {
        collisions.push({
          first: { id: node.id, kind: "node" },
          kind: "node-label",
          second: label.participant,
        });
      }
    }
    for (const edge of diagram.edges) {
      if (edgeTerminatesAtNode(edge, node)) continue;
      if (polylineCrossesBounds(flattenedEdges.get(edge.id) ?? [], node.bounds)) {
        collisions.push({
          first: { id: node.id, kind: "node" },
          kind: "node-edge",
          second: { id: edge.id, kind: "edge" },
        });
      }
    }
  }

  for (const label of labels) {
    for (const edge of diagram.edges) {
      if (label.ownerKind === "edge" && label.ownerId === edge.id) continue;
      if (polylineCrossesBounds(flattenedEdges.get(edge.id) ?? [], label.bounds)) {
        collisions.push({
          first: label.participant,
          kind: "label-edge",
          second: { id: edge.id, kind: "edge" },
        });
      }
    }
  }

  return collisions.sort(compareCollisions);
}

function collectLabels(diagram: DiagramIR): LabelGeometry[] {
  return [
    ...diagram.nodes.flatMap((node): LabelGeometry[] => node.text ? [{
      bounds: node.text.bounds,
      ownerId: node.id,
      ownerKind: "node",
      participant: { id: node.id, kind: "node-label" },
    }] : []),
    ...diagram.edges.flatMap((edge): LabelGeometry[] => edge.label ? [{
      bounds: edge.label.bounds,
      ownerId: edge.id,
      ownerKind: "edge",
      participant: { id: edge.id, kind: "edge-label" },
    }] : []),
  ];
}

function edgeTerminatesAtNode(edge: DiagramEdge, node: DiagramNode): boolean {
  const identities = new Set([node.id, node.semanticId, node.sourceKey].filter(Boolean));
  return Boolean(
    edge.sourceId && identities.has(edge.sourceId)
      || edge.targetId && identities.has(edge.targetId)
      || !edge.sourceId && pointTouchesBounds(edge.start, node.bounds)
      || !edge.targetId && pointTouchesBounds(edge.end, node.bounds),
  );
}

function pointTouchesBounds(point: Point, bounds: Bounds): boolean {
  return point.x >= bounds.x - EPSILON
    && point.x <= bounds.x + bounds.width + EPSILON
    && point.y >= bounds.y - EPSILON
    && point.y <= bounds.y + bounds.height + EPSILON;
}

function flattenEdge(edge: DiagramEdge): Point[] {
  if (!edge.path) {
    return (edge.points && edge.points.length >= 2 ? edge.points : [edge.start, edge.end])
      .map((point) => ({ ...point }));
  }

  const points: Point[] = [];
  let current: Point | undefined;
  let subpathStart: Point | undefined;
  for (const segment of edge.path.segments) {
    if (segment.kind === "move") {
      if (points.length > 0) points.push({ x: Number.NaN, y: Number.NaN });
      current = { ...segment.to };
      subpathStart = { ...segment.to };
      points.push(current);
      continue;
    }
    if (segment.kind === "close") {
      if (current && subpathStart) appendPoint(points, subpathStart);
      current = subpathStart ? { ...subpathStart } : current;
      continue;
    }
    if (!current) {
      current = { ...segment.to };
      points.push(current);
      continue;
    }
    if (segment.kind === "line") {
      appendPoint(points, segment.to);
    } else if (segment.kind === "cubic") {
      flattenCubic(points, current, segment);
    } else if (segment.kind === "quadratic") {
      flattenQuadratic(points, current, segment);
    } else {
      flattenArc(points, current, segment);
    }
    current = { ...segment.to };
  }
  return points;
}

function flattenCubic(
  output: Point[],
  start: Point,
  segment: Extract<DiagramPathSegment, { kind: "cubic" }>,
): void {
  for (let index = 1; index <= CURVE_STEPS; index += 1) {
    const amount = index / CURVE_STEPS;
    const inverse = 1 - amount;
    appendPoint(output, {
      x: inverse ** 3 * start.x
        + 3 * inverse ** 2 * amount * segment.control1.x
        + 3 * inverse * amount ** 2 * segment.control2.x
        + amount ** 3 * segment.to.x,
      y: inverse ** 3 * start.y
        + 3 * inverse ** 2 * amount * segment.control1.y
        + 3 * inverse * amount ** 2 * segment.control2.y
        + amount ** 3 * segment.to.y,
    });
  }
}

function flattenQuadratic(
  output: Point[],
  start: Point,
  segment: Extract<DiagramPathSegment, { kind: "quadratic" }>,
): void {
  for (let index = 1; index <= CURVE_STEPS; index += 1) {
    const amount = index / CURVE_STEPS;
    const inverse = 1 - amount;
    appendPoint(output, {
      x: inverse ** 2 * start.x
        + 2 * inverse * amount * segment.control.x
        + amount ** 2 * segment.to.x,
      y: inverse ** 2 * start.y
        + 2 * inverse * amount * segment.control.y
        + amount ** 2 * segment.to.y,
    });
  }
}

function flattenArc(
  output: Point[],
  start: Point,
  segment: Extract<DiagramPathSegment, { kind: "arc" }>,
): void {
  if (segment.radiusX === 0 || segment.radiusY === 0 || samePoint(start, segment.to)) {
    appendPoint(output, segment.to);
    return;
  }
  const arc = endpointArc(start, segment);
  if (!arc) {
    appendPoint(output, segment.to);
    return;
  }
  const steps = Math.max(4, Math.ceil(Math.abs(arc.sweep) / (Math.PI * 2) * 48));
  for (let index = 1; index <= steps; index += 1) {
    const angle = arc.start + arc.sweep * index / steps;
    const localX = arc.radiusX * Math.cos(angle);
    const localY = arc.radiusY * Math.sin(angle);
    appendPoint(output, {
      x: arc.center.x + arc.cos * localX - arc.sin * localY,
      y: arc.center.y + arc.sin * localX + arc.cos * localY,
    });
  }
}

function endpointArc(
  start: Point,
  segment: Extract<DiagramPathSegment, { kind: "arc" }>,
): {
  center: Point;
  cos: number;
  radiusX: number;
  radiusY: number;
  sin: number;
  start: number;
  sweep: number;
} | undefined {
  const rotation = segment.rotation * Math.PI / 180;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const halfX = (start.x - segment.to.x) / 2;
  const halfY = (start.y - segment.to.y) / 2;
  const primeX = cos * halfX + sin * halfY;
  const primeY = -sin * halfX + cos * halfY;
  let radiusX = Math.abs(segment.radiusX);
  let radiusY = Math.abs(segment.radiusY);
  const lambda = primeX ** 2 / radiusX ** 2 + primeY ** 2 / radiusY ** 2;
  if (lambda > 1) {
    const scale = Math.sqrt(lambda);
    radiusX *= scale;
    radiusY *= scale;
  }
  const numerator = Math.max(0,
    radiusX ** 2 * radiusY ** 2
      - radiusX ** 2 * primeY ** 2
      - radiusY ** 2 * primeX ** 2);
  const denominator = radiusX ** 2 * primeY ** 2 + radiusY ** 2 * primeX ** 2;
  if (denominator <= EPSILON) return undefined;
  const sign = segment.largeArc === segment.sweep ? -1 : 1;
  const coefficient = sign * Math.sqrt(numerator / denominator);
  const centerPrimeX = coefficient * radiusX * primeY / radiusY;
  const centerPrimeY = -coefficient * radiusY * primeX / radiusX;
  const center = {
    x: cos * centerPrimeX - sin * centerPrimeY + (start.x + segment.to.x) / 2,
    y: sin * centerPrimeX + cos * centerPrimeY + (start.y + segment.to.y) / 2,
  };
  const startVector = {
    x: (primeX - centerPrimeX) / radiusX,
    y: (primeY - centerPrimeY) / radiusY,
  };
  const endVector = {
    x: (-primeX - centerPrimeX) / radiusX,
    y: (-primeY - centerPrimeY) / radiusY,
  };
  const startAngle = Math.atan2(startVector.y, startVector.x);
  let sweep = vectorAngle(startVector, endVector);
  if (!segment.sweep && sweep > 0) sweep -= Math.PI * 2;
  if (segment.sweep && sweep < 0) sweep += Math.PI * 2;
  return { center, cos, radiusX, radiusY, sin, start: startAngle, sweep };
}

function vectorAngle(from: Point, to: Point): number {
  return Math.atan2(from.x * to.y - from.y * to.x, from.x * to.x + from.y * to.y);
}

function appendPoint(points: Point[], point: Point): void {
  const previous = points.at(-1);
  if (!previous || !samePoint(previous, point)) points.push({ ...point });
}

function samePoint(left: Point, right: Point): boolean {
  return Math.abs(left.x - right.x) <= EPSILON && Math.abs(left.y - right.y) <= EPSILON;
}

function boundsOverlap(left: Bounds, right: Bounds): boolean {
  return left.x < right.x + right.width - EPSILON
    && left.x + left.width > right.x + EPSILON
    && left.y < right.y + right.height - EPSILON
    && left.y + left.height > right.y + EPSILON;
}

function polylineCrossesBounds(points: readonly Point[], bounds: Bounds): boolean {
  return points.slice(1).some((end, index) => {
    const start = points[index]!;
    return [start.x, start.y, end.x, end.y].every(Number.isFinite)
      && segmentCrossesBounds(start, end, bounds);
  });
}

function segmentCrossesBounds(start: Point, end: Point, bounds: Bounds): boolean {
  const left = bounds.x + EPSILON;
  const right = bounds.x + bounds.width - EPSILON;
  const top = bounds.y + EPSILON;
  const bottom = bounds.y + bounds.height - EPSILON;
  if (left >= right || top >= bottom) return false;
  let minimum = 0;
  let maximum = 1;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  for (const [origin, delta, low, high] of [
    [start.x, dx, left, right],
    [start.y, dy, top, bottom],
  ] as const) {
    if (Math.abs(delta) <= EPSILON) {
      if (origin <= low || origin >= high) return false;
      continue;
    }
    const first = (low - origin) / delta;
    const second = (high - origin) / delta;
    minimum = Math.max(minimum, Math.min(first, second));
    maximum = Math.min(maximum, Math.max(first, second));
    if (minimum > maximum) return false;
  }
  return maximum >= 0 && minimum <= 1 && minimum <= maximum;
}

function compareCollisions(left: DiagramCollision, right: DiagramCollision): number {
  return left.kind.localeCompare(right.kind)
    || left.first.kind.localeCompare(right.first.kind)
    || left.first.id.localeCompare(right.first.id)
    || left.second.kind.localeCompare(right.second.kind)
    || left.second.id.localeCompare(right.second.id);
}
