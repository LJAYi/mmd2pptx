import { layoutIdentityKey } from "./identity.js";
import {
  LAYOUT_SIDECAR_SCHEMA,
  LAYOUT_SIDECAR_VERSION,
  type EdgeLayoutEntry,
  type LayoutBounds,
  type LayoutGroupEntry,
  type LayoutIdentity,
  type LayoutPoint,
  type LayoutPortSide,
  type LayoutSidecar,
  type NodeLayoutEntry,
} from "./types.js";
import type { DiagramPath, DiagramPathSegment } from "../types.js";

export type LayoutSidecarErrorCode =
  | "INVALID_JSON"
  | "INVALID_SIDECAR"
  | "UNSUPPORTED_SCHEMA"
  | "UNSUPPORTED_VERSION";

export class LayoutSidecarError extends Error {
  readonly code: LayoutSidecarErrorCode;

  constructor(code: LayoutSidecarErrorCode, message: string) {
    super(message);
    this.name = "LayoutSidecarError";
    this.code = code;
  }
}

export function createEmptyLayoutSidecar(): LayoutSidecar {
  return { edges: [], nodes: [], schema: LAYOUT_SIDECAR_SCHEMA, version: LAYOUT_SIDECAR_VERSION };
}

export function parseLayoutSidecar(source: string | unknown): LayoutSidecar {
  let value: unknown = source;
  if (typeof source === "string") {
    try {
      value = JSON.parse(source) as unknown;
    } catch (error) {
      throw new LayoutSidecarError("INVALID_JSON", `Layout sidecar is not valid JSON: ${message(error)}`);
    }
  }
  if (!isRecord(value)) invalid("Layout sidecar must be a JSON object.");
  if (value.schema !== LAYOUT_SIDECAR_SCHEMA) {
    throw new LayoutSidecarError("UNSUPPORTED_SCHEMA", `Expected schema ${LAYOUT_SIDECAR_SCHEMA}.`);
  }
  if (value.version !== LAYOUT_SIDECAR_VERSION) {
    throw new LayoutSidecarError("UNSUPPORTED_VERSION", `Unsupported layout sidecar version: ${String(value.version)}.`);
  }
  if (!Array.isArray(value.nodes) || !Array.isArray(value.edges)) {
    invalid("Layout sidecar nodes and edges must be arrays.");
  }
  const nodes = value.nodes.map(parseNode);
  const edges = value.edges.map(parseEdge);
  const groups = value.groups === undefined
    ? undefined
    : Array.isArray(value.groups)
      ? value.groups.map(parseGroup)
      : invalid("Layout sidecar groups must be an array when provided.");
  assertUnique(nodes.map(({ identity }) => identity), "node");
  assertUnique(edges.map(({ identity }) => identity), "edge");
  assertEdgeReferences(nodes, edges);
  if (groups) assertGroupReferences(nodes, groups);
  return canonicalSidecar({
    edges,
    ...(groups ? { groups } : {}),
    nodes,
    schema: LAYOUT_SIDECAR_SCHEMA,
    version: LAYOUT_SIDECAR_VERSION,
  });
}

export function serializeLayoutSidecar(sidecar: LayoutSidecar): string {
  return `${JSON.stringify(parseLayoutSidecar(sidecar), null, 2)}\n`;
}

export function canonicalSidecar(sidecar: LayoutSidecar): LayoutSidecar {
  return {
    edges: sidecar.edges.map(cloneEdge).sort((a, b) =>
      layoutIdentityKey(a.identity).localeCompare(layoutIdentityKey(b.identity))),
    ...(sidecar.groups === undefined ? {} : {
      groups: sidecar.groups.map(cloneGroup).sort((a, b) => a.id.localeCompare(b.id)),
    }),
    nodes: sidecar.nodes.map(cloneNode).sort((a, b) =>
      layoutIdentityKey(a.identity).localeCompare(layoutIdentityKey(b.identity))),
    schema: LAYOUT_SIDECAR_SCHEMA,
    version: LAYOUT_SIDECAR_VERSION,
  };
}

function parseNode(value: unknown, index: number): NodeLayoutEntry {
  if (!isRecord(value)) invalid(`nodes[${index}] must be an object.`);
  if (value.mode !== "auto" && value.mode !== "manual") {
    invalid(`nodes[${index}].mode must be auto or manual.`);
  }
  return {
    bounds: parseBounds(value.bounds, `nodes[${index}].bounds`),
    identity: parseIdentity(value.identity, `nodes[${index}].identity`),
    mode: value.mode,
    ...(value.zIndex === undefined
      ? {}
      : { zIndex: integer(value.zIndex, `nodes[${index}].zIndex`) }),
  };
}

