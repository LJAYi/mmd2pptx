import type { ConversionDiagnostic } from "../types.js";
import type {
  MermaidSemanticEdge,
  MermaidSemanticExtractionResult,
  MermaidSemanticGraph,
  MermaidSemanticGroup,
  MermaidSemanticNode,
} from "./types.js";

type UnknownRecord = Record<string, unknown>;

interface FlowDbLike extends UnknownRecord {
  getEdges: () => unknown;
  getSubGraphs: () => unknown;
  getVertices: () => unknown;
}

/**
 * Structurally adapts a Mermaid 11 flowchart Diagram/FlowDB without importing
 * Mermaid into core. This deliberately does not parse Mermaid source text.
 */
export function extractMermaidFlowchartSemantics(
  diagramLike: unknown,
): MermaidSemanticExtractionResult {
  const diagnostics: ConversionDiagnostic[] = [];
  const candidate = record(diagramLike);
  const declaredType = stringValue(candidate?.type);
  if (declaredType && declaredType !== "flowchart" && declaredType !== "flowchart-v2") {
    return unsupported(
      diagnostics,
      `Mermaid diagram type '${declaredType}' is not a flowchart.`,
    );
  }

  const dbRecord = record(candidate?.db) ?? candidate;
  if (!isFlowDbLike(dbRecord)) {
    return unsupported(
      diagnostics,
      "The supplied value does not expose Mermaid FlowDB getVertices/getEdges/getSubGraphs methods.",
    );
  }

  let vertexValue: unknown;
  let edgeValue: unknown;
  let groupValue: unknown;
  try {
    vertexValue = dbRecord.getVertices.call(dbRecord);
    edgeValue = dbRecord.getEdges.call(dbRecord);
    groupValue = dbRecord.getSubGraphs.call(dbRecord);
  } catch (error) {
    diagnostics.push({
      code: "MERMAID_FLOWDB_READ_FAILED",
      message: `Mermaid FlowDB could not be read: ${errorMessage(error)}.`,
      severity: "error",
    });
    return { diagnostics, graph: null };
  }

  const vertexEntries = collectionEntries(vertexValue);
  const edgeEntries = collectionEntries(edgeValue);
  const groupEntries = collectionEntries(groupValue);
  if (!vertexEntries || !edgeEntries || !groupEntries) {
    diagnostics.push({
      code: "MERMAID_FLOWDB_COLLECTION_INVALID",
      message: "Mermaid FlowDB returned a vertices, edges, or subgraphs collection with an unsupported shape.",
      severity: "error",
    });
    return { diagnostics, graph: null };
  }

  const nodes = extractNodes(vertexEntries, diagnostics);
  const groups = extractGroups(groupEntries, diagnostics);
  assignMembership(nodes, groups, diagnostics);
  const edges = extractEdges(edgeEntries, new Set(nodes.map(({ id }) => id)), diagnostics);
  const graph: MermaidSemanticGraph = {
    diagramType: "flowchart",
    edges,
    groups,
    nodes,
  };
  return { diagnostics, graph };
}

function extractNodes(
  entries: readonly (readonly [unknown, unknown])[],
  diagnostics: ConversionDiagnostic[],
): MermaidSemanticNode[] {
  const nodes: MermaidSemanticNode[] = [];
  const seen = new Set<string>();
  entries.forEach(([key, value], index) => {
    const vertex = record(value);
    const id = stringValue(vertex?.id) ?? stringValue(key);
    if (!id) {
      diagnostics.push(invalidEntry("NODE", index));
      return;
    }
    if (seen.has(id)) {
      diagnostics.push(duplicateEntry("NODE", id));
      return;
    }
    seen.add(id);
    const rendererId = stringValue(vertex?.domId);
    nodes.push({ id, ...(rendererId ? { rendererId } : {}) });
  });
  return nodes;
}

function extractEdges(
  entries: readonly (readonly [unknown, unknown])[],
  nodeIds: ReadonlySet<string>,
  diagnostics: ConversionDiagnostic[],
): MermaidSemanticEdge[] {
  const edges: MermaidSemanticEdge[] = [];
  const seen = new Set<string>();
  const pairCounts = new Map<string, number>();
  entries.forEach(([, value], order) => {
    const edge = record(value);
    const sourceId = stringValue(edge?.start) ?? stringValue(edge?.source);
    const targetId = stringValue(edge?.end) ?? stringValue(edge?.target);
    if (!sourceId || !targetId) {
      diagnostics.push(invalidEntry("EDGE", order));
      return;
    }
    const pairKey = `${sourceId}\u0000${targetId}`;
    const parallelOrder = pairCounts.get(pairKey) ?? 0;
    pairCounts.set(pairKey, parallelOrder + 1);
    const suppliedId = stringValue(edge?.id);
    let id = suppliedId ?? `L_${sourceId}_${targetId}_${parallelOrder}`;
    if (seen.has(id)) {
      diagnostics.push(duplicateEntry("EDGE", id));
      id = uniqueEdgeId(`L_${sourceId}_${targetId}_${parallelOrder}`, seen);
    }
    seen.add(id);
    if (!nodeIds.has(sourceId) || !nodeIds.has(targetId)) {
      diagnostics.push({
        code: "MERMAID_SEMANTIC_EDGE_ENDPOINT_MISSING",
        elementId: id,
        message: `FlowDB edge '${id}' references a node that is absent from getVertices().`,
        severity: "warning",
      });
    }
    edges.push({ id, order, sourceId, targetId });
  });
  return edges;
}

