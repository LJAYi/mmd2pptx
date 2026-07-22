import { describe, expect, it } from "vitest";

import { routeOrthogonal } from "../src/routing/index.js";
import type { Bounds, Point } from "../src/types.js";

describe("routeOrthogonal", () => {
  it("returns a minimal M/L route when no obstacle blocks the ports", () => {
    const result = routeOrthogonal({
      source: { x: 0, y: 0, width: 40, height: 40 },
      target: { x: 120, y: 0, width: 40, height: 40 },
      padding: 8,
      grid: 8,
    });

    expect(result.usedFallback).toBe(false);
    expect(result.diagnostics).toEqual([]);
    expect(result.points).toEqual([{ x: 40, y: 20 }, { x: 120, y: 20 }]);
    expect(result.path.segments).toEqual([
      { kind: "move", to: { x: 40, y: 20 } },
      { kind: "line", to: { x: 120, y: 20 } },
    ]);
  });

  it("honors explicit source and target port sides", () => {
    const result = routeOrthogonal({
      source: { x: 20, y: 120, width: 60, height: 40 },
      sourcePort: "top",
      target: { x: 20, y: 0, width: 60, height: 40 },
      targetPort: "bottom",
      padding: 10,
    });

    expect(result.points[0]).toEqual({ x: 50, y: 120 });
    expect(result.points.at(-1)).toEqual({ x: 50, y: 40 });
    expect(result.usedFallback).toBe(false);
  });

  it("routes around one obstacle without entering its padded interior", () => {
    const obstacle = { x: 70, y: 0, width: 40, height: 80 };
    const result = routeOrthogonal({
      source: { x: 0, y: 20, width: 40, height: 40 },
      target: { x: 160, y: 20, width: 40, height: 40 },
      obstacles: [obstacle],
      padding: 8,
      grid: 8,
    });

    expect(result.usedFallback).toBe(false);
    expect(result.points.length).toBeGreaterThan(2);
    expect(routeCrossesBounds(result.points, obstacle)).toBe(false);
    expect(hasOnlyOrthogonalSegments(result.points)).toBe(true);
  });

  it("routes deterministically around multiple obstacles and compresses collinear points", () => {
    const request = {
      source: { x: 0, y: 30, width: 40, height: 40 },
      target: { x: 300, y: 30, width: 40, height: 40 },
      obstacles: [
        { x: 80, y: 0, width: 40, height: 100 },
        { x: 180, y: 20, width: 40, height: 100 },
      ],
      padding: 8,
      grid: 8,
    } as const;
    const first = routeOrthogonal(request);
    const second = routeOrthogonal(request);

    expect(first).toEqual(second);
    expect(first.usedFallback).toBe(false);
    expect(request.obstacles.every((obstacle) =>
      !routeCrossesBounds(first.points, obstacle))).toBe(true);
    for (let index = 1; index < first.points.length - 1; index += 1) {
      const previous = first.points[index - 1]!;
      const point = first.points[index]!;
      const next = first.points[index + 1]!;
      expect(previous.x === point.x && point.x === next.x
        || previous.y === point.y && point.y === next.y).toBe(false);
    }
  });

  it("allows overlapping source and target bounds while avoiding external obstacles", () => {
    const obstacle = { x: 43, y: 25, width: 5, height: 10 };
    const result = routeOrthogonal({
      source: { x: 0, y: 0, width: 60, height: 60 },
      sourcePort: "right",
      target: { x: 30, y: 0, width: 60, height: 60 },
      targetPort: "left",
      obstacles: [obstacle],
      padding: 4,
      grid: 2,
    });

    expect(result.usedFallback).toBe(false);
    expect(routeCrossesBounds(result.points, obstacle)).toBe(false);
  });

  it("falls back deterministically when the search budget is exhausted", () => {
    const result = routeOrthogonal({
      source: { x: 0, y: 0, width: 40, height: 40 },
      target: { x: 180, y: 0, width: 40, height: 40 },
      obstacles: [{ x: 80, y: -20, width: 40, height: 100 }],
      maxSearchBudget: 1,
    });

    expect(result.usedFallback).toBe(true);
    expect(result.points).toEqual([{ x: 40, y: 20 }, { x: 180, y: 20 }]);
    expect(result.diagnostics.map(({ code }) => code)).toEqual([
      "ORTHOGONAL_ROUTE_BUDGET_EXCEEDED",
      "ORTHOGONAL_ROUTE_FALLBACK_STRAIGHT",
    ]);
  });

  it("uses a diagnosed straight fallback when a port exit is blocked", () => {
    const result = routeOrthogonal({
      source: { x: 0, y: 0, width: 40, height: 40 },
      sourcePort: "right",
      target: { x: 140, y: 0, width: 40, height: 40 },
      targetPort: "left",
      obstacles: [{ x: 41, y: 10, width: 20, height: 20 }],
      padding: 8,
    });
    expect(result.usedFallback).toBe(true);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "ORTHOGONAL_ROUTE_PORT_BLOCKED",
    }));
  });

  it.each([
    { source: { x: Number.NaN, y: 0, width: 10, height: 10 }, target: { x: 20, y: 0, width: 10, height: 10 } },
    { source: { x: 0, y: 0, width: 0, height: 10 }, target: { x: 20, y: 0, width: 10, height: 10 } },
    { source: { x: 0, y: 0, width: 10, height: 10 }, target: { x: 20, y: 0, width: 10, height: 10 }, padding: Number.POSITIVE_INFINITY },
    { source: { x: 0, y: 0, width: 10, height: 10 }, target: { x: 20, y: 0, width: 10, height: 10 }, grid: 0 },
    { source: { x: 0, y: 0, width: 10, height: 10 }, target: { x: 20, y: 0, width: 10, height: 10 }, maxSearchBudget: 1.5 },
  ])("rejects invalid or non-finite routing input", (request) => {
    expect(() => routeOrthogonal(request)).toThrow();
  });
});

function hasOnlyOrthogonalSegments(points: readonly Point[]): boolean {
  return points.slice(1).every((point, index) =>
    point.x === points[index]!.x || point.y === points[index]!.y);
}

function routeCrossesBounds(points: readonly Point[], bounds: Bounds): boolean {
  return points.slice(1).some((point, index) => {
    const start = points[index]!;
    if (start.y === point.y) {
      return start.y > bounds.y && start.y < bounds.y + bounds.height
        && Math.max(Math.min(start.x, point.x), bounds.x)
          < Math.min(Math.max(start.x, point.x), bounds.x + bounds.width);
    }
    if (start.x === point.x) {
      return start.x > bounds.x && start.x < bounds.x + bounds.width
        && Math.max(Math.min(start.y, point.y), bounds.y)
          < Math.min(Math.max(start.y, point.y), bounds.y + bounds.height);
    }
    return true;
  });
}