function parseEdge(value: unknown, index: number): EdgeLayoutEntry {
  if (!isRecord(value)) invalid(`edges[${index}] must be an object.`);
  if (!Array.isArray(value.points) || value.points.length < 2) {
    invalid(`edges[${index}].points must contain at least two points.`);
  }
  return {
    identity: parseIdentity(value.identity, `edges[${index}].identity`),
    ...(value.labelOffset === undefined
      ? {}
      : { labelOffset: parsePoint(value.labelOffset, `edges[${index}].labelOffset`) }),
    ...(value.labelZIndex === undefined
      ? {}
      : { labelZIndex: integer(value.labelZIndex, `edges[${index}].labelZIndex`) }),
    ...(value.path === undefined ? {} : { path: parsePath(value.path, `edges[${index}].path`) }),
    points: value.points.map((point, pointIndex) =>
      parsePoint(point, `edges[${index}].points[${pointIndex}]`)),
    source: parseIdentity(value.source, `edges[${index}].source`),
    ...(value.sourcePort === undefined
      ? {}
      : { sourcePort: parsePort(value.sourcePort, `edges[${index}].sourcePort`) }),
    target: parseIdentity(value.target, `edges[${index}].target`),
    ...(value.targetPort === undefined
      ? {}
      : { targetPort: parsePort(value.targetPort, `edges[${index}].targetPort`) }),
    ...(value.zIndex === undefined
      ? {}
      : { zIndex: integer(value.zIndex, `edges[${index}].zIndex`) }),
  };
}

function parseGroup(value: unknown, index: number): LayoutGroupEntry {
  if (!isRecord(value)) invalid(`groups[${index}] must be an object.`);
  if (typeof value.id !== "string" || value.id.trim().length === 0) {
    invalid(`groups[${index}].id must be a non-empty string.`);
  }
  if (!Array.isArray(value.children)) invalid(`groups[${index}].children must be an array.`);
  return {
    bounds: parseBounds(value.bounds, `groups[${index}].bounds`),
    children: value.children.map((child, childIndex) =>
      parseIdentity(child, `groups[${index}].children[${childIndex}]`)),
    id: value.id,
    ...(value.zIndex === undefined
      ? {}
      : { zIndex: integer(value.zIndex, `groups[${index}].zIndex`) }),
  };
}

function parsePath(value: unknown, path: string): DiagramPath {
  if (!isRecord(value) || !Array.isArray(value.segments) || value.segments.length < 2) {
    invalid(`${path}.segments must contain an initial move and at least one drawable segment.`);
  }
  const segments = value.segments.map((segment, index) =>
    parsePathSegment(segment, `${path}.segments[${index}]`));
  if (segments[0]?.kind !== "move") invalid(`${path}.segments must begin with move.`);
  return { segments };
}

function parsePathSegment(value: unknown, path: string): DiagramPathSegment {
  if (!isRecord(value) || typeof value.kind !== "string") invalid(`${path} must be a path segment.`);
  if (value.kind === "close") return { kind: "close" };
  const to = parsePoint(value.to, `${path}.to`);
  if (value.kind === "move" || value.kind === "line") return { kind: value.kind, to };
  if (value.kind === "quadratic") {
    return { control: parsePoint(value.control, `${path}.control`), kind: "quadratic", to };
  }
  if (value.kind === "cubic") {
    return {
      control1: parsePoint(value.control1, `${path}.control1`),
      control2: parsePoint(value.control2, `${path}.control2`),
      kind: "cubic",
      to,
    };
  }
  if (value.kind === "arc") {
    if (typeof value.largeArc !== "boolean" || typeof value.sweep !== "boolean") {
      invalid(`${path} arc flags must be boolean.`);
    }
    const radiusX = finite(value.radiusX, `${path}.radiusX`);
    const radiusY = finite(value.radiusY, `${path}.radiusY`);
    if (radiusX < 0 || radiusY < 0) invalid(`${path} arc radii must be non-negative.`);
    return {
      kind: "arc",
      largeArc: value.largeArc,
      radiusX,
      radiusY,
      rotation: finite(value.rotation, `${path}.rotation`),
      sweep: value.sweep,
      to,
    };
  }
  return invalid(`${path}.kind is not supported.`);
}

function parsePort(value: unknown, path: string): LayoutPortSide {
  if (value !== "auto" && value !== "top" && value !== "right"
    && value !== "bottom" && value !== "left") {
    invalid(`${path} must be auto, top, right, bottom, or left.`);
  }
  return value;
}

function parseIdentity(value: unknown, path: string): LayoutIdentity {
  if (!isRecord(value)) invalid(`${path} must be an object.`);
  if (value.kind !== "semanticId" && value.kind !== "sourceKey" && value.kind !== "id") {
    invalid(`${path}.kind is not supported.`);
  }
  if (typeof value.value !== "string" || value.value.trim().length === 0) {
    invalid(`${path}.value must be a non-empty string.`);
  }
  return { kind: value.kind, value: value.value };
}