function extractGroups(
  entries: readonly (readonly [unknown, unknown])[],
  diagnostics: ConversionDiagnostic[],
): MermaidSemanticGroup[] {
  const groups: MermaidSemanticGroup[] = [];
  const seen = new Set<string>();
  entries.forEach(([key, value], index) => {
    const group = record(value);
    const id = stringValue(group?.id) ?? stringValue(key);
    const members = stringArray(group?.nodes);
    if (!id || !members) {
      diagnostics.push(invalidEntry("GROUP", index));
      return;
    }
    if (seen.has(id)) {
      diagnostics.push(duplicateEntry("GROUP", id));
      return;
    }
    seen.add(id);
    groups.push({ id, groupIds: [], nodeIds: [...members] });
  });
  return groups;
}

function assignMembership(
  nodes: MermaidSemanticNode[],
  groups: MermaidSemanticGroup[],
  diagnostics: ConversionDiagnostic[],
): void {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const groupById = new Map(groups.map((group) => [group.id, group]));
  const nodeParents = new Map<string, string[]>();
  const groupParents = new Map<string, string[]>();

  for (const group of groups) {
    const members = group.nodeIds;
    group.nodeIds = [];
    for (const memberId of members) {
      if (groupById.has(memberId)) {
        group.groupIds.push(memberId);
        append(groupParents, memberId, group.id);
      } else if (nodeById.has(memberId)) {
        group.nodeIds.push(memberId);
        append(nodeParents, memberId, group.id);
      } else {
        diagnostics.push({
          code: "MERMAID_SEMANTIC_GROUP_MEMBER_MISSING",
          elementId: group.id,
          message: `FlowDB subgraph '${group.id}' references unknown member '${memberId}'.`,
          severity: "warning",
        });
      }
    }
  }

  for (const node of nodes) {
    const parents = nodeParents.get(node.id) ?? [];
    if (parents.length === 1) node.parentId = parents[0]!;
    if (parents.length > 1) diagnostics.push(ambiguousMembership("node", node.id, parents));
  }
  const proposedGroupParents = new Map<string, string>();
  for (const group of groups) {
    const parents = groupParents.get(group.id) ?? [];
    if (parents.length === 1) proposedGroupParents.set(group.id, parents[0]!);
  }
  for (const group of groups) {
    const parents = groupParents.get(group.id) ?? [];
    if (parents.length === 1 && !wouldCreateCycle(group.id, proposedGroupParents)) {
      group.parentId = parents[0]!;
    } else if (parents.length > 1) {
      diagnostics.push(ambiguousMembership("subgraph", group.id, parents));
    } else if (parents.length === 1) {
      diagnostics.push({
        code: "MERMAID_SEMANTIC_GROUP_CYCLE",
        elementId: group.id,
        message: `FlowDB subgraph membership for '${group.id}' forms a cycle and was ignored.`,
        severity: "warning",
      });
    }
  }
}

function wouldCreateCycle(
  childId: string,
  parents: ReadonlyMap<string, string>,
): boolean {
  const visited = new Set<string>([childId]);
  let current: string | undefined = parents.get(childId);
  while (current) {
    if (visited.has(current)) return true;
    visited.add(current);
    current = parents.get(current);
  }
  return false;
}

function isFlowDbLike(value: UnknownRecord | undefined): value is FlowDbLike {
  return typeof value?.getVertices === "function"
    && typeof value.getEdges === "function"
    && typeof value.getSubGraphs === "function";
}

function collectionEntries(value: unknown): Array<readonly [unknown, unknown]> | null {
  if (Array.isArray(value)) return value.map((item, index) => [index, item] as const);
  if (value instanceof Map) return [...value.entries()];
  const valueRecord = record(value);
  return valueRecord ? Object.entries(valueRecord) : null;
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const result = value.map(stringValue);
  return result.every((item): item is string => Boolean(item)) ? result : null;
}

function record(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object" ? value as UnknownRecord : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function append(map: Map<string, string[]>, key: string, value: string): void {
  map.set(key, [...(map.get(key) ?? []), value]);
}

function uniqueEdgeId(base: string, seen: ReadonlySet<string>): string {
  let suffix = 2;
  let candidate = base;
  while (seen.has(candidate)) candidate = `${base}#${suffix++}`;
  return candidate;
}

function invalidEntry(kind: "EDGE" | "GROUP" | "NODE", index: number): ConversionDiagnostic {
  return {
    code: `MERMAID_SEMANTIC_${kind}_INVALID`,
    message: `FlowDB ${kind.toLowerCase()} entry ${index} is missing required structural fields and was skipped.`,
    severity: "warning",
  };
}

function duplicateEntry(kind: "EDGE" | "GROUP" | "NODE", id: string): ConversionDiagnostic {
  return {
    code: `MERMAID_SEMANTIC_${kind}_ID_DUPLICATE`,
    elementId: id,
    message: `FlowDB contains more than one ${kind.toLowerCase()} with id '${id}'.`,
    severity: "warning",
  };
}

function ambiguousMembership(
  kind: "node" | "subgraph",
  id: string,
  parents: readonly string[],
): ConversionDiagnostic {
  return {
    code: "MERMAID_SEMANTIC_GROUP_MEMBERSHIP_AMBIGUOUS",
    elementId: id,
    message: `FlowDB ${kind} '${id}' belongs directly to multiple subgraphs (${parents.join(", ")}); membership was left unset.`,
    severity: "warning",
  };
}

function unsupported(
  diagnostics: ConversionDiagnostic[],
  message: string,
): MermaidSemanticExtractionResult {
  diagnostics.push({
    code: "MERMAID_FLOWDB_UNSUPPORTED",
    message,
    severity: "warning",
  });
  return { diagnostics, graph: null };
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "unknown error";
}
