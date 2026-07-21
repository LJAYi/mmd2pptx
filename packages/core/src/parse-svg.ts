import { DOMParser } from "@xmldom/xmldom";

import { normalizeFontFamily } from "./normalize-font-family.js";
import type {
  Bounds,
  ConversionDiagnostic,
  ConversionResult,
  DiagramArrowKind,
  DiagramEdge,
  DiagramIR,
  DiagramLineDash,
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

interface AffineMatrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
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
      editableObjects: editableObjectCount(nodes, edges),
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
    const transform = accumulatedTransform(shape);
    const geometry = shapeGeometry(shape, transform, viewBox);
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

    const localPoints = pathPoints(path.getAttribute("d"));
    if (localPoints.length < 2) {
      const elementId = path.getAttribute("id");
      diagnostics.push({
        code: "EDGE_PATH_UNSUPPORTED",
        message: "An edge path could not be reduced to editable endpoints.",
        severity: "warning",
        ...(elementId ? { elementId } : {}),
      });
      continue;
    }

    const transform = accumulatedTransform(path);
    const points = dedupePoints(localPoints.map((point) =>
      normalizePoint(applyMatrix(transform, point), viewBox)));
    if (points.length < 2) {
      continue;
    }

    const style = readShapeStyle(path);
    const dash = edgeDash(path);
    const startArrow = markerArrow(path, "start");
    const endArrow = markerArrow(path, "end");
    const id = path.getAttribute("id") ?? `edge-${edges.length + 1}`;
    const start = points[0];
    const end = points.at(-1);
    if (!start || !end) {
      continue;
    }
    edges.push({
      color: style.stroke ?? "333333",
      end,
      id,
      points,
      start,
      ...(dash !== "solid" ? { dash } : {}),
      ...(startArrow !== "none" ? { startArrow } : {}),
      ...(endArrow !== "none" ? { endArrow } : {}),
      ...(style.strokeWidth !== undefined ? { strokeWidth: style.strokeWidth } : {}),
    });
  }

  attachEdgeLabels(root, edges, viewBox);
  return edges;
}

