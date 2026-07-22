import type { DiagramEdge, DiagramLineDash } from "./types.js";

/** Normalize public-IR dash arrays for SVG/draw.io importers.
 * SVG repeats odd-length patterns, but several desktop importers do not, so
 * make that repetition explicit (for example `[2]` becomes `[2, 2]`).
 */
export function nonZeroDashArray(
  values: readonly number[] | undefined,
): readonly number[] | undefined {
  if (!values || values.length === 0) return undefined;
  if (values.some((value) => !Number.isFinite(value) || value < 0)) return undefined;
  if (!values.some((value) => value > 0)) return undefined;
  return values.length % 2 === 0 ? values : [...values, ...values];
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
