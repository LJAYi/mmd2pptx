import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { createPptxEdgeCapabilityProbe } from "./fixtures/pptx-edge-capability.js";

async function probeSlideXml(): Promise<string> {
  const data = await createPptxEdgeCapabilityProbe();
  const zip = await JSZip.loadAsync(data);
  const xml = await zip.file("ppt/slides/slide1.xml")?.async("string");
  if (!xml) throw new Error("The edge capability probe has no slide XML.");
  return xml;
}

describe("PptxGenJS edge capability probe", () => {
  it("emits a straight line with native dash and arrow properties", async () => {
    const xml = await probeSlideXml();

    expect(xml).toContain('name="probe-straight-line"');
    expect(xml).toContain('<a:prstGeom prst="line">');
    expect(xml).toContain('<a:prstDash val="dash"/>');
    expect(xml).toContain('<a:headEnd type="oval"/>');
    expect(xml).toContain('<a:tailEnd type="triangle"/>');
  });

  it("keeps each open polyline or curve in one editable custom-geometry shape", async () => {
    const xml = await probeSlideXml();

    expect(xml.match(/<a:custGeom>/g)).toHaveLength(3);
    expect(xml).toContain('name="probe-polyline"');
    expect(xml).toContain('<a:lnTo>');
    expect(xml).toContain('name="probe-bezier"');
    expect(xml).toContain('<a:cubicBezTo>');
    expect(xml).toContain('name="probe-quadratic-and-arc"');
    expect(xml).toContain('<a:quadBezTo>');
    expect(xml).toContain('<a:arcTo');
    expect(xml).not.toContain("<a:close />");
  });

  it("applies one continuous line style and terminal arrow to custom geometry", async () => {
    const xml = await probeSlideXml();

    expect(xml).toContain('<a:prstDash val="sysDot"/>');
    expect(xml).toContain('<a:tailEnd type="diamond"/>');
    expect(xml).toContain('<a:prstDash val="lgDashDot"/>');
    expect(xml).toContain('<a:tailEnd type="stealth"/>');
  });

  it("does not emit connector objects or bind endpoints to node connection sites", async () => {
    const xml = await probeSlideXml();

    expect(xml).not.toContain("<p:cxnSp>");
    expect(xml).not.toContain("<p:nvCxnSpPr>");
    expect(xml).not.toContain("<a:stCxn");
    expect(xml).not.toContain("<a:endCxn");
  });
});
