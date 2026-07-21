import { DOMParser } from "@xmldom/xmldom";

import { normalizeFontFamily } from "./normalize-font-family.js";
import type {
  Bounds,
  ConversionDiagnostic,
  ConversionResult,
  DiagramEdge,
  DiagramIR,
  DiagramNode,
  DiagramNodeKind,
  DiagramText,
  Point,
} from "./types.js";

type SvgElementLike = Element & {
  getAttribute(name: string): string | null;
  getElementsByTagName(name: string): HTMLCollectionOf<Element>;
};

interface ViewBox extends Bounds {
  minX: number;
  minY: number;
}

export function parseMermaidSvg(svg: string): ConversionResult<DiagramIR> {
  const parseMessages: string[] = [];
  const document = new DOMParser({
    errorHandler: {
      error: (message) => parseMessages.push(String(message)),
      fatalError: (message) => parseMessages.push(String(message)),
      warning: () => undefined,
    },
  }).parseFromString(svg, "image/svg+xml");

  const root = document.documentElement;
  if (!root || root.tagName.toLowerCase() !== "svg" || parseMessages.length > 0) {
    return failedResult(
      "SVG_PARSE_ERROR",
      parseMessages[0] ?? "Input is not a well-formed SVG document.",
    );
  }

  return parseSvgRoot(root as unknown as SvgElementLike);
}

export function parseMermaidSvgElement(
  svg: SVGSVGElement,
): ConversionResult<DiagramIR> {
  return parseSvgRoot(svg as unknown as SvgElementLike);
}

function parseSvgRoot(root: SvgElementLike): ConversionResult<DiagramIR> {
  const diagnostics: ConversionDiagnostic[] = [];
  const viewBox = readViewBox(root);
  if (!viewBox) {
    return failedResult(
      "SVG_DIMENSIONS_MISSING",
      "SVG must define a valid viewBox or numeric width and height.",
    );
  }

  const nodes = parseNodes(root, viewBox, diagnostics);
  const edges = parseEdges(root, viewBox, diagnostics);
  if (nodes.length === 0) {
    diagnostics.push({
      code: "NO_MERMAID_NODES",
      message: "No Mermaid flowchart node groups were found in the SVG.",
      severity: "warning",
    });
  }

  const diagram: DiagramIR = {
    edges,
    height: viewBox.height,
    nodes,
    width: viewBox.width,
  };

  return {
    data: diagram,
    diagnostics,
    summary: {
      editableObjects: nodes.length + edges.length,
      edges: edges.length,
      fallbackObjects: 0,
      nodes: nodes.length,
    },
  };
}

function parseNodes(
  root: SvgElementLike,
  viewBox: ViewBox,
  diagnostics: ConversionDiagnostic[],
): DiagramNode[] {
  const groups = Array.from(root.getElementsByTagName("g"));
  const nodes: DiagramNode[] = [];

  for (const group of groups) {
    if (!hasClass(group, "node")) {
      continue;
    }

    const groupElement = group as unknown as SvgElementLike;
    const shape = firstShape(groupElement);
    if (!shape) {
      const elementId = group.getAttribute("id");
      diagnostics.push({
        code: "NODE_SHAPE_UNSUPPORTED",
        message: "A Mermaid node had no supported SVG shape.",
        severity: "warning",
        ...(elementId ? { elementId } : {}),
      });
      continue;
    }

    // Start at the selected outline so Mermaid v11 shape- and wrapper-level
    // transforms are composed together with the ancestor node transform.
    const translation = accumulatedTranslation(shape);
    const geometry = shapeGeometry(shape, translation, viewBox);
    if (!geometry) {
      const elementId = group.getAttribute("id");
      diagnostics.push({
        code: "NODE_GEOMETRY_INVALID",
        message: "A Mermaid node shape had invalid dimensions.",
        severity: "warning",
        ...(elementId ? { elementId } : {}),
      });
      continue;
    }

    const style = readShapeStyle(shape);
    const text = readNodeText(groupElement, geometry.bounds);
    const id = group.getAttribute("id") ?? `node-${nodes.length + 1}`;
    nodes.push({
      bounds: geometry.bounds,
      id,
      kind: geometry.kind,
      ...(style.fill ? { fill: style.fill } : {}),
      ...(style.stroke ? { stroke: style.stroke } : {}),
      ...(style.strokeWidth !== undefined ? { strokeWidth: style.strokeWidth } : {}),
      ...(text ? { text } : {}),
    });
  }

  return nodes;
}

