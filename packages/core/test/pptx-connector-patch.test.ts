import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { patchNativeConnectors } from "../src/pptx-connector-patch.js";
import { diagramToPptxBuffer } from "../src/pptx.js";

async function oneNamedShape(): Promise<Uint8Array> {
  const result = await diagramToPptxBuffer({
    edges: [],
    height: 100,
    nodes: [{
      bounds: { height: 40, width: 80, x: 10, y: 20 },
      id: "A",
      kind: "rect",
    }],
    width: 100,
  }, { mode: "faithful" });
  return result.data;
}

describe("native connector OOXML patch fallback", () => {
  it("retains the visual p:sp and warns when the edge object name is missing", async () => {
    const result = await patchNativeConnectors(await oneNamedShape(), [{
      edgeObjectName: "mmd2pptx-edge:missing",
      elementId: "missing",
    }]);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "PPTX_SMART_CONNECTOR_BINDING_FALLBACK",
      elementId: "missing",
      severity: "warning",
    }));
    const xml = await (await JSZip.loadAsync(result.data))
      .file("ppt/slides/slide1.xml")?.async("string");
    expect(xml).toMatch(/<p:sp><p:nvSpPr><p:cNvPr id="\d+" name="mmd2pptx-node:A"/);
    expect(xml).not.toContain("<p:cxnSp>");
  });

  it("does not replace a shape when a requested endpoint name is missing", async () => {
    const result = await patchNativeConnectors(await oneNamedShape(), [{
      edgeObjectName: "mmd2pptx-node:A",
      elementId: "A-as-probe",
      start: { nodeObjectName: "mmd2pptx-node:missing", siteIndex: 0 },
    }]);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "PPTX_SMART_CONNECTOR_BINDING_FALLBACK",
      elementId: "A-as-probe",
      severity: "warning",
    }));
    const xml = await (await JSZip.loadAsync(result.data))
      .file("ppt/slides/slide1.xml")?.async("string");
    expect(xml).toContain('name="mmd2pptx-node:A"');
    expect(xml).not.toContain("<p:cxnSp>");
  });
});
