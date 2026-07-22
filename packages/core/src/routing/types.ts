import type {
  Bounds,
  ConversionDiagnostic,
  DiagramPath,
  Point,
} from "../types.js";

export type OrthogonalPort = "top" | "right" | "bottom" | "left";

export interface OrthogonalRouteRequest {
  /** Grid size used to quantize padded obstacle boundaries. Defaults to 8. */
  grid?: number;
  /** Maximum A* node expansions before deterministic straight fallback. */
  maxSearchBudget?: number;
  obstacles?: readonly Bounds[];
  /** Clearance around obstacles and port exit stubs. Defaults to 12. */
  padding?: number;
  source: Bounds;
  sourcePort?: OrthogonalPort;
  target: Bounds;
  targetPort?: OrthogonalPort;
}

export interface OrthogonalRouteResult {
  diagnostics: ConversionDiagnostic[];
  path: DiagramPath;
  points: Point[];
  usedFallback: boolean;
  visitedNodes: number;
}
