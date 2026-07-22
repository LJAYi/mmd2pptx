import type { Bounds, DiagramEdge, DiagramGroup, DiagramIR, DiagramNode } from "../types.js";
import { applyLayoutSidecar } from "./apply.js";
import {
  layoutIdentityKey,
  objectMatchesLayoutIdentity,
  selectLayoutIdentity,
} from "./identity.js";
import { canonicalSidecar, createEmptyLayoutSidecar, parseLayoutSidecar } from "./sidecar.js";
import type {
  EdgeLayoutEntry,
  LayoutGroupEntry,
  LayoutIdentity,
  LayoutReconcileOptions,
  LayoutReconcileResult,
  LayoutSidecar,
  NodeLayoutEntry,
} from "./types.js";

const DEFAULT_COLLISION_PADDING = 24;

export function reconcileLayout(
  diagram: DiagramIR,
  previous: LayoutSidecar = createEmptyLayoutSidecar(),
  options: LayoutReconcileOptions = {},
): LayoutReconcileResult {
  const normalized = parseLayoutSidecar(previous);
  const padding = options.collisionPadding ?? DEFAULT_COLLISION_PADDING;
  if (!Number.isFinite(padding) || padding < 0) {
    throw new Error("collisionPadding must be a non-negative finite number.");
  }
  assertUniqueDiagramNodes(diagram.nodes);

  const previousNodes = new Map(
    normalized.nodes.map((entry) => [layoutIdentityKey(entry.identity), entry]),
  );
  const incomingKeys = new Set<string>();
  const occupied: Bounds[] = [];
  const nodeEntries: NodeLayoutEntry[] = [];
  const newNodeIds: string[] = [];
  const preservedNodeIds: string[] = [];
  const relocatedNodeIds: string[] = [];

  for (const node of diagram.nodes) {
    const identity = selectLayoutIdentity(node);
    const key = layoutIdentityKey(identity);
    if (incomingKeys.has(key)) throw new Error(`Duplicate diagram node layout identity: ${key}.`);
    incomingKeys.add(key);
    const stored = previousNodes.get(key);
    if (stored) {
      preservedNodeIds.push(node.id);
      const bounds = stored.mode === "manual"
        ? { ...stored.bounds }
        : { ...node.bounds, x: stored.bounds.x, y: stored.bounds.y };
      occupied.push(bounds);
      nodeEntries.push({
        bounds,
        identity,
        mode: stored.mode,
        ...((stored.zIndex ?? node.zIndex) === undefined
          ? {}
          : { zIndex: stored.zIndex ?? node.zIndex }),
      });
      continue;
    }
    newNodeIds.push(node.id);
    const bounds = placeWithoutOverlap(node.bounds, occupied, padding);
    if (bounds.x !== node.bounds.x || bounds.y !== node.bounds.y) relocatedNodeIds.push(node.id);
    occupied.push(bounds);
    nodeEntries.push({
      bounds,
      identity,
      mode: "auto",
      ...(node.zIndex === undefined ? {} : { zIndex: node.zIndex }),
    });
  }

  const currentEdges = new Map<string, DiagramEdge>();
  for (const edge of diagram.edges) {
    const key = layoutIdentityKey(selectLayoutIdentity(edge));
    if (currentEdges.has(key)) throw new Error(`Duplicate diagram edge layout identity: ${key}.`);
    currentEdges.set(key, edge);
  }
  const retainedEdges: EdgeLayoutEntry[] = [];
  const removedEdgeOverrideKeys: string[] = [];
  for (const stored of normalized.edges) {
    const key = layoutIdentityKey(stored.identity);
    const edge = currentEdges.get(key);
    const source = edge ? resolveNode(edge.sourceId, diagram.nodes) : undefined;
    const target = edge ? resolveNode(edge.targetId, diagram.nodes) : undefined;
    if (!edge || !source || !target
      || !objectMatchesLayoutIdentity(source, stored.source)
      || !objectMatchesLayoutIdentity(target, stored.target)) {
      removedEdgeOverrideKeys.push(key);
      continue;
    }
    retainedEdges.push(cloneEdge(stored));
  }

  const sourceGroups = diagram.groups ?? [];
  const sourceGroupIds = new Set(sourceGroups.flatMap(groupTokens));
  const previousGroups = new Map((normalized.groups ?? []).map((group) => [group.id, group]));
  const groups: LayoutGroupEntry[] = sourceGroups.map((group) => {
    const id = stableGroupId(group);
    const stored = previousGroups.get(id);
    const children = diagram.nodes
      .filter((node) => node.parentId && groupTokens(group).includes(node.parentId))
      .map(selectLayoutIdentity);
    return {
      bounds: { ...(stored?.bounds ?? group.bounds) },
      children,
      id,
      ...((stored?.zIndex ?? group.zIndex) === undefined
        ? {}
        : { zIndex: stored?.zIndex ?? group.zIndex }),
    };
  });
  const removedGroupIds: string[] = [];
  const assignedChildren = new Set(groups.flatMap(({ children }) => children.map(layoutIdentityKey)));
  for (const stored of normalized.groups ?? []) {
    if (sourceGroupIds.has(stored.id) || groups.some(({ id }) => id === stored.id)) continue;
    if (!stored.id.startsWith("layout-group-")) {
      removedGroupIds.push(stored.id);
      continue;
    }
    const children = stored.children.filter((identity) =>
      incomingKeys.has(layoutIdentityKey(identity)) && !assignedChildren.has(layoutIdentityKey(identity)));
    if (children.length < 2) {
      removedGroupIds.push(stored.id);
      continue;
    }
    children.forEach((identity) => assignedChildren.add(layoutIdentityKey(identity)));
    groups.push({
      bounds: { ...stored.bounds },
      children: children.map((identity) => ({ ...identity })),
      id: stored.id,
      ...(stored.zIndex === undefined ? {} : { zIndex: stored.zIndex }),
    });
  }

  const sidecar = canonicalSidecar({
    edges: retainedEdges,
    ...((normalized.groups !== undefined || groups.length > 0) ? { groups } : {}),
    nodes: nodeEntries,
    schema: normalized.schema,
    version: normalized.version,
  });
  // Reconciliation resolves positions for both retained automatic entries and
  // newly collision-placed nodes. Apply those resolved bounds for this render
  // without changing their persisted automatic/manual mode.
  const applied = applyLayoutSidecar(diagram, {
    ...sidecar,
    nodes: sidecar.nodes.map((entry) => ({ ...entry, mode: "manual" })),
  });
  return {
    changes: {
      newNodeIds,
      preservedNodeIds,
      relocatedNodeIds,
      removedEdgeOverrideKeys,
      removedGroupIds,
      removedNodeKeys: normalized.nodes
        .map(({ identity }) => layoutIdentityKey(identity))
        .filter((key) => !incomingKeys.has(key)),
    },
    diagnostics: applied.diagnostics,
    diagram: applied.data,
    sidecar,
  };
}

