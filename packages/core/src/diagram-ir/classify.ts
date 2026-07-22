import type { DiagramPath } from "./types.js";

export type DiagramPathKind =
  | "complex"
  | "curved"
  | "orthogonal"
  | "polyline"
  | "straight";

export function classifyDiagramPath(path: DiagramPath): DiagramPathKind {
  const drawable = path.segments.filter(({ kind }) => kind !== "move");
  const moves = path.segments.filter(({ kind }) => kind === "move");
  if (moves.length !== 1 || drawable.some(({ kind }) => kind === "close" || kind === "arc")) {
    return "complex";
  }
  if (drawable.some(({ kind }) => kind === "cubic" || kind === "quadratic")) {
    return drawable.every(({ kind }) => kind === "cubic" || kind === "quadratic")
      ? "curved"
      : "complex";
  }
  if (!drawable.every(({ kind }) => kind === "line")) return "complex";
  if (drawable.length === 1) return "straight";

  let previous = path.segments[0]?.kind === "move" ? path.segments[0].to : undefined;
  let orthogonal = true;
  for (const segment of drawable) {
    if (segment.kind !== "line" || !previous) return "complex";
    const horizontal = nearlyEqual(previous.y, segment.to.y);
    const vertical = nearlyEqual(previous.x, segment.to.x);
    orthogonal &&= horizontal || vertical;
    previous = segment.to;
  }
  return orthogonal ? "orthogonal" : "polyline";
}

function nearlyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= 0.0001;
}
