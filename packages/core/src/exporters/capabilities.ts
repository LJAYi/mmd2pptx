import type {
  CapabilitySupport,
  DiagramExportFormat,
  DiagramExportMode,
} from "../export-contract.js";

export type ForwardExportFormat = DiagramExportFormat;
export type DiagramTypeSupport =
  | "smart"
  | "editable"
  | "hybrid"
  | "exact"
  | "planned"
  | "unsupported";

export const CAPABILITY_MERMAID_VERSION = "11.16.0" as const;

export interface ExporterCapabilityEntry {
  readonly feature: string;
  readonly format: ForwardExportFormat;
  readonly mode?: DiagramExportMode;
  readonly note: string;
  readonly support: CapabilitySupport;
}

export interface ExporterFormatSummary {
  readonly format: ForwardExportFormat;
  readonly note: string;
  readonly status: DiagramTypeSupport;
}

export interface MermaidDiagramCapabilityEntry {
  readonly diagramType: string;
  readonly format: ForwardExportFormat;
  readonly mermaidVersion: typeof CAPABILITY_MERMAID_VERSION;
  readonly note: string;
  readonly status: DiagramTypeSupport;
}

/** Machine-readable source for docs and UI compatibility matrices. */
export const EXPORTER_CAPABILITIES = [
  capability("pptx", "node-geometry", "native", "Native editable PowerPoint node shapes.", "smart"),
  capability("pptx", "node-text", "native", "Native editable PowerPoint text.", "smart"),
  capability("pptx", "edge-connectivity", "fallback", "Simple paths use bound native connectors; complex paths fall back per edge.", "smart"),
  capability("pptx", "edge-paths", "fallback", "Straight, orthogonal, and simple curves are native; complex paths use faithful or SVG fallback.", "smart"),
  capability("pptx", "edge-styles", "fallback", "Basic line and marker styling is editable; unsupported details are diagnosed.", "smart"),
  capability("pptx", "background", "native", "Slide background color is preserved.", "smart"),

  capability("pptx", "node-geometry", "native", "Native editable PowerPoint node shapes.", "faithful"),
  capability("pptx", "node-text", "native", "Native editable PowerPoint text.", "faithful"),
  capability("pptx", "edge-connectivity", "fallback", "Geometry-safe straight edges use bound native connectors; other edges remain open Freeforms and do not follow moved nodes.", "faithful"),
  capability("pptx", "edge-paths", "native", "Straight edges use one native connector; orthogonal, curved, and complex supported paths use one open Freeform to avoid changing their geometry.", "faithful"),
  capability("pptx", "edge-styles", "fallback", "Dash and markers are preserved; some detailed stroke semantics may differ.", "faithful"),
  capability("pptx", "background", "native", "Slide background color is preserved.", "faithful"),

  capability("pptx", "visual-fidelity", "fallback", "Source-SVG workflows sanitize and embed the original renderer SVG; DiagramIR-only workflows embed a normalized IR SVG instead.", "exact"),
  capability("pptx", "internal-editability", "unsupported", "Internal nodes and edges are not editable PowerPoint objects.", "exact"),
  capability("pptx", "background", "native", "Slide background color is preserved.", "exact"),

  capability("svg", "stable-ids", "native", "Stable IDs are derived from Mermaid/IR element IDs."),
  capability("svg", "node-geometry", "native", "Absolute bounds and supported node outlines are serialized."),
  capability("svg", "node-text", "native", "Multiline text and basic font styling are serialized."),
  capability("svg", "edge-connectivity", "fallback", "Visual geometry is preserved, but SVG has no portable node attachment model."),
  capability("svg", "edge-paths", "native", "Canonical lines, curves, quadratic segments, and arcs are serialized."),
  capability("svg", "edge-waypoints", "native", "Polyline waypoints are preserved."),
  capability("svg", "edge-styles", "native", "Color, width, dash, cap, join, opacity, and markers are inline."),
  capability("svg", "background", "native", "Diagram background color is serialized as SVG geometry."),
  capability("svg", "groups", "native", "Flowchart subgraph outlines are editable SVG group elements with deterministic parent metadata."),

  capability("drawio", "stable-ids", "native", "Stable mxCell IDs are derived from Mermaid/IR element IDs."),
  capability("drawio", "node-geometry", "native", "Vertex x, y, width, and height are preserved."),
  capability("drawio", "node-text", "native", "Node and edge label text are preserved."),
  capability("drawio", "edge-connectivity", "fallback", "Edges reference vertex cells when semantic IDs resolve or endpoint geometry identifies a unique node; unresolved endpoints remain detached and are diagnosed."),
  capability("drawio", "edge-paths", "fallback", "Canonical curves are reduced to editable waypoints."),
  capability("drawio", "edge-waypoints", "native", "Intermediate points are stored in mxGeometry."),
  capability("drawio", "edge-styles", "fallback", "Basic colors, widths, dashes, and markers are mapped."),
  capability("drawio", "background", "unsupported", "Document background color is diagnosed and omitted."),
  capability("drawio", "groups", "native", "Flowchart subgraphs become editable draw.io container cells."),

  capability("json-canvas", "stable-ids", "native", "Stable IDs are derived from Mermaid/IR element IDs."),
  capability("json-canvas", "node-geometry", "native", "Text-card x, y, width, and height are preserved."),
  capability("json-canvas", "node-text", "native", "Node text and edge label text are preserved."),
  capability("json-canvas", "edge-connectivity", "fallback", "Resolved edges reference fromNode and toNode; JSON Canvas requires unresolved edges to be diagnosed and omitted."),
  capability("json-canvas", "edge-sides", "fallback", "Named ports map to four sides; other ports use geometry inference."),
  capability("json-canvas", "edge-paths", "unsupported", "JSON Canvas has no custom path or waypoint field."),
  capability("json-canvas", "edge-waypoints", "unsupported", "Only edge connectivity and sides are preserved."),
  capability("json-canvas", "edge-styles", "fallback", "Color and arrow/none ends are mapped; rich stroke style is diagnosed."),
  capability("json-canvas", "background", "unsupported", "JSON Canvas has no document background color field."),
  capability("json-canvas", "groups", "unsupported", "JSON Canvas 1.0 has no portable group/container object; each group is diagnosed."),
] as const satisfies readonly ExporterCapabilityEntry[];