function parseEdges(
  root: SvgElementLike,
  viewBox: ViewBox,
  diagnostics: ConversionDiagnostic[],
): DiagramEdge[] {
  const paths = Array.from(root.getElementsByTagName("path"));
  const edges: DiagramEdge[] = [];

  for (const path of paths) {
    if (!hasClass(path, "flowchart-link") && !hasClass(path, "edge-thickness-normal")) {
      continue;
    }

    const points = pathEndpoints(path.getAttribute("d"));
    if (!points) {
      const elementId = path.getAttribute("id");
      diagnostics.push({
        code: "EDGE_PATH_UNSUPPORTED",
        message: "An edge path could not be reduced to editable endpoints.",
        severity: "warning",
        ...(elementId ? { elementId } : {}),
      });
      continue;
    }

    const style = readShapeStyle(path);
    const id = path.getAttribute("id") ?? `edge-${edges.length + 1}`;
    edges.push({
      color: style.stroke ?? "333333",
      end: normalizePoint(points.end, viewBox),
      id,
      start: normalizePoint(points.start, viewBox),
      ...(style.strokeWidth !== undefined ? { strokeWidth: style.strokeWidth } : {}),
    });
  }

  return edges;
}

function firstShape(group: SvgElementLike): Element | undefined {
  const directChildren = Array.from(group.childNodes)
    .filter((node): node is Element => node.nodeType === 1);
  const directShape = directChildren.find(isSupportedShape);
  if (directShape) {
    return directShape;
  }

  const descendants = Array.from(group.getElementsByTagName("*"))
    .filter(isSupportedShape);

  // Mermaid v11 wraps stadium-like nodes in an `outer-path` group. Prefer
  // that actual outline over zero-sized rects used internally by HTML labels.
  return descendants.find(
    (candidate) => hasPositiveGeometry(candidate) && hasSelfOrAncestorClass(candidate, "outer-path", group),
  )
    ?? descendants.find(
      (candidate) => hasPositiveGeometry(candidate) && hasClass(candidate, "label-container"),
    )
    ?? descendants.find((candidate) => hasPositiveGeometry(candidate));
}

function shapeGeometry(
  shape: Element,
  translation: Point,
  viewBox: ViewBox,
): { bounds: Bounds; kind: DiagramNodeKind } | undefined {
  const tag = shape.tagName.toLowerCase();
  let bounds: Bounds | undefined;
  let kind: DiagramNodeKind = "rect";

  if (tag === "rect") {
    const x = numberAttribute(shape, "x") ?? 0;
    const y = numberAttribute(shape, "y") ?? 0;
    const width = numberAttribute(shape, "width");
    const height = numberAttribute(shape, "height");
    if (width !== undefined && height !== undefined) {
      bounds = { x, y, width, height };
      kind = (numberAttribute(shape, "rx") ?? 0) > 0 ? "roundRect" : "rect";
    }
  } else if (tag === "circle") {
    const cx = numberAttribute(shape, "cx") ?? 0;
    const cy = numberAttribute(shape, "cy") ?? 0;
    const radius = numberAttribute(shape, "r");
    if (radius !== undefined) {
      bounds = { x: cx - radius, y: cy - radius, width: radius * 2, height: radius * 2 };
      kind = "ellipse";
    }
  } else if (tag === "ellipse") {
    const cx = numberAttribute(shape, "cx") ?? 0;
    const cy = numberAttribute(shape, "cy") ?? 0;
    const rx = numberAttribute(shape, "rx");
    const ry = numberAttribute(shape, "ry");
    if (rx !== undefined && ry !== undefined) {
      bounds = { x: cx - rx, y: cy - ry, width: rx * 2, height: ry * 2 };
      kind = "ellipse";
    }
  } else if (tag === "polygon") {
    const points = parsePointList(shape.getAttribute("points"));
    bounds = boundsForPoints(points);
    kind = points.length === 4 ? "diamond" : "hexagon";
  } else if (tag === "path") {
    const points = numericPairs(shape.getAttribute("d"));
    bounds = boundsForPoints(points);
    kind = hasSelfOrAncestorClass(shape, "outer-path") ? "roundRect" : "rect";
  }

  if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
    return undefined;
  }

  return {
    bounds: {
      x: bounds.x + translation.x - viewBox.minX,
      y: bounds.y + translation.y - viewBox.minY,
      width: bounds.width,
      height: bounds.height,
    },
    kind,
  };
}

