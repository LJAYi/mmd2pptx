export type {
  Bounds,
  ConversionDiagnostic,
  ConversionOptions,
  ConversionResult,
  ConversionSummary,
  DiagramArrowKind,
  DiagramEdge,
  DiagramGroup,
  DiagramIR,
  DiagramLineDash,
  DiagramNode,
  DiagramNodeKind,
  DiagramText,
  DiagnosticSeverity,
  Point,
} from "./types.js";
export type {
  AffineTransform,
  DiagramPath,
  DiagramPathKind,
  DiagramPathSegment,
  DiagramStrokeStyle,
} from "./diagram-ir/index.js";
export {
  classifyDiagramPath,
  diagramPathPoints,
  parseSvgPathData,
  transformDiagramPath,
} from "./diagram-ir/index.js";
export type {
  CapabilitySupport,
  DiagramExporter,
  DiagramExportFormat,
  DiagramExportMode,
  DiagramExportOptions,
  ExportCapabilityDecision,
  ExportCapabilityReport,
} from "./export-contract.js";
export { fallbackDecision } from "./export-contract.js";
export {
  CAPABILITY_MERMAID_VERSION,
  EXPORTER_CAPABILITIES,
  EXPORTER_FORMAT_SUMMARIES,
  MERMAID_DIAGRAM_CAPABILITIES,
  drawioExporter,
  exportDiagramToDrawio,
  exportDiagramToJsonCanvas,
  exportDiagramToSvg,
  exporterCapabilities,
  jsonCanvasExporter,
  mermaidDiagramCapabilities,
  svgExporter,
} from "./exporters/index.js";
export type {
  DiagramTypeSupport,
  DrawioExportOptions,
  ExportBounds,
  ExportDiagram,
  ExportEdge,
  ExportGroup,
  ExportNode,
  ExportPath,
  ExportPathSegment,
  ExportPoint,
  ExportStrokeStyle,
  ExportText,
  ExporterCapabilityEntry,
  ExporterFormatSummary,
  ForwardExportFormat,
  JsonCanvasDocument,
  JsonCanvasEdge,
  JsonCanvasEnd,
  JsonCanvasExportOptions,
  JsonCanvasNode,
  JsonCanvasSide,
  MermaidDiagramCapabilityEntry,
  SvgExportOptions,
} from "./exporters/index.js";
export { analyzeDiagramCollisions, compressCollinear, routeOrthogonal } from "./routing/index.js";
export type {
  DiagramCollision,
  DiagramCollisionKind,
  DiagramCollisionParticipant,
  DiagramCollisionParticipantKind,
  OrthogonalPort,
  OrthogonalRouteRequest,
  OrthogonalRouteResult,
} from "./routing/index.js";

export { normalizeFontFamily } from "./normalize-font-family.js";
export type { ParseMermaidSvgOptions } from "./parse-svg.js";
export { parseMermaidSvg, parseMermaidSvgElement } from "./parse-svg.js";
export {
  extractMermaidFlowchartSemantics,
  mergeMermaidSemantics,
} from "./source-mapping/index.js";
export type {
  MermaidSemanticEdge,
  MermaidSemanticExtractionResult,
  MermaidSemanticGraph,
  MermaidSemanticGroup,
  MermaidSemanticMergeResult,
  MermaidSemanticNode,
} from "./source-mapping/index.js";
export {
  diagramToPptxBlob,
  diagramToPptxBuffer,
  preflightDiagramToPptx,
  svgStringToPptxBlob,
  svgStringToPptxBuffer,
} from "./pptx.js";
