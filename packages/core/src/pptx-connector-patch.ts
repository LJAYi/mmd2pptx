import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import JSZip from "jszip";

import type { ConversionDiagnostic } from "./types.js";

const PML_NS = "http://schemas.openxmlformats.org/presentationml/2006/main";
const DML_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";

export interface NativeConnectorPatch {
  edgeObjectName: string;
  elementId: string;
  end?: { nodeObjectName: string; siteIndex: number };
  start?: { nodeObjectName: string; siteIndex: number };
  mode?: "faithful" | "smart";
}

export async function patchNativeConnectors(
  data: Uint8Array,
  patches: readonly NativeConnectorPatch[],
): Promise<{ data: Uint8Array; diagnostics: ConversionDiagnostic[] }> {
  const diagnostics: ConversionDiagnostic[] = [];
  try {
    const zip = await JSZip.loadAsync(data);
    const slideName = "ppt/slides/slide1.xml";
    const xml = await zip.file(slideName)?.async("string");
    if (!xml) throw new Error(`${slideName} is missing.`);
    const document = new DOMParser().parseFromString(xml, "application/xml");
    const namedShapes = new Map<string, Element[]>();
    for (const shape of Array.from(document.getElementsByTagName("p:sp"))) {
      const property = shape.getElementsByTagName("p:cNvPr")[0];
      const name = property?.getAttribute("name");
      if (!name) continue;
      const values = namedShapes.get(name) ?? [];
      values.push(shape);
      namedShapes.set(name, values);
    }

    for (const patch of patches) {
      const edgeShapes = namedShapes.get(patch.edgeObjectName) ?? [];
      if (edgeShapes.length !== 1) {
        diagnostics.push(connectorBindingFallback(
          patch.elementId,
          `expected one named edge shape, found ${edgeShapes.length}`,
          patch.mode,
        ));
        continue;
      }
      const edgeShape = edgeShapes[0];
      if (!edgeShape?.parentNode) continue;
      const start = resolvePatchEndpoint(namedShapes, patch.start, patch.elementId, "start", diagnostics, patch.mode);
      const end = resolvePatchEndpoint(namedShapes, patch.end, patch.elementId, "end", diagnostics, patch.mode);
      if (patch.start && !start || patch.end && !end) {
        continue;
      }
      const connector = document.createElementNS(PML_NS, "p:cxnSp");
      const nonVisual = document.createElementNS(PML_NS, "p:nvCxnSpPr");
      const edgeProperty = edgeShape.getElementsByTagName("p:cNvPr")[0];
      const applicationProperty = edgeShape.getElementsByTagName("p:nvPr")[0];
      const shapeProperties = edgeShape.getElementsByTagName("p:spPr")[0];
      if (!edgeProperty || !applicationProperty || !shapeProperties) {
        diagnostics.push(connectorBindingFallback(
          patch.elementId,
          "edge shape properties are incomplete",
          patch.mode,
        ));
        continue;
      }
      nonVisual.appendChild(edgeProperty.cloneNode(true));
      const connectorProperties = document.createElementNS(PML_NS, "p:cNvCxnSpPr");
      if (start) connectorProperties.appendChild(connectionElement(document, "a:stCxn", start));
      if (end) connectorProperties.appendChild(connectionElement(document, "a:endCxn", end));
      nonVisual.appendChild(connectorProperties);
      nonVisual.appendChild(applicationProperty.cloneNode(true));
      connector.appendChild(nonVisual);
      connector.appendChild(shapeProperties.cloneNode(true));
      edgeShape.parentNode.replaceChild(connector, edgeShape);
    }

    zip.file(slideName, new XMLSerializer().serializeToString(document));
    return {
      data: await zip.generateAsync({ compression: "DEFLATE", type: "uint8array" }),
      diagnostics,
    };
  } catch (error) {
    diagnostics.push({
      code: "PPTX_CONNECTOR_BINDING_FALLBACK",
      message: `Native connector post-processing was skipped and the original visual shapes were retained: ${error instanceof Error ? error.message : String(error)}`,
      severity: "warning",
    });
    return { data, diagnostics };
  }
}

function resolvePatchEndpoint(
  namedShapes: ReadonlyMap<string, Element[]>,
  endpoint: NativeConnectorPatch["start"],
  edgeName: string,
  end: "end" | "start",
  diagnostics: ConversionDiagnostic[],
  mode?: NativeConnectorPatch["mode"],
): { id: string; siteIndex: number } | undefined {
  if (!endpoint) return undefined;
  const shapes = namedShapes.get(endpoint.nodeObjectName) ?? [];
  const id = shapes[0]?.getElementsByTagName("p:cNvPr")[0]?.getAttribute("id");
  if (shapes.length !== 1 || !id) {
    diagnostics.push(connectorBindingFallback(
      edgeName,
      `${end} endpoint ${endpoint.nodeObjectName} did not resolve to one shape`,
      mode,
    ));
    return undefined;
  }
  return { id, siteIndex: endpoint.siteIndex };
}

function connectionElement(
  document: Document,
  name: "a:endCxn" | "a:stCxn",
  endpoint: { id: string; siteIndex: number },
): Element {
  const element = document.createElementNS(DML_NS, name);
  element.setAttribute("id", endpoint.id);
  element.setAttribute("idx", String(endpoint.siteIndex));
  return element;
}

function connectorBindingFallback(
  elementId: string,
  reason: string,
  mode: NativeConnectorPatch["mode"] = "smart",
): ConversionDiagnostic {
  return {
    code: mode === "faithful"
      ? "PPTX_FAITHFUL_CONNECTOR_BINDING_FALLBACK"
      : "PPTX_SMART_CONNECTOR_BINDING_FALLBACK",
    elementId,
    message: `Native connector binding for ${elementId} was not fully applied (${reason}); the visual connector remains usable but may not follow its node.`,
    severity: "warning",
  };
}
