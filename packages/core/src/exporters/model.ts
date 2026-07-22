/**
 * Compatibility names for the forward-exporter surface.
 *
 * These are aliases of the single shared Diagram IR, not a parallel model.
 * New public APIs should prefer the DiagramIR/DiagramNode/DiagramEdge names.
 */
import type {
  Bounds,
  DiagramEdge,
  DiagramGroup,
  DiagramIR,
  DiagramNode,
  DiagramPath,
  DiagramPathSegment,
  DiagramStrokeStyle,
  DiagramText,
  Point,
} from "../types.js";

export type ExportPoint = Point;
export type ExportBounds = Bounds;
export type ExportText = DiagramText;
export type ExportNode = DiagramNode;
export type ExportEdge = DiagramEdge;
export type ExportGroup = DiagramGroup;
export type ExportDiagram = DiagramIR;
export type ExportPathSegment = DiagramPathSegment;
export type ExportPath = DiagramPath;
export type ExportStrokeStyle = DiagramStrokeStyle;
