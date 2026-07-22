import type {
  Bounds,
  ConversionDiagnostic,
  DiagramPath,
  Point,
} from "../types.js";
import type {
  OrthogonalPort,
  OrthogonalRouteRequest,
  OrthogonalRouteResult,
} from "./types.js";

const EPSILON = 1e-7;

interface SearchNode {
  f: number;
  g: number;
  h: number;
  key: string;
  point: Point;
}

/** Deterministic target-neutral orthogonal obstacle routing. */
export function routeOrthogonal(
  request: OrthogonalRouteRequest,
): OrthogonalRouteResult {
  validateBounds(request.source, "source");
  validateBounds(request.target, "target");
  const obstacles = request.obstacles ?? [];
  obstacles.forEach((bounds, index) => validateBounds(bounds, `obstacles[${index}]`));
  const padding = finiteNonNegative(request.padding ?? 12, "padding");
  const grid = finitePositive(request.grid ?? 8, "grid");
  const budget = integerPositive(request.maxSearchBudget ?? 20_000, "maxSearchBudget");

  const sourcePort = request.sourcePort ?? defaultPort(request.source, request.target, true);
  const targetPort = request.targetPort ?? defaultPort(request.target, request.source, false);
  const sourceAnchor = portAnchor(request.source, sourcePort);
  const targetAnchor = portAnchor(request.target, targetPort);
  const sourceExit = offsetFromPort(sourceAnchor, sourcePort, padding);
  const targetExit = offsetFromPort(targetAnchor, targetPort, padding);
  const blocked = obstacles.map((bounds) => quantizedExpanded(bounds, padding, grid));

  if (segmentBlocked(sourceAnchor, sourceExit, blocked)
    || segmentBlocked(targetExit, targetAnchor, blocked)) {
    return fallback(sourceAnchor, targetAnchor, 0, [{
      code: "ORTHOGONAL_ROUTE_PORT_BLOCKED",
      message: "A requested port exit is blocked by an obstacle.",
      severity: "warning",
    }]);
  }

  const searched = visibilityAStar(sourceExit, targetExit, blocked, budget);
  if (!searched.points) {
    const diagnostic: ConversionDiagnostic = searched.budgetExceeded
      ? {
          code: "ORTHOGONAL_ROUTE_BUDGET_EXCEEDED",
          message: `Routing exceeded the ${budget}-node search budget.`,
          severity: "warning",
        }
      : {
          code: "ORTHOGONAL_ROUTE_NOT_FOUND",
          message: "No orthogonal path was found between the requested ports.",
          severity: "warning",
        };
    return fallback(sourceAnchor, targetAnchor, searched.visited, [diagnostic]);
  }

  const points = compressCollinear([
    sourceAnchor,
    sourceExit,
    ...searched.points,
    targetExit,
    targetAnchor,
  ]);
  return {
    diagnostics: [],
    path: polylinePath(points),
    points,
    usedFallback: false,
    visitedNodes: searched.visited,
  };
}