function readNodeText(group: SvgElementLike, bounds: Bounds): DiagramText | undefined {
  const foreignObjects = Array.from(group.getElementsByTagName("foreignObject"));
  const textElements = Array.from(group.getElementsByTagName("text"));
  const source = foreignObjects[0] ?? textElements[0];
  if (!source) {
    return undefined;
  }

  const text = normalizeText(textWithBreaks(source));
  if (!text) {
    return undefined;
  }

  const styleTarget = firstTextStyleTarget(source) ?? source;
  const style = readStyle(source);
  if (styleTarget !== source) {
    for (const [name, value] of readStyle(styleTarget)) {
      style.set(name, value);
    }
  }
  const fontFamily = normalizeFontFamily(style.get("font-family"));
  const fontSize = parseCssNumber(style.get("font-size"));
  const color = normalizeColor(style.get("color") ?? style.get("fill"));
  return {
    bounds,
    text,
    ...(fontFamily ? { fontFamily } : {}),
    ...(fontSize !== undefined ? { fontSize } : {}),
    ...(color ? { color } : {}),
  };
}

function readShapeStyle(element: Element): {
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
} {
  const style = readStyle(element);
  const fill = normalizeColor(style.get("fill"));
  const stroke = normalizeColor(style.get("stroke"));
  const strokeWidth = parseCssNumber(style.get("stroke-width"));
  return {
    ...(fill ? { fill } : {}),
    ...(stroke ? { stroke } : {}),
    ...(strokeWidth !== undefined ? { strokeWidth } : {}),
  };
}

function readStyle(element: Element): Map<string, string> {
  const style = new Map<string, string>();
  for (const name of ["fill", "stroke", "stroke-width", "font-family", "font-size", "color"]) {
    const value = element.getAttribute(name);
    if (value) {
      style.set(name, stripCssPriority(value));
    }
  }
  for (const declaration of (element.getAttribute("style") ?? "").split(";")) {
    const separator = declaration.indexOf(":");
    if (separator > 0) {
      style.set(
        declaration.slice(0, separator).trim().toLowerCase(),
        stripCssPriority(declaration.slice(separator + 1).trim()),
      );
    }
  }
  try {
    const computed = element.ownerDocument?.defaultView?.getComputedStyle(element);
    if (computed) {
      for (const name of ["fill", "stroke", "stroke-width", "font-family", "font-size", "color"]) {
        if (!style.has(name)) {
          const value = computed.getPropertyValue(name);
          if (value) {
            style.set(name, stripCssPriority(value));
          }
        }
      }
    }
  } catch {
    // Attribute-only SVG parsing remains available in non-browser runtimes.
  }
  return style;
}

function firstTextStyleTarget(element: Element): Element | undefined {
  for (const tag of ["span", "p", "div", "text"]) {
    const candidate = element.getElementsByTagName(tag)[0];
    if (candidate) {
      return candidate;
    }
  }
  return undefined;
}

function textWithBreaks(node: Node): string {
  if (node.nodeType === 3 || node.nodeType === 4) {
    return node.nodeValue ?? "";
  }
  if (node.nodeType === 1 && (node as Element).tagName.toLowerCase() === "br") {
    return "\n";
  }
  return Array.from(node.childNodes).map(textWithBreaks).join("");
}

function hasPositiveGeometry(element: Element): boolean {
  const width = numberAttribute(element, "width");
  const height = numberAttribute(element, "height");
  return (width !== undefined && width > 0 && height !== undefined && height > 0)
    || Boolean(element.getAttribute("points"))
    || Boolean(element.getAttribute("d"));
}

function isSupportedShape(element: Element): boolean {
  return ["rect", "circle", "ellipse", "polygon", "path"]
    .includes(element.tagName.toLowerCase());
}

