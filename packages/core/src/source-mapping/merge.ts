import type {
  ConversionDiagnostic,
  DiagramEdge,
  DiagramGroup,
  DiagramIR,
  DiagramNode,
} from "../types.js";
import type {
  MermaidSemanticEdge,
  MermaidSemanticGraph,
  MermaidSemanticMergeResult,
} from "./types.js";

interface IrSemanticObject {
  id: string;
  semanticId?: string;
  sourceKey?: string;
  sourceRef?: { elementId: string };
}

/**
 * Adds source semantics to an SVG-derived IR. Geometry, appearance, labels and
 * object order remain authoritative from the SVG parser.
 */
export function mergeMermaidSemantics(
  diagram: DiagramIR,
  graph: MermaidSemanticGraph,
): MermaidSemanticMergeResult {
  const diagnostics: ConversionDiagnostic[] = [];
  const originalNodes = diagram.nodes;
  const originalGroups = diagram.groups ?? [];
  const nodes = originalNodes.map((node) => ({ ...node }));
  const groups = originalGroups.map((group) => ({ ...group }));
  const edges = diagram.edges.map((edge) => ({ ...edge }));
  const nodeAliases = new Map<string, string>();
  const usedNodes = new Set<number>();

  for (const semantic of graph.nodes) {
    const match = uniqueMatch(originalNodes, [semantic.id, semantic.rendererId], usedNodes);
    if (match.kind !== "match") {
      diagnostics.push(matchDiagnostic("NODE", semantic.id, match.kind));
      continue;
    }
    usedNodes.add(match.index);
    for (const alias of aliases(originalNodes[match.index]!)) nodeAliases.set(alias, semantic.id);
    nodeAliases.set(semantic.id, semantic.id);
    if (semantic.rendererId) nodeAliases.set(semantic.rendererId, semantic.id);
    const { parentId: _rendererParentId, ...nodeWithoutParent } = nodes[match.index]!;
    nodes[match.index] = {
      ...nodeWithoutParent,
      semanticId: semantic.id,
      sourceKey: semantic.id,
      ...(semantic.parentId ? { parentId: semantic.parentId } : {}),
    };
  }

  const usedGroups = new Set<number>();
  for (const semantic of graph.groups) {
    const match = uniqueMatch(originalGroups, [semantic.id], usedGroups);
    if (match.kind !== "match") {
      diagnostics.push(matchDiagnostic("GROUP", semantic.id, match.kind));
      continue;
    }
    usedGroups.add(match.index);
    const { parentId: _rendererParentId, ...groupWithoutParent } = groups[match.index]!;
    groups[match.index] = {
      ...groupWithoutParent,
      semanticId: semantic.id,
      sourceKey: semantic.id,
      ...(semantic.parentId ? { parentId: semantic.parentId } : {}),
    };
  }

  mergeEdges(edges, graph.edges, originalNodes, nodeAliases, diagnostics);
  const data: DiagramIR = {
    ...diagram,
    edges,
    ...(diagram.groups !== undefined || groups.length > 0 ? { groups } : {}),
    nodes,
  };
  return { data, diagnostics };
}

function mergeEdges(
  edges: DiagramEdge[],
  semantics: readonly MermaidSemanticEdge[],
  originalNodes: readonly DiagramNode[],
  nodeAliases: ReadonlyMap<string, string>,
  diagnostics: ConversionDiagnostic[],
): void {
  const usedEdges = new Set<number>();
  const pending: MermaidSemanticEdge[] = [];

  for (const semantic of [...semantics].sort((left, right) => left.order - right.order)) {
    const candidates = matchingIndexes(edges, [semantic.id], usedEdges);
    if (candidates.length === 1) {
      applyEdge(edges, candidates[0]!, semantic);
      usedEdges.add(candidates[0]!);
    } else if (candidates.length > 1) {
      diagnostics.push(matchDiagnostic("EDGE", semantic.id, "ambiguous"));
    } else {
      pending.push(semantic);
    }
  }

  for (const semantic of pending) {
    const candidates = edges.flatMap((edge, index) => {
      if (usedEdges.has(index)) return [];
      const sourceId = canonicalEndpoint(edge.sourceId, originalNodes, nodeAliases);
      const targetId = canonicalEndpoint(edge.targetId, originalNodes, nodeAliases);
      return sourceId === semantic.sourceId && targetId === semantic.targetId ? [index] : [];
    });
    if (candidates.length === 0) {
      diagnostics.push(matchDiagnostic("EDGE", semantic.id, "missing"));
      continue;
    }
    const index = candidates[0]!;
    applyEdge(edges, index, semantic);
    usedEdges.add(index);
    if (candidates.length > 1) {
      diagnostics.push({
        code: "MERMAID_SEMANTIC_EDGE_ORDER_MATCH",
        elementId: semantic.id,
        message: `Parallel edge '${semantic.id}' matched by FlowDB and SVG edge order because endpoint identity alone was ambiguous.`,
        severity: "info",
      });
    }
  }
}

function applyEdge(edges: DiagramEdge[], index: number, semantic: MermaidSemanticEdge): void {
  edges[index] = {
    ...edges[index]!,
    sourceId: semantic.sourceId,
    sourceKey: semantic.id,
    targetId: semantic.targetId,
  };
}

function canonicalEndpoint(
  endpoint: string | undefined,
  nodes: readonly DiagramNode[],
  semanticAliases: ReadonlyMap<string, string>,
): string | undefined {
  if (!endpoint) return undefined;
  const direct = semanticAliases.get(endpoint);
  if (direct) return direct;
  const candidates = nodes.filter((node) => aliases(node).includes(endpoint));
  if (candidates.length !== 1) return endpoint;
  for (const alias of aliases(candidates[0]!)) {
    const semantic = semanticAliases.get(alias);
    if (semantic) return semantic;
  }
  return endpoint;
}

function uniqueMatch(
  values: readonly IrSemanticObject[],
  keys: readonly (string | undefined)[],
  used: ReadonlySet<number>,
): { index: number; kind: "match" } | { kind: "ambiguous" | "missing" } {
  const candidates = matchingIndexes(values, keys, used);
  if (candidates.length === 1) return { index: candidates[0]!, kind: "match" };
  return { kind: candidates.length > 1 ? "ambiguous" : "missing" };
}

function matchingIndexes(
  values: readonly IrSemanticObject[],
  keys: readonly (string | undefined)[],
  used: ReadonlySet<number>,
): number[] {
  const expected = new Set(keys.filter((key): key is string => Boolean(key)));
  return values.flatMap((value, index) => {
    if (used.has(index)) return [];
    return aliases(value).some((alias) => expected.has(alias)) ? [index] : [];
  });
}

function aliases(value: IrSemanticObject): string[] {
  return [value.semanticId, value.sourceKey, value.id, value.sourceRef?.elementId]
    .filter((item): item is string => Boolean(item));
}

function matchDiagnostic(
  kind: "EDGE" | "GROUP" | "NODE",
  id: string,
  result: "ambiguous" | "missing",
): ConversionDiagnostic {
  return {
    code: `MERMAID_SEMANTIC_${kind}_${result.toUpperCase()}`,
    elementId: id,
    message: result === "ambiguous"
      ? `More than one SVG ${kind.toLowerCase()} matches Mermaid semantic id '${id}'; source semantics were not applied.`
      : `No SVG ${kind.toLowerCase()} matches Mermaid semantic id '${id}'; source semantics were not applied.`,
    severity: "warning",
  };
}
