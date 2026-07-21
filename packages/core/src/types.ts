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
  padding?: number;
  title?: string;
}

export interface ConversionSummary {
  editableObjects: number;
  edges: number;
  fallbackObjects: number;
  nodes: number;
}

export interface ConversionResult<T> {
  data: T;
  diagnostics: ConversionDiagnostic[];
  summary: ConversionSummary;
}

export interface Point {
  x: number;
  y: number;
}

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
  stroke?: string;
  strokeWidth?: number;
  text?: DiagramText;
}

export interface DiagramEdge {
  color?: string;
  dash?: DiagramLineDash;
  end: Point;
  endArrow?: DiagramArrowKind;
  id: string;
  label?: DiagramText;
  points?: Point[];
  start: Point;
  startArrow?: DiagramArrowKind;
  strokeWidth?: number;
}

export interface DiagramIR {
  backgroundColor?: string;
  edges: DiagramEdge[];
  height: number;
  nodes: DiagramNode[];
  width: number;
}