export function setManualNodeLayout(
  sidecar: LayoutSidecar,
  identity: LayoutIdentity,
  bounds: Bounds,
): LayoutSidecar {
  assertBounds(bounds, "Manual node layout");
  const key = layoutIdentityKey(identity);
  const existing = sidecar.nodes.find((entry) => layoutIdentityKey(entry.identity) === key);
  return canonicalSidecar({
    ...sidecar,
    nodes: [
      ...sidecar.nodes.filter((entry) => layoutIdentityKey(entry.identity) !== key),
      {
        bounds: { ...bounds },
        identity: { ...identity },
        mode: "manual",
        ...(existing?.zIndex === undefined ? {} : { zIndex: existing.zIndex }),
      },
    ],
  });
}

export function setNodeZIndex(
  sidecar: LayoutSidecar,
  identity: LayoutIdentity,
  zIndex: number,
): LayoutSidecar {
  if (!Number.isSafeInteger(zIndex)) throw new Error("Node zIndex must be a safe integer.");
  const key = layoutIdentityKey(identity);
  const existing = sidecar.nodes.find((entry) => layoutIdentityKey(entry.identity) === key);
  if (!existing) throw new Error(`Node layout identity does not exist: ${key}.`);
  return canonicalSidecar({
    ...sidecar,
    nodes: sidecar.nodes.map((entry) => layoutIdentityKey(entry.identity) === key
      ? { ...entry, zIndex }
      : entry),
  });
}

export function setManualEdgeLayout(
  sidecar: LayoutSidecar,
  edge: EdgeLayoutEntry,
): LayoutSidecar {
  if (edge.points.length < 2 || edge.points.some(({ x, y }) =>
    !Number.isFinite(x) || !Number.isFinite(y))) {
    throw new Error("Manual edge layout requires at least two finite points.");
  }
  const nodeKeys = new Set(sidecar.nodes.map(({ identity }) => layoutIdentityKey(identity)));
  if (!nodeKeys.has(layoutIdentityKey(edge.source))
    || !nodeKeys.has(layoutIdentityKey(edge.target))) {
    throw new Error("Manual edge endpoints must exist in the layout sidecar.");
  }
  const key = layoutIdentityKey(edge.identity);
  return canonicalSidecar({
    ...sidecar,
    edges: [
      ...sidecar.edges.filter((entry) => layoutIdentityKey(entry.identity) !== key),
      cloneEdge(edge),
    ],
  });
}