function visibilityAStar(
  start: Point,
  goal: Point,
  obstacles: readonly Bounds[],
  budget: number,
): { budgetExceeded: boolean; points?: Point[]; visited: number } {
  if (pointBlocked(start, obstacles) || pointBlocked(goal, obstacles)) {
    return { budgetExceeded: false, visited: 0 };
  }
  const xs = uniqueSorted([
    start.x,
    goal.x,
    ...obstacles.flatMap((bounds) => [bounds.x, bounds.x + bounds.width]),
  ]);
  const ys = uniqueSorted([
    start.y,
    goal.y,
    ...obstacles.flatMap((bounds) => [bounds.y, bounds.y + bounds.height]),
  ]);
  const startKey = pointKey(start);
  const goalKey = pointKey(goal);
  const open: SearchNode[] = [{
    f: manhattan(start, goal),
    g: 0,
    h: manhattan(start, goal),
    key: startKey,
    point: start,
  }];
  const best = new Map([[startKey, 0]]);
  const previous = new Map<string, string>();
  const points = new Map([[startKey, start], [goalKey, goal]]);
  let visited = 0;

  while (open.length > 0) {
    open.sort(compareSearchNodes);
    const current = open.shift()!;
    if (current.g !== best.get(current.key)) continue;
    visited += 1;
    if (visited > budget) return { budgetExceeded: true, visited };
    if (current.key === goalKey) {
      return {
        budgetExceeded: false,
        points: reconstruct(goalKey, previous, points),
        visited,
      };
    }

    for (const neighbor of adjacentCandidates(current.point, xs, ys)) {
      if (pointBlocked(neighbor, obstacles)
        || segmentBlocked(current.point, neighbor, obstacles)) continue;
      const key = pointKey(neighbor);
      points.set(key, neighbor);
      const g = current.g + manhattan(current.point, neighbor);
      if (g >= (best.get(key) ?? Number.POSITIVE_INFINITY) - EPSILON) continue;
      const h = manhattan(neighbor, goal);
      best.set(key, g);
      previous.set(key, current.key);
      open.push({ f: g + h, g, h, key, point: neighbor });
    }
  }
  return { budgetExceeded: false, visited };
}

function adjacentCandidates(point: Point, xs: readonly number[], ys: readonly number[]): Point[] {
  const xIndex = xs.findIndex((value) => close(value, point.x));
  const yIndex = ys.findIndex((value) => close(value, point.y));
  const candidates: Point[] = [];
  for (const index of [xIndex - 1, xIndex + 1]) {
    const x = xs[index];
    if (x !== undefined) candidates.push({ x, y: point.y });
  }
  for (const index of [yIndex - 1, yIndex + 1]) {
    const y = ys[index];
    if (y !== undefined) candidates.push({ x: point.x, y });
  }
  return candidates;
}

function reconstruct(
  goalKey: string,
  previous: ReadonlyMap<string, string>,
  points: ReadonlyMap<string, Point>,
): Point[] {
  const result: Point[] = [];
  let key: string | undefined = goalKey;
  while (key) {
    const point = points.get(key);
    if (!point) break;
    result.push(point);
    key = previous.get(key);
  }
  return result.reverse();
}

function compareSearchNodes(left: SearchNode, right: SearchNode): number {
  return left.f - right.f || left.h - right.h || left.key.localeCompare(right.key);
}

function segmentBlocked(start: Point, end: Point, obstacles: readonly Bounds[]): boolean {
  if (!close(start.x, end.x) && !close(start.y, end.y)) return true;
  return obstacles.some((bounds) => {
    if (close(start.y, end.y)) {
      if (!(start.y > bounds.y + EPSILON
        && start.y < bounds.y + bounds.height - EPSILON)) return false;
      return rangesOverlap(start.x, end.x, bounds.x, bounds.x + bounds.width);
    }
    if (!(start.x > bounds.x + EPSILON
      && start.x < bounds.x + bounds.width - EPSILON)) return false;
    return rangesOverlap(start.y, end.y, bounds.y, bounds.y + bounds.height);
  });
}

function pointBlocked(point: Point, obstacles: readonly Bounds[]): boolean {
  return obstacles.some((bounds) =>
    point.x > bounds.x + EPSILON
    && point.x < bounds.x + bounds.width - EPSILON
    && point.y > bounds.y + EPSILON
    && point.y < bounds.y + bounds.height - EPSILON);
}

function rangesOverlap(a1: number, a2: number, b1: number, b2: number): boolean {
  const left = Math.max(Math.min(a1, a2), Math.min(b1, b2));
  const right = Math.min(Math.max(a1, a2), Math.max(b1, b2));
  return right - left > EPSILON;
}