function attachEdgeLabels(
  root: SvgElementLike,
  edges: DiagramEdge[],
  viewBox: ViewBox,
): void {
  const labelGroups = Array.from(root.getElementsByTagName("g"))
    .filter((group) => hasClass(group, "edgeLabel") && !ancestorHasClass(group, "edgeLabel"));

  for (const group of labelGroups) {
    const groupElement = group as unknown as SvgElementLike;
    const source = groupElement.getElementsByTagName("foreignObject")[0]
      ?? groupElement.getElementsByTagName("text")[0];
    if (!source) {
      continue;
    }

    const bounds = textElementBounds(source, viewBox);
    if (!bounds) {
      continue;
    }
    const label = readTextElement(source, bounds);
    if (!label) {
      continue;
    }

    const center = {
      x: bounds.x + bounds.width / 2,
      y: bounds.y + bounds.height / 2,
    };
    const edge = edges
      .filter((candidate) => !candidate.label)
      .sort((left, right) => distanceToEdge(center, left) - distanceToEdge(center, right))[0];
    if (edge) {
      edge.label = label;
    }
  }
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
  transform: AffineMatrix,
  viewBox: ViewBox,
): { bounds: Bounds; kind: DiagramNodeKind } | undefined {
  const tag = shape.tagName.toLowerCase();
  let bounds: Bounds | undefined;
  let kind: DiagramNodeKind = semanticNodeKind(shape) ?? "rect";

  if (tag === "rect") {
    const x = numberAttribute(shape, "x") ?? 0;
    const y = numberAttribute(shape, "y") ?? 0;
    const width = numberAttribute(shape, "width");
    const height = numberAttribute(shape, "height");
    if (width !== undefined && height !== undefined) {
      bounds = { x, y, width, height };
      if (!semanticNodeKind(shape)) {
        kind = (numberAttribute(shape, "rx") ?? 0) > 0 ? "roundRect" : "rect";
      }
    }
  } else if (tag === "circle") {
    const cx = numberAttribute(shape, "cx") ?? 0;
    const cy = numberAttribute(shape, "cy") ?? 0;
    const radius = numberAttribute(shape, "r");
    if (radius !== undefined) {
      bounds = { x: cx - radius, y: cy - radius, width: radius * 2, height: radius * 2 };
      kind = semanticNodeKind(shape) ?? "ellipse";
    }
  } else if (tag === "ellipse") {
    const cx = numberAttribute(shape, "cx") ?? 0;
    const cy = numberAttribute(shape, "cy") ?? 0;
    const rx = numberAttribute(shape, "rx");
    const ry = numberAttribute(shape, "ry");
    if (rx !== undefined && ry !== undefined) {
      bounds = { x: cx - rx, y: cy - ry, width: rx * 2, height: ry * 2 };
      kind = semanticNodeKind(shape) ?? "ellipse";
    }
  } else if (tag === "polygon") {
    const points = parsePointList(shape.getAttribute("points"));
    bounds = boundsForPoints(points);
    kind = semanticNodeKind(shape)
      ?? (isDiamond(points) ? "diamond" : points.length === 6 ? "hexagon" : "parallelogram");
  } else if (tag === "path") {
    const points = pathPoints(shape.getAttribute("d"));
    bounds = boundsForPoints(points);
    kind = semanticNodeKind(shape)
      ?? (hasSelfOrAncestorClass(shape, "outer-path") ? "roundRect" : "rect");
  }

  if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
    return undefined;
  }

  const transformed = transformBounds(bounds, transform);
  return {
    bounds: {
      x: transformed.x - viewBox.minX,
      y: transformed.y - viewBox.minY,
      width: transformed.width,
      height: transformed.height,
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

  return readTextElement(source, bounds);
}

function readTextElement(source: Element, bounds: Bounds): DiagramText | undefined {
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

function textElementBounds(element: Element, viewBox: ViewBox): Bounds | undefined {
  let x = numberAttribute(element, "x") ?? 0;
  let y = numberAttribute(element, "y") ?? 0;
  let width = numberAttribute(element, "width");
  let height = numberAttribute(element, "height");
  if ((width === undefined || height === undefined) && element.tagName.toLowerCase() === "text") {
    const style = readStyle(element);
    const fontSize = parseCssNumber(style.get("font-size")) ?? 16;
    const lines = normalizeText(textWithBreaks(element)).split("\n");
    width = Math.max(...lines.map((line) => line.length), 1) * fontSize * 0.6;
    height = Math.max(lines.length, 1) * fontSize * 1.2;
    const anchor = style.get("text-anchor") ?? element.getAttribute("text-anchor");
    x -= anchor === "end" ? width : anchor === "middle" ? width / 2 : 0;
    y -= height / 2;
  }
  if (width === undefined || height === undefined || width <= 0 || height <= 0) {
    return undefined;
  }
  const bounds = transformBounds({ x, y, width, height }, accumulatedTransform(element));
  return {
    x: bounds.x - viewBox.minX,
    y: bounds.y - viewBox.minY,
    width: bounds.width,
    height: bounds.height,
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
  const names = [
    "fill",
    "stroke",
    "stroke-width",
    "stroke-dasharray",
    "marker-start",
    "marker-end",
    "font-family",
    "font-size",
    "text-anchor",
    "color",
  ];
  for (const name of names) {
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
      for (const name of names) {
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

function accumulatedTransform(element: Element): AffineMatrix {
  const elements: Element[] = [];
  let current: Node | null = element;
  while (current?.nodeType === 1) {
    elements.push(current as Element);
    current = current.parentNode;
  }

  return elements.reverse().reduce(
    (matrix, item) => multiplyMatrices(matrix, parseTransform(item.getAttribute("transform"))),
    identityMatrix(),
  );
}

function parseTransform(value: string | null): AffineMatrix {
  let matrix = identityMatrix();
  for (const match of (value ?? "").matchAll(/([a-zA-Z]+)\s*\(([^)]*)\)/g)) {
    const name = match[1]?.toLowerCase();
    const values = numericValues(match[2] ?? "");
    let next = identityMatrix();
    if (name === "matrix" && values.length >= 6) {
      next = {
        a: values[0] ?? 1,
        b: values[1] ?? 0,
        c: values[2] ?? 0,
        d: values[3] ?? 1,
        e: values[4] ?? 0,
        f: values[5] ?? 0,
      };
    } else if (name === "translate") {
      next.e = values[0] ?? 0;
      next.f = values[1] ?? 0;
    } else if (name === "scale") {
      next.a = values[0] ?? 1;
      next.d = values[1] ?? values[0] ?? 1;
    } else if (name === "rotate") {
      const radians = ((values[0] ?? 0) * Math.PI) / 180;
      const cosine = Math.cos(radians);
      const sine = Math.sin(radians);
      const cx = values[1] ?? 0;
      const cy = values[2] ?? 0;
      next = {
        a: cosine,
        b: sine,
        c: -sine,
        d: cosine,
        e: cx - cosine * cx + sine * cy,
        f: cy - sine * cx - cosine * cy,
      };
    } else if (name === "skewx") {
      next.c = Math.tan(((values[0] ?? 0) * Math.PI) / 180);
    } else if (name === "skewy") {
      next.b = Math.tan(((values[0] ?? 0) * Math.PI) / 180);
    }
    matrix = multiplyMatrices(matrix, next);
  }
  return matrix;
}

function identityMatrix(): AffineMatrix {
  return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
}

function multiplyMatrices(left: AffineMatrix, right: AffineMatrix): AffineMatrix {
  return {
    a: left.a * right.a + left.c * right.b,
    b: left.b * right.a + left.d * right.b,
    c: left.a * right.c + left.c * right.d,
    d: left.b * right.c + left.d * right.d,
    e: left.a * right.e + left.c * right.f + left.e,
    f: left.b * right.e + left.d * right.f + left.f,
  };
}

function applyMatrix(matrix: AffineMatrix, point: Point): Point {
  return {
    x: matrix.a * point.x + matrix.c * point.y + matrix.e,
    y: matrix.b * point.x + matrix.d * point.y + matrix.f,
  };
}

function transformBounds(bounds: Bounds, matrix: AffineMatrix): Bounds {
  return boundsForPoints([
    applyMatrix(matrix, { x: bounds.x, y: bounds.y }),
    applyMatrix(matrix, { x: bounds.x + bounds.width, y: bounds.y }),
    applyMatrix(matrix, { x: bounds.x + bounds.width, y: bounds.y + bounds.height }),
    applyMatrix(matrix, { x: bounds.x, y: bounds.y + bounds.height }),
  ]) ?? bounds;
}

function pathPoints(path: string | null): Point[] {
  const tokens = (path ?? "").match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:e[-+]?\d+)?/gi) ?? [];
  const parameterCounts: Record<string, number> = {
    A: 7,
    C: 6,
    H: 1,
    L: 2,
    M: 2,
    Q: 4,
    S: 4,
    T: 2,
    V: 1,
  };
  const points: Point[] = [];
  let command = "";
  let index = 0;
  let current: Point = { x: 0, y: 0 };
  let subpathStart: Point = { x: 0, y: 0 };

  while (index < tokens.length) {
    const token = tokens[index];
    if (token && /^[a-zA-Z]$/.test(token)) {
      command = token;
      index += 1;
      if (command.toUpperCase() === "Z") {
        current = { ...subpathStart };
        points.push({ ...current });
        command = "";
        continue;
      }
    }
    if (!command) {
      break;
    }

    const upper = command.toUpperCase();
    const count = parameterCounts[upper];
    if (!count || index + count > tokens.length) {
      break;
    }
    const values = tokens.slice(index, index + count).map(Number);
    if (values.some((value) => !Number.isFinite(value))) {
      break;
    }
    index += count;
    const relative = command === command.toLowerCase();
    const relativeX = (value: number) => value + (relative ? current.x : 0);
    const relativeY = (value: number) => value + (relative ? current.y : 0);

    if (upper === "H") {
      current = { x: relativeX(values[0] ?? 0), y: current.y };
    } else if (upper === "V") {
      current = { x: current.x, y: relativeY(values[0] ?? 0) };
    } else {
      const coordinateIndex = upper === "A" ? 5 : count - 2;
      current = {
        x: relativeX(values[coordinateIndex] ?? 0),
        y: relativeY(values[coordinateIndex + 1] ?? 0),
      };
    }

    if (upper === "M") {
      subpathStart = { ...current };
      command = relative ? "l" : "L";
    }
    points.push({ ...current });
  }

  return dedupePoints(points);
}

function numericPairs(value: string | null): Point[] {
  const values = numericValues(value ?? "");
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

function numericValues(value: string): number[] {
  return value.match(/[-+]?(?:\d*\.\d+|\d+\.?)(?:e[-+]?\d+)?/gi)?.map(Number) ?? [];
}

function parsePointList(value: string | null): Point[] {
  return numericPairs(value);
}

function dedupePoints(points: Point[]): Point[] {
  return points.filter((point, index) => {
    const previous = points[index - 1];
    return !previous || Math.abs(point.x - previous.x) > 0.0001 ||
      Math.abs(point.y - previous.y) > 0.0001;
  });
}

function edgeDash(element: Element): DiagramLineDash {
  if (hasClass(element, "edge-pattern-dotted")) {
    return "dot";
  }
  if (hasClass(element, "edge-pattern-dashed")) {
    return "dash";
  }
  const dashArray = readStyle(element).get("stroke-dasharray");
  if (!dashArray || dashArray === "none") {
    return "solid";
  }
  const firstDash = numericValues(dashArray)[0] ?? 3;
  const strokeWidth = parseCssNumber(readStyle(element).get("stroke-width")) ?? 1;
  return firstDash <= strokeWidth * 2 ? "dot" : "dash";
}

function markerArrow(element: Element, end: "start" | "end"): DiagramArrowKind {
  const marker = readStyle(element).get(`marker-${end}`)?.toLowerCase();
  if (!marker || marker === "none") {
    return "none";
  }
  if (marker.includes("circle")) {
    return "oval";
  }
  if (marker.includes("diamond")) {
    return "diamond";
  }
  if (marker.includes("barb") || marker.includes("arrow")) {
    return "arrow";
  }
  if (marker.includes("cross")) {
    return "none";
  }
  return "triangle";
}

function semanticNodeKind(element: Element): DiagramNodeKind | undefined {
  let current: Node | null = element;
  while (current?.nodeType === 1) {
    const classes = ((current as Element).getAttribute("class") ?? "").toLowerCase();
    if (/\b(cylinder|database|cyl)\b/.test(classes)) {
      return "cylinder";
    }
    if (/\b(parallelogram|lean-left|lean-right|lean-l|lean-r)\b/.test(classes)) {
      return "parallelogram";
    }
    if (/\b(trapezoid|trapezoidal|inv-trapezoid)\b/.test(classes)) {
      return "trapezoid";
    }
    if (/\b(diamond|rhombus|question|choice)\b/.test(classes)) {
      return "diamond";
    }
    if (/\b(hexagon|hex)\b/.test(classes)) {
      return "hexagon";
    }
    if (/\b(stadium|rounded|outer-path)\b/.test(classes)) {
      return "roundRect";
    }
    current = current.parentNode;
  }
  return undefined;
}

function isDiamond(points: Point[]): boolean {
  if (points.length !== 4) {
    return false;
  }
  const bounds = boundsForPoints(points);
  if (!bounds) {
    return false;
  }
  const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  return points.every((point) =>
    Math.abs(point.x - center.x) < 0.001 || Math.abs(point.y - center.y) < 0.001);
}

function ancestorHasClass(element: Element, token: string): boolean {
  let current = element.parentNode;
  while (current?.nodeType === 1) {
    if (hasClass(current as Element, token)) {
      return true;
    }
    current = current.parentNode;
  }
  return false;
}

function distanceToEdge(point: Point, edge: DiagramEdge): number {
  const points = edge.points && edge.points.length >= 2
    ? edge.points
    : [edge.start, edge.end];
  let distance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    if (start && end) {
      distance = Math.min(distance, distanceToSegment(point, start, end));
    }
  }
  return distance;
}

function distanceToSegment(point: Point, start: Point, end: Point): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  const amount = lengthSquared === 0
    ? 0
    : Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (start.x + amount * dx), point.y - (start.y + amount * dy));
}

function editableObjectCount(nodes: DiagramNode[], edges: DiagramEdge[]): number {
  return nodes.length + edges.reduce((count, edge) => {
    const segments = Math.max(1, (edge.points?.length ?? 2) - 1);
    return count + segments + (edge.label ? 1 : 0);
  }, 0);
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
