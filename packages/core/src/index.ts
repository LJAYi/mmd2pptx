export type {
  Bounds,
  ConversionDiagnostic,
  ConversionOptions,
  ConversionResult,
  ConversionSummary,
  DiagramArrowKind,
  DiagramEdge,
  DiagramIR,
  DiagramLineDash,
  DiagramNode,
  DiagramNodeKind,
  DiagramText,
  DiagnosticSeverity,
  Point,
} from "./types.js";

export { normalizeFontFamily } from "./normalize-font-family.js";
export { parseMermaidSvg, parseMermaidSvgElement } from "./parse-svg.js";
export {
  diagramToPptxBlob,
  diagramToPptxBuffer,
  svgStringToPptxBuffer,
} from "./pptx.js";
