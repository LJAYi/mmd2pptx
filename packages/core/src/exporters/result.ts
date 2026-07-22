import type {
  ConversionDiagnostic,
  ConversionResult,
  DiagramIR,
} from "../types.js";

export function exporterResult(
  diagram: DiagramIR,
  data: string,
  diagnostics: ConversionDiagnostic[],
  counts?: { edges?: number; groups?: number; nodes?: number },
): ConversionResult<string> {
  const nodes = counts?.nodes ?? diagram.nodes.length;
  const edges = counts?.edges ?? diagram.edges.length;
  const groups = counts?.groups ?? diagram.groups?.length ?? 0;
  const elementFallbacks = new Set(
    diagnostics
      .filter(({ severity, elementId }) => severity === "warning" && elementId)
      .map(({ elementId }) => elementId!),
  );
  return {
    data,
    diagnostics,
    summary: {
      editableObjects: nodes + edges + groups,
      edges,
      fallbackObjects: elementFallbacks.size,
      nodes,
    },
  };
}

export function exporterFailure(
  diagram: DiagramIR,
  format: string,
  error: unknown,
): ConversionResult<string> {
  const message = error instanceof Error ? error.message : String(error);
  return {
    data: "",
    diagnostics: [{
      code: `${format.toUpperCase().replaceAll("-", "_")}_EXPORT_FAILED`,
      message,
      severity: "error",
    }],
    summary: {
      editableObjects: 0,
      edges: 0,
      fallbackObjects: diagram.nodes.length + diagram.edges.length + (diagram.groups?.length ?? 0),
      nodes: 0,
    },
  };
}

export function unsupportedMermaidDiagramResult(
  diagram: DiagramIR,
  format: string,
): ConversionResult<string> | undefined {
  const diagramType = diagram.source?.diagramType;
  if (!diagramType || diagramType === "flowchart" || diagramType === "flowchart-v2") {
    return undefined;
  }
  return {
    data: "",
    diagnostics: [{
      code: `${format.toUpperCase().replaceAll("-", "_")}_DIAGRAM_TYPE_UNSUPPORTED`,
      message: `${format} export for Mermaid ${diagramType} is not implemented; use PPTX exact mode to preserve the source SVG.`,
      severity: "error",
    }],
    summary: {
      editableObjects: 0,
      edges: diagram.edges.length,
      fallbackObjects: 0,
      nodes: diagram.nodes.length,
    },
  };
}