export const EXPORTER_FORMAT_SUMMARIES = [
  summary("pptx", "smart", "Flowcharts support tiered smart, faithful, and exact modes."),
  summary("svg", "editable", "Normalized standalone SVG with editable vector elements."),
  summary("drawio", "editable", "Editable vertices, containers, and waypoints; connectivity is preserved when endpoints resolve, otherwise diagnosed as detached."),
  summary("json-canvas", "hybrid", "Editable cards/connectivity with diagnosed visual-style loss."),
] as const satisfies readonly ExporterFormatSummary[];

const PLANNED_DIAGRAM_TYPES = [
  "sequenceDiagram",
  "classDiagram",
  "stateDiagram-v2",
  "erDiagram",
  "gantt",
  "pie",
  "journey",
  "gitGraph",
  "requirementDiagram",
  "mindmap",
  "timeline",
  "quadrantChart",
  "sankey-beta",
  "xychart-beta",
  "block-beta",
  "packet-beta",
  "architecture-beta",
  "kanban",
] as const;

const JSON_CANVAS_UNSUPPORTED = new Set<string>([
  "gantt",
  "pie",
  "journey",
  "gitGraph",
  "quadrantChart",
  "sankey-beta",
  "xychart-beta",
  "packet-beta",
]);

export const MERMAID_DIAGRAM_CAPABILITIES: readonly MermaidDiagramCapabilityEntry[] = [
  diagramCapability("flowchart", "pptx", "smart", "Smart connectors with per-edge faithful/exact fallback."),
  diagramCapability("flowchart", "svg", "editable", "Normalized vector nodes, paths, labels, and styles."),
  diagramCapability("flowchart", "drawio", "editable", "Editable vertices, containers, and waypoints; endpoint resolution controls native connectivity."),
  diagramCapability("flowchart", "json-canvas", "hybrid", "Cards and connectivity are editable; shape/path style loss is diagnosed."),
  ...PLANNED_DIAGRAM_TYPES.flatMap((diagramType): MermaidDiagramCapabilityEntry[] => [
    diagramCapability(diagramType, "pptx", "exact", "Source-SVG workflows support appearance-first exact embedding; IR-only input uses normalized SVG."),
    diagramCapability(diagramType, "svg", "planned", "Typed Diagram IR parsing and normalized export are not implemented yet."),
    diagramCapability(diagramType, "drawio", "planned", "Typed Diagram IR mapping is not implemented yet."),
    diagramCapability(
      diagramType,
      "json-canvas",
      JSON_CANVAS_UNSUPPORTED.has(diagramType) ? "unsupported" : "planned",
      JSON_CANVAS_UNSUPPORTED.has(diagramType)
        ? "The chart semantics have no useful current JSON Canvas mapping."
        : "Typed Diagram IR mapping is not implemented yet.",
    ),
  ]),
];

export function exporterCapabilities(
  format?: ForwardExportFormat,
): readonly ExporterCapabilityEntry[] {
  return format
    ? EXPORTER_CAPABILITIES.filter((entry) => entry.format === format)
    : EXPORTER_CAPABILITIES;
}

export function mermaidDiagramCapabilities(
  format?: ForwardExportFormat,
): readonly MermaidDiagramCapabilityEntry[] {
  return format
    ? MERMAID_DIAGRAM_CAPABILITIES.filter((entry) => entry.format === format)
    : MERMAID_DIAGRAM_CAPABILITIES;
}

function capability(
  format: ForwardExportFormat,
  feature: string,
  support: CapabilitySupport,
  note: string,
  mode?: DiagramExportMode,
): ExporterCapabilityEntry {
  return { feature, format, note, support, ...(mode ? { mode } : {}) };
}

function summary(
  format: ForwardExportFormat,
  status: DiagramTypeSupport,
  note: string,
): ExporterFormatSummary {
  return { format, note, status };
}

function diagramCapability(
  diagramType: string,
  format: ForwardExportFormat,
  status: DiagramTypeSupport,
  note: string,
): MermaidDiagramCapabilityEntry {
  return {
    diagramType,
    format,
    mermaidVersion: CAPABILITY_MERMAID_VERSION,
    note,
    status,
  };
}