function parseBounds(value: unknown, path: string): LayoutBounds {
  if (!isRecord(value)) invalid(`${path} must be an object.`);
  const bounds = {
    height: finite(value.height, `${path}.height`),
    width: finite(value.width, `${path}.width`),
    x: finite(value.x, `${path}.x`),
    y: finite(value.y, `${path}.y`),
  };
  if (bounds.width <= 0 || bounds.height <= 0) invalid(`${path} width and height must be greater than zero.`);
  return bounds;
}

function parsePoint(value: unknown, path: string): LayoutPoint {
  if (!isRecord(value)) invalid(`${path} must be an object.`);
  return { x: finite(value.x, `${path}.x`), y: finite(value.y, `${path}.y`) };
}

function finite(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) invalid(`${path} must be a finite number.`);
  return value;
}

function integer(value: unknown, path: string): number {
  const result = finite(value, path);
  if (!Number.isSafeInteger(result)) invalid(`${path} must be a safe integer.`);
  return result;
}

function assertUnique(identities: LayoutIdentity[], kind: string): void {
  const keys = new Set<string>();
  for (const identity of identities) {
    const key = layoutIdentityKey(identity);
    if (keys.has(key)) invalid(`Duplicate ${kind} identity: ${key}.`);
    keys.add(key);
  }
}

function assertEdgeReferences(nodes: NodeLayoutEntry[], edges: EdgeLayoutEntry[]): void {
  const keys = new Set(nodes.map(({ identity }) => layoutIdentityKey(identity)));
  for (const edge of edges) {
    if (!keys.has(layoutIdentityKey(edge.source)) || !keys.has(layoutIdentityKey(edge.target))) {
      invalid(`Edge ${layoutIdentityKey(edge.identity)} refers to a missing node.`);
    }
  }
}

function assertGroupReferences(nodes: NodeLayoutEntry[], groups: LayoutGroupEntry[]): void {
  const nodeKeys = new Set(nodes.map(({ identity }) => layoutIdentityKey(identity)));
  const groupIds = new Set<string>();
  const assigned = new Set<string>();
  for (const group of groups) {
    if (groupIds.has(group.id)) invalid(`Duplicate group id: ${group.id}.`);
    groupIds.add(group.id);
    for (const identity of group.children) {
      const key = layoutIdentityKey(identity);
      if (!nodeKeys.has(key)) invalid(`Group ${group.id} refers to a missing node: ${key}.`);
      if (assigned.has(key)) invalid(`Node ${key} belongs to more than one layout group.`);
      assigned.add(key);
    }
  }
}

function cloneNode(node: NodeLayoutEntry): NodeLayoutEntry {
  return {
    bounds: { ...node.bounds },
    identity: { ...node.identity },
    mode: node.mode,
    ...(node.zIndex === undefined ? {} : { zIndex: node.zIndex }),
  };
}

function cloneEdge(edge: EdgeLayoutEntry): EdgeLayoutEntry {
  return {
    identity: { ...edge.identity },
    ...(edge.labelOffset ? { labelOffset: { ...edge.labelOffset } } : {}),
    ...(edge.labelZIndex === undefined ? {} : { labelZIndex: edge.labelZIndex }),
    ...(edge.path ? { path: clonePath(edge.path) } : {}),
    points: edge.points.map((point) => ({ ...point })),
    source: { ...edge.source },
    ...(edge.sourcePort ? { sourcePort: edge.sourcePort } : {}),
    target: { ...edge.target },
    ...(edge.targetPort ? { targetPort: edge.targetPort } : {}),
    ...(edge.zIndex === undefined ? {} : { zIndex: edge.zIndex }),
  };
}

function cloneGroup(group: LayoutGroupEntry): LayoutGroupEntry {
  return {
    bounds: { ...group.bounds },
    children: group.children.map((identity) => ({ ...identity })),
    id: group.id,
    ...(group.zIndex === undefined ? {} : { zIndex: group.zIndex }),
  };
}

function clonePath(path: DiagramPath): DiagramPath {
  return { segments: path.segments.map((segment) => {
    if (segment.kind === "close") return segment;
    if (segment.kind === "cubic") return {
      ...segment,
      control1: { ...segment.control1 },
      control2: { ...segment.control2 },
      to: { ...segment.to },
    };
    if (segment.kind === "quadratic") return {
      ...segment,
      control: { ...segment.control },
      to: { ...segment.to },
    };
    return { ...segment, to: { ...segment.to } };
  }) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(messageValue: string): never {
  throw new LayoutSidecarError("INVALID_SIDECAR", messageValue);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
