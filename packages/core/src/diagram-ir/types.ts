export interface DiagramPoint {
  x: number;
  y: number;
}

export interface AffineTransform {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export type DiagramPathSegment =
  | { kind: "move"; to: DiagramPoint }
  | { kind: "line"; to: DiagramPoint }
  | {
      control1: DiagramPoint;
      control2: DiagramPoint;
      kind: "cubic";
      to: DiagramPoint;
    }
  | { control: DiagramPoint; kind: "quadratic"; to: DiagramPoint }
  | {
      kind: "arc";
      largeArc: boolean;
      radiusX: number;
      radiusY: number;
      rotation: number;
      sweep: boolean;
      to: DiagramPoint;
    }
  | { kind: "close" };

export interface DiagramPath {
  /** Absolute, canonical path segments in diagram coordinates. */
  segments: DiagramPathSegment[];
}

export type DiagramLineCap = "butt" | "round" | "square";
export type DiagramLineJoin = "bevel" | "miter" | "round";

export interface DiagramStrokeStyle {
  color?: string;
  dashArray?: number[];
  dashOffset?: number;
  lineCap?: DiagramLineCap;
  lineJoin?: DiagramLineJoin;
  opacity?: number;
  width?: number;
}

export interface DiagramSourceReference {
  /** Stable renderer or semantic element identifier. */
  elementId: string;
  kind: "edge" | "group" | "label" | "node";
}

export interface DiagramSourceMetadata {
  diagramType?: string;
  kind: "mermaid";
  mermaidVersion?: string;
}

export type DiagramIrSchemaVersion = "1.0";
