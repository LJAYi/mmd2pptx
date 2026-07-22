import type { DiagramEdge, DiagramLineDash } from "./types.js";

/** Normalize public-IR dash arrays; SVG all-zero patterns mean a solid stroke. */
export function nonZeroDashArray(
  values: readonly number[] | undefined,
): readonly number[] | undefined {
  if (!values || values.length === 0) return undefined;
  return values.some((value) => value > 0) ? values : undefined;
}

/** Resolve conflicting legacy `dash` and structured stroke metadata consistently. */
export function effectiveDashKind(edge: DiagramEdge): DiagramLineDash {
  if (edge.stroke?.dashArray !== undefined) {
    const dashArray = nonZeroDashArray(edge.stroke.dashArray);
    if (!dashArray) return "solid";
    const firstDash = dashArray[0] ?? 3;
    const width = edge.stroke.width ?? edge.strokeWidth ?? 1;
    return firstDash <= width * 2 ? "dot" : "dash";
  }
  return edge.dash ?? "solid";
}

/** Preserve custom arrays, otherwise expand the legacy dash kind for SVG. */
export function svgDashArray(edge: DiagramEdge): readonly number[] | undefined {
  if (edge.stroke?.dashArray !== undefined) {
    return nonZeroDashArray(edge.stroke.dashArray);
  }
  return edge.dash === "dash" ? [8, 5]
    : edge.dash === "dot" ? [2, 4]
      : undefined;
}