function hasSelfOrAncestorClass(
  element: Element,
  token: string,
  boundary?: Element,
): boolean {
  let current: Node | null = element;
  while (current?.nodeType === 1) {
    if (hasClass(current as Element, token)) {
      return true;
    }
    if (current === boundary) {
      break;
    }
    current = current.parentNode;
  }
  return false;
}

function stripCssPriority(value: string): string {
  return value.replace(/\s*!important\s*$/i, "").trim();
}

function readViewBox(root: Element): ViewBox | undefined {
  const values = (root.getAttribute("viewBox") ?? "")
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (values.length === 4 && values.every(Number.isFinite)) {
    const [minX, minY, width, height] = values as [number, number, number, number];
    if (width > 0 && height > 0) {
      return { x: 0, y: 0, minX, minY, width, height };
    }
  }

  const width = parseCssNumber(root.getAttribute("width"));
  const height = parseCssNumber(root.getAttribute("height"));
  if (width !== undefined && height !== undefined && width > 0 && height > 0) {
    return { x: 0, y: 0, minX: 0, minY: 0, width, height };
  }
  return undefined;
}

function accumulatedTranslation(element: Element): Point {
  let x = 0;
  let y = 0;
  let current: Node | null = element;
  while (current && current.nodeType === 1) {
    const transform = (current as Element).getAttribute("transform") ?? "";
    for (const match of transform.matchAll(/translate\(\s*(-?\d*\.?\d+)(?:[\s,]+(-?\d*\.?\d+))?\s*\)/g)) {
      x += Number(match[1]);
      y += Number(match[2] ?? 0);
    }
    current = current.parentNode;
  }
  return { x, y };
}

function pathEndpoints(path: string | null): { start: Point; end: Point } | undefined {
  const points = numericPairs(path);
  const start = points[0];
  const end = points.at(-1);
  return start && end ? { start, end } : undefined;
}

function numericPairs(value: string | null): Point[] {
  const values = (value ?? "").match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi)?.map(Number) ?? [];
  const points: Point[] = [];
  for (let index = 0; index + 1 < values.length; index += 2) {
    const x = values[index];
    const y = values[index + 1];
    if (x !== undefined && y !== undefined && Number.isFinite(x) && Number.isFinite(y)) {
      points.push({ x, y });
    }
  }
  return points;
}

function parsePointList(value: string | null): Point[] {
  return numericPairs(value);
}

function boundsForPoints(points: Point[]): Bounds | undefined {
  if (points.length === 0) {
    return undefined;
  }
  const xs = points.map(({ x }) => x);
  const ys = points.map(({ y }) => y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

function normalizePoint(point: Point, viewBox: ViewBox): Point {
  return { x: point.x - viewBox.minX, y: point.y - viewBox.minY };
}

function hasClass(element: Element, token: string): boolean {
  return (element.getAttribute("class") ?? "").split(/\s+/).includes(token);
}

function numberAttribute(element: Element, name: string): number | undefined {
  return parseCssNumber(element.getAttribute(name));
}

function parseCssNumber(value: string | null | undefined): number | undefined {
  const match = value?.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/i);
  if (!match) {
    return undefined;
  }
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeColor(value: string | null | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "none" || normalized === "transparent") {
    return undefined;
  }
  if (/^#[0-9a-f]{6}$/i.test(normalized)) {
    return normalized.slice(1).toUpperCase();
  }
  if (/^#[0-9a-f]{3}$/i.test(normalized)) {
    return normalized
      .slice(1)
      .split("")
      .map((character) => character.repeat(2))
      .join("")
      .toUpperCase();
  }
  const rgb = normalized.match(/^rgb\(\s*(\d+)\D+(\d+)\D+(\d+)\s*\)$/);
  if (rgb) {
    return rgb
      .slice(1)
      .map((channel) => Math.max(0, Math.min(255, Number(channel))).toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase();
  }
  return undefined;
}

function normalizeText(value: string): string {
  return value
    .replace(/\u00a0/g, " ")
    .replace(/[\t ]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

function failedResult(code: string, message: string): ConversionResult<DiagramIR> {
  return {
    data: { edges: [], height: 1, nodes: [], width: 1 },
    diagnostics: [{ code, message, severity: "error" }],
    summary: { editableObjects: 0, edges: 0, fallbackObjects: 0, nodes: 0 },
  };
}
