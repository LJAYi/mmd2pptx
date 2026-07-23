import { describe, expect, it } from "vitest";

import {
  EXPORTER_CAPABILITIES,
  analyzeDiagramCollisions,
  drawioExporter,
  exportDiagramToDrawio,
  exportDiagramToJsonCanvas,
  exportDiagramToSvg,
  exporterCapabilities,
  jsonCanvasExporter,
  applyLayoutSidecar,
  parseLayoutSidecar,
  preflightDiagramToPptx,
  reconcileLayout,
  removeLayoutGroup,
  routeOrthogonal,
  serializeLayoutSidecar,
  setManualGroupLayout,
  setNodeZIndex,
  svgExporter,
} from "../src/index.js";
import type {
  DiagramEdge,
  DiagramIR,
  DiagramNode,
  DiagramPath,
  DiagramStrokeStyle,
  ExportDiagram,
  ExportEdge,
  ExportNode,
  ExportPath,
  ExportStrokeStyle,
} from "../src/index.js";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2) ? true : false;

describe("forward exporter public API", () => {
  it("exposes deterministic serializers, contract wrappers, and capabilities", () => {
    expect(exportDiagramToSvg).toBeTypeOf("function");
    expect(exportDiagramToDrawio).toBeTypeOf("function");
    expect(exportDiagramToJsonCanvas).toBeTypeOf("function");
    expect(svgExporter.format).toBe("svg");
    expect(drawioExporter.format).toBe("drawio");
    expect(jsonCanvasExporter.format).toBe("json-canvas");
    expect(exporterCapabilities()).toBe(EXPORTER_CAPABILITIES);
    expect(applyLayoutSidecar).toBeTypeOf("function");
    expect(parseLayoutSidecar).toBeTypeOf("function");
    expect(reconcileLayout).toBeTypeOf("function");
    expect(removeLayoutGroup).toBeTypeOf("function");
    expect(serializeLayoutSidecar).toBeTypeOf("function");
    expect(routeOrthogonal).toBeTypeOf("function");
    expect(setNodeZIndex).toBeTypeOf("function");
    expect(setManualGroupLayout).toBeTypeOf("function");
    expect(preflightDiagramToPptx).toBeTypeOf("function");
    expect(analyzeDiagramCollisions).toBeTypeOf("function");
  });

  it("keeps exporter compatibility names aliased to the unified Diagram IR", () => {
    const diagram: Equal<ExportDiagram, DiagramIR> = true;
    const node: Equal<ExportNode, DiagramNode> = true;
    const edge: Equal<ExportEdge, DiagramEdge> = true;
    const path: Equal<ExportPath, DiagramPath> = true;
    const stroke: Equal<ExportStrokeStyle, DiagramStrokeStyle> = true;

    expect({ diagram, node, edge, path, stroke }).toEqual({
      diagram: true,
      node: true,
      edge: true,
      path: true,
      stroke: true,
    });
  });
});
