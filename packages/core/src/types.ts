import type {
  DiagramIrSchemaVersion,
  DiagramPath,
  DiagramPoint,
  DiagramSourceMetadata,
  DiagramSourceReference,
  DiagramStrokeStyle,
} from "./diagram-ir/types.js";

export type DiagnosticSeverity = "info" | "warning" | "error";

export interface ConversionDiagnostic {
  code: string;
  message: string;
  severity: DiagnosticSeverity;
  elementId?: string;
}

export interface ConversionOptions {
  backgroundColor?: string;
  fileName?: string;
  fontFamily?: string;
  layout?: "wide" | "standard";
  mode?: "exact" | "faithful" | "smart";
  padding?: number;
  title?: string;
}

export interface ConversionSummary {
  /** Target-native editable objects; parse/layout operations report logical IR objects. */
  editableObjects: number;
  edges: number;
  /** Number of element objects that required fallback, not document-level notes. */
  fallbackObjects: number;
  nodes: number;
}

export interface ConversionResult<T> {
  data: T;
  diagnostics: ConversionDiagnostic[];
  summary: ConversionSummary;
}

export type Point = DiagramPoint;

export interface Bounds extends Point {
  height: number;
  width: number;
}

export interface DiagramText {
  bounds: Bounds;
  color?: string;
  fontFamily?: string;
  fontSize?: number;
  text: string;
  zIndex?: number;
}

export type DiagramNodeKind =
  | "rect"
  | "roundRect"
  | "ellipse"
  | "diamond"
  | "hexagon"
  | "parallelogram"
  | "trapezoid"
  | "cylinder";

export type DiagramArrowKind = "none" | "arrow" | "triangle" | "diamond" | "oval";

export type DiagramLineDash = "solid" | "dash" | "dot";

export interface DiagramNode {
  bounds: Bounds;
  fill?: string;
  id: string;
  kind: DiagramNodeKind;
  parentId?: string;
  semanticId?: string;
  sourceKey?: string;
  stroke?: string;
  strokeWidth?: number;
  sourceRef?: DiagramSourceReference;
  text?: DiagramText;
  zIndex?: number;
}

/** Editable flowchart container/subgraph in absolute diagram coordinates. */
export interface DiagramGroup {
  bounds: Bounds;
  fill?: string;
  id: string;
  parentId?: string;
  semanticId?: string;
  sourceKey?: string;
  sourceRef?: DiagramSourceReference;
  stroke?: string;
  strokeWidth?: number;
  text?: DiagramText;
  zIndex?: number;
}

export interface DiagramEdge {
  color?: string;
  dash?: DiagramLineDash;
  /** Full canonical geometry. `points` remains available for legacy consumers. */
  path?: DiagramPath;
  end: Point;
  endArrow?: DiagramArrowKind;
  id: string;
  label?: DiagramText;
  points?: Point[];
  sourceKey?: string;
  sourceId?: string;
  sourcePort?: string;
  sourceRef?: DiagramSourceReference;
  start: Point;
  startArrow?: DiagramArrowKind;
  stroke?: DiagramStrokeStyle;
  strokeWidth?: number;
  targetId?: string;
  targetPort?: string;
  zIndex?: number;
}

export interface DiagramIR {
  backgroundColor?: string;
  edges: DiagramEdge[];
  groups?: DiagramGroup[];
  height: number;
  nodes: DiagramNode[];
  schemaVersion?: DiagramIrSchemaVersion;
  source?: DiagramSourceMetadata;
  width: number;
}

export type {
  DiagramIrSchemaVersion,
  DiagramPath,
  DiagramPathSegment,
  DiagramSourceMetadata,
  DiagramSourceReference,
  DiagramStrokeStyle,
} from "./diagram-ir/types.js";
