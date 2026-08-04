import type {
  Bounds,
  ConversionDiagnostic,
  DiagramPath,
  DiagramIR,
  Point,
} from "../types.js";

export const LAYOUT_SIDECAR_SCHEMA = "mmd2pptx-layout" as const;
export const LAYOUT_SIDECAR_VERSION = 1 as const;

export type LayoutBounds = Bounds;
export type LayoutPoint = Point;
export type LayoutIdentityKind = "semanticId" | "sourceKey" | "id";

export interface LayoutIdentity {
  kind: LayoutIdentityKind;
  value: string;
}

export type NodeLayoutMode = "auto" | "manual";
export type LayoutPortSide = "auto" | "top" | "right" | "bottom" | "left";

export interface NodeLayoutEntry {
  bounds: LayoutBounds;
  identity: LayoutIdentity;
  mode: NodeLayoutMode;
  zIndex?: number;
}

/** A manually adjusted edge route. `points` remains the v1 polyline fallback. */
export interface EdgeLayoutEntry {
  identity: LayoutIdentity;
  /** Offset from the routed path midpoint. */
  labelOffset?: LayoutPoint;
  labelZIndex?: number;
  /** Optional full-fidelity absolute path, including quadratic/cubic controls. */
  path?: DiagramPath;
  points: LayoutPoint[];
  source: LayoutIdentity;
  sourcePort?: LayoutPortSide;
  target: LayoutIdentity;
  targetPort?: LayoutPortSide;
  zIndex?: number;
}

export interface LayoutGroupEntry {
  bounds: LayoutBounds;
  children: LayoutIdentity[];
  /** Stable source group id, or a generated `layout-group-*` id. */
  id: string;
  zIndex?: number;
}

export interface LayoutSidecarV1 {
  edges: EdgeLayoutEntry[];
  /** Optional so legacy v1 sidecars remain distinguishable and valid. */
  groups?: LayoutGroupEntry[];
  nodes: NodeLayoutEntry[];
  schema: typeof LAYOUT_SIDECAR_SCHEMA;
  version: typeof LAYOUT_SIDECAR_VERSION;
}

export type LayoutSidecar = LayoutSidecarV1;

export interface LayoutReconcileChanges {
  newNodeIds: string[];
  preservedNodeIds: string[];
  relocatedNodeIds: string[];
  removedEdgeOverrideKeys: string[];
  removedGroupIds: string[];
  removedNodeKeys: string[];
}

export interface LayoutReconcileOptions {
  /** Minimum empty space around newly placed nodes. Defaults to 24. */
  collisionPadding?: number;
}

export interface LayoutReconcileResult {
  changes: LayoutReconcileChanges;
  diagnostics: ConversionDiagnostic[];
  diagram: DiagramIR;
  sidecar: LayoutSidecar;
}
