// mmd2pptx synthetic fixture
import PptxGenJS from "pptxgenjs";

// PptxGenJS 3.12 implements custGeom and types its `points` option, but omits
// the literal from its public ShapeType/SHAPE_NAME declarations.
const CUSTOM_GEOMETRY = "custGeom" as unknown as PptxGenJS.ShapeType;

/**
 * Build a deterministic one-slide presentation that exercises every edge
 * primitive currently exposed by the pinned PptxGenJS dependency.
 */
export async function createPptxEdgeCapabilityProbe(): Promise<Uint8Array> {
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";

  const slide = pptx.addSlide();
  slide.addShape(pptx.ShapeType.rect, {
    objectName: "probe-source-node",
    x: 0.5,
    y: 0.5,
    w: 1.5,
    h: 0.75,
    fill: { color: "EEF4F7" },
    line: { color: "24323D", width: 1.5 },
  });
  slide.addShape(pptx.ShapeType.rect, {
    objectName: "probe-target-node",
    x: 11.25,
    y: 0.5,
    w: 1.5,
    h: 0.75,
    fill: { color: "EEF4F7" },
    line: { color: "24323D", width: 1.5 },
  });

  slide.addShape(pptx.ShapeType.line, {
    objectName: "probe-straight-line",
    x: 2,
    y: 0.875,
    w: 9.25,
    h: 0,
    line: {
      color: "24323D",
      dashType: "dash",
      width: 2,
      beginArrowType: "oval",
      endArrowType: "triangle",
    },
  });

  slide.addShape(CUSTOM_GEOMETRY, {
    objectName: "probe-polyline",
    x: 1,
    y: 2,
    w: 4,
    h: 1.5,
    points: [
      { x: 0, y: 0 },
      { x: 1.5, y: 0 },
      { x: 1.5, y: 1.25 },
      { x: 4, y: 1.25 },
    ],
    line: {
      color: "4C6A92",
      dashType: "sysDot",
      width: 2,
      endArrowType: "diamond",
    },
  });

  slide.addShape(CUSTOM_GEOMETRY, {
    objectName: "probe-bezier",
    x: 6,
    y: 2,
    w: 5,
    h: 1.5,
    points: [
      { x: 0, y: 1.25 },
      {
        x: 5,
        y: 0.25,
        curve: { type: "cubic", x1: 1.25, y1: 0, x2: 3.75, y2: 1.5 },
      },
    ],
    line: {
      color: "9A5D3A",
      dashType: "lgDashDot",
      width: 2,
      endArrowType: "stealth",
    },
  });

  slide.addShape(CUSTOM_GEOMETRY, {
    objectName: "probe-quadratic-and-arc",
    x: 2,
    y: 4.25,
    w: 8,
    h: 1.5,
    points: [
      { x: 0, y: 0.75 },
      { x: 3, y: 0.75, curve: { type: "quadratic", x1: 1.5, y1: 0 } },
      {
        x: 5,
        y: 0.75,
        curve: { type: "arc", hR: 1, wR: 1, stAng: 180, swAng: 180 },
      },
    ],
    line: { color: "3F795D", width: 2, endArrowType: "arrow" },
  });

  const raw = await pptx.write({ outputType: "arraybuffer", compression: true });
  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(raw)) return new Uint8Array(raw);
  throw new TypeError("PptxGenJS returned an unsupported probe output type.");
}