function fallback(
  source: Point,
  target: Point,
  visitedNodes: number,
  diagnostics: ConversionDiagnostic[],
): OrthogonalRouteResult {
  const points = dedupe([source, target]);
  return {
    diagnostics: [...diagnostics, {
      code: "ORTHOGONAL_ROUTE_FALLBACK_STRAIGHT",
      message: "The route fell back to a straight segment and may cross obstacles.",
      severity: "warning",
    }],
    path: polylinePath(points),
    points,
    usedFallback: true,
    visitedNodes,
  };
}

function defaultPort(source: Bounds, target: Bounds, sourceEnd: boolean): OrthogonalPort {
  const from = center(source);
  const to = center(target);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    if (dx === 0) return sourceEnd ? "right" : "left";
    return dx > 0 ? "right" : "left";
  }
  return dy > 0 ? "bottom" : "top";
}

function portAnchor(bounds: Bounds, port: OrthogonalPort): Point {
  const middle = center(bounds);
  switch (port) {
    case "top": return { x: middle.x, y: bounds.y };
    case "right": return { x: bounds.x + bounds.width, y: middle.y };
    case "bottom": return { x: middle.x, y: bounds.y + bounds.height };
    case "left": return { x: bounds.x, y: middle.y };
  }
}

function offsetFromPort(point: Point, port: OrthogonalPort, amount: number): Point {
  switch (port) {
    case "top": return { x: point.x, y: point.y - amount };
    case "right": return { x: point.x + amount, y: point.y };
    case "bottom": return { x: point.x, y: point.y + amount };
    case "left": return { x: point.x - amount, y: point.y };
  }
}

function quantizedExpanded(bounds: Bounds, padding: number, grid: number): Bounds {
  const left = Math.floor((bounds.x - padding) / grid) * grid;
  const top = Math.floor((bounds.y - padding) / grid) * grid;
  const right = Math.ceil((bounds.x + bounds.width + padding) / grid) * grid;
  const bottom = Math.ceil((bounds.y + bounds.height + padding) / grid) * grid;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function compressCollinear(points: readonly Point[]): Point[] {
  const unique = dedupe(points);
  if (unique.length <= 2) return unique;
  const compressed = [unique[0]!];
  for (let index = 1; index < unique.length - 1; index += 1) {
    const previous = compressed.at(-1)!;
    const current = unique[index]!;
    const next = unique[index + 1]!;
    if ((close(previous.x, current.x) && close(current.x, next.x))
      || (close(previous.y, current.y) && close(current.y, next.y))) continue;
    compressed.push(current);
  }
  compressed.push(unique.at(-1)!);
  return compressed;
}

function dedupe(points: readonly Point[]): Point[] {
  return points.filter((point, index) => {
    const previous = points[index - 1];
    return !previous || !close(point.x, previous.x) || !close(point.y, previous.y);
  }).map((point) => ({ ...point }));
}

function polylinePath(points: readonly Point[]): DiagramPath {
  return {
    segments: points.map((to, index) => ({
      kind: index === 0 ? "move" as const : "line" as const,
      to: { ...to },
    })),
  };
}

function uniqueSorted(values: readonly number[]): number[] {
  return [...new Set(values.map((value) => normalized(value)))]
    .sort((left, right) => left - right);
}

function pointKey(point: Point): string {
  return `${normalized(point.x)},${normalized(point.y)}`;
}

function normalized(value: number): number {
  return Math.round(value * 1e7) / 1e7;
}

function manhattan(left: Point, right: Point): number {
  return Math.abs(left.x - right.x) + Math.abs(left.y - right.y);
}

function center(bounds: Bounds): Point {
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
}

function close(left: number, right: number): boolean {
  return Math.abs(left - right) <= EPSILON;
}

function validateBounds(bounds: Bounds, label: string): void {
  if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)
    || bounds.width <= 0 || bounds.height <= 0) {
    throw new RangeError(`${label} must have finite coordinates and positive dimensions.`);
  }
}

function finiteNonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${label} must be finite and non-negative.`);
  return value;
}

function finitePositive(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${label} must be finite and positive.`);
  return value;
}

function integerPositive(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new RangeError(`${label} must be a positive integer.`);
  return value;
}