export function setManualGroupLayout(
  sidecar: LayoutSidecar,
  group: LayoutGroupEntry,
): LayoutSidecar {
  assertBounds(group.bounds, `Group ${group.id}`);
  if (!group.id.trim()) throw new Error("Layout group id must be non-empty.");
  if (group.children.length < 2) throw new Error("A layout group requires at least two child nodes.");
  const nodeKeys = new Set(sidecar.nodes.map(({ identity }) => layoutIdentityKey(identity)));
  const childKeys = new Set(group.children.map(layoutIdentityKey));
  if (childKeys.size !== group.children.length
    || [...childKeys].some((key) => !nodeKeys.has(key))) {
    throw new Error("Layout group children must be unique nodes in the sidecar.");
  }
  const otherChildren = new Set((sidecar.groups ?? [])
    .filter(({ id }) => id !== group.id)
    .flatMap(({ children }) => children.map(layoutIdentityKey)));
  if ([...childKeys].some((key) => otherChildren.has(key))) {
    throw new Error("A node cannot belong to more than one layout group.");
  }
  return canonicalSidecar({
    ...sidecar,
    groups: [
      ...(sidecar.groups ?? []).filter(({ id }) => id !== group.id),
      {
        bounds: { ...group.bounds },
        children: group.children.map((identity) => ({ ...identity })),
        id: group.id,
        ...(group.zIndex === undefined ? {} : { zIndex: group.zIndex }),
      },
    ],
  });
}

export function removeLayoutGroup(sidecar: LayoutSidecar, id: string): LayoutSidecar {
  return canonicalSidecar({
    ...sidecar,
    groups: (sidecar.groups ?? []).filter((group) => group.id !== id),
  });
}

export function restoreAutomaticLayout(
  sidecar: LayoutSidecar,
  identities?: readonly LayoutIdentity[],
): LayoutSidecar {
  if (identities === undefined) return createEmptyLayoutSidecar();
  const reset = new Set(identities.map(layoutIdentityKey));
  const groups = sidecar.groups?.flatMap((group) => {
    const children = group.children.filter((identity) => !reset.has(layoutIdentityKey(identity)));
    return children.length < 2 ? [] : [{ ...group, children }];
  });
  return canonicalSidecar({
    ...sidecar,
    edges: sidecar.edges.filter((edge) =>
      !reset.has(layoutIdentityKey(edge.source)) && !reset.has(layoutIdentityKey(edge.target))),
    nodes: sidecar.nodes.filter((node) => !reset.has(layoutIdentityKey(node.identity))),
    ...(groups === undefined ? {} : { groups }),
  });
}

function resolveNode(id: string | undefined, nodes: readonly DiagramNode[]): DiagramNode | undefined {
  if (!id) return undefined;
  return nodes.find((node) => node.id === id || node.semanticId === id || node.sourceKey === id);
}

function placeWithoutOverlap(requested: Bounds, occupied: readonly Bounds[], padding: number): Bounds {
  let candidate = { ...requested };
  for (let attempt = 0; attempt < 10_000; attempt += 1) {
    const collisions = occupied.filter((bounds) => overlaps(candidate, bounds, padding));
    if (collisions.length === 0) return candidate;
    candidate = {
      ...candidate,
      y: Math.max(...collisions.map((bounds) => bounds.y + bounds.height + padding)),
    };
  }
  throw new Error("Unable to place a new node without overlap.");
}

function overlaps(left: Bounds, right: Bounds, padding: number): boolean {
  return left.x < right.x + right.width + padding
    && left.x + left.width + padding > right.x
    && left.y < right.y + right.height + padding
    && left.y + left.height + padding > right.y;
}

function assertUniqueDiagramNodes(nodes: readonly DiagramNode[]): void {
  const ids = new Set(nodes.map(({ id }) => id));
  if (ids.size !== nodes.length) throw new Error("Diagram node ids must be unique.");
  for (const node of nodes) assertBounds(node.bounds, `Node ${node.id}`);
}

function assertBounds(bounds: Bounds, label: string): void {
  if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)
    || bounds.width <= 0 || bounds.height <= 0) {
    throw new Error(`${label} bounds must be finite with positive dimensions.`);
  }
}

function cloneEdge(edge: EdgeLayoutEntry): EdgeLayoutEntry {
  return {
    identity: { ...edge.identity },
    ...(edge.labelOffset ? { labelOffset: { ...edge.labelOffset } } : {}),
    ...(edge.labelZIndex === undefined ? {} : { labelZIndex: edge.labelZIndex }),
    ...(edge.path ? { path: { segments: edge.path.segments.map(clonePathSegment) } } : {}),
    points: edge.points.map((point) => ({ ...point })),
    source: { ...edge.source },
    ...(edge.sourcePort ? { sourcePort: edge.sourcePort } : {}),
    target: { ...edge.target },
    ...(edge.targetPort ? { targetPort: edge.targetPort } : {}),
    ...(edge.zIndex === undefined ? {} : { zIndex: edge.zIndex }),
  };
}

function stableGroupId(group: DiagramGroup): string {
  return group.semanticId ?? group.sourceKey ?? group.id;
}

function groupTokens(group: DiagramGroup): string[] {
  return [group.id, group.semanticId, group.sourceKey].filter((value): value is string => Boolean(value));
}

function clonePathSegment(segment: NonNullable<DiagramEdge["path"]>["segments"][number]) {
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
}
