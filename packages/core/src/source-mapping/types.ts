import type { DiagramIR } from "../types.js";
import type { ConversionDiagnostic } from "../types.js";

/** Target-neutral source semantics extracted from Mermaid's flowchart database. */
export interface MermaidSemanticNode {
  /** Stable node identifier from the Mermaid source model. */
  id: string;
  /** Renderer DOM identifier, when Mermaid exposes one. */
  rendererId?: string;
  /** Immediate semantic subgraph membership. */
  parentId?: string;
}

export interface MermaidSemanticEdge {
  /** Stable edge identifier assigned by Mermaid's FlowDB. */
  id: string;
  /** Original position in FlowDB edge order. */
  order: number;
  sourceId: string;
  targetId: string;
}

export interface MermaidSemanticGroup {
  /** Stable subgraph identifier from the Mermaid source model. */
  id: string;
  /** Direct child subgraphs, in FlowDB membership order. */
  groupIds: string[];
  /** Direct child nodes, in FlowDB membership order. */
  nodeIds: string[];
  /** Immediate containing subgraph. */
  parentId?: string;
}

export interface MermaidSemanticGraph {
  diagramType: "flowchart";
  edges: MermaidSemanticEdge[];
  groups: MermaidSemanticGroup[];
  nodes: MermaidSemanticNode[];
}

export interface MermaidSemanticExtractionResult {
  diagnostics: ConversionDiagnostic[];
  graph: MermaidSemanticGraph | null;
}

export interface MermaidSemanticMergeResult {
  data: DiagramIR;
  diagnostics: ConversionDiagnostic[];
}
