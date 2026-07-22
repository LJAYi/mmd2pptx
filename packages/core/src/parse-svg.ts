import { DOMParser } from "@xmldom/xmldom";

import {
  diagramPathPoints,
  parseSvgPathData,
  transformDiagramPath,
} from "./diagram-ir/path.js";
import { normalizeFontFamily } from "./normalize-font-family.js";
import { mergeMermaidSemantics } from "./source-mapping/merge.js";
import type { MermaidSemanticGraph } from "./source-mapping/types.js";
import type {
  Bounds,
  ConversionDiagnostic,
  ConversionResult,
  DiagramArrowKind,
  DiagramEdge,
  DiagramGroup,
  DiagramIR,
  DiagramLineDash,
  DiagramNode,
  DiagramNodeKind,
  DiagramStrokeStyle,
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

interface CssDeclaration {
  name: string;
  value: string;
}

interface CssRule {
  declarations: CssDeclaration[];
  selector: CssSelector;
  sourceOrder: number;
}

interface CssSelector {
  parts: CssSelectorPart[];
  specificity: number;
}

interface CssSelectorPart {
  classes: string[];
  id?: string;
  tag?: string;
}

interface CssContext {
  rules: CssRule[];
}

const CSS_CONTEXTS = new WeakMap<Document, CssContext>();

export interface ParseMermaidSvgOptions {
  /** Optional semantics obtained from Mermaid FlowDB; SVG geometry/styles remain authoritative. */
  semantics?: MermaidSemanticGraph;
}

export function parseMermaidSvg(
  svg: string,
  options: ParseMermaidSvgOptions = {},
): ConversionResult<DiagramIR> {
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

  return parseSvgRoot(root as unknown as SvgElementLike, options);
}

export function parseMermaidSvgElement(
  svg: SVGSVGElement,
  options: ParseMermaidSvgOptions = {},
): ConversionResult<DiagramIR> {
  return parseSvgRoot(svg as unknown as SvgElementLike, options);
}

function parseSvgRoot(
  root: SvgElementLike,
  options: ParseMermaidSvgOptions,
): ConversionResult<DiagramIR> {
  const diagnostics: ConversionDiagnostic[] = [];
  const viewBox = readViewBox(root);
  if (!viewBox) {
    return failedResult(
      "SVG_DIMENSIONS_MISSING",
      "SVG must define a valid viewBox or numeric width and height.",
    );
  }

  const ownerDocument = root.ownerDocument;
  if (ownerDocument) {
    CSS_CONTEXTS.set(ownerDocument, buildCssContext(root, diagnostics));
  }
  reportUnsupportedSvgFeatures(root, diagnostics);

  const groups = parseGroups(root, viewBox, diagnostics);
  assignGroupParents(groups, diagnostics);
  const nodes = parseNodes(root, viewBox, diagnostics);
  assignNodeGroups(nodes, groups, diagnostics);
  const edges = parseEdges(root, viewBox, nodes, diagnostics);
  diagnostics.push(
    ...duplicateIdDiagnostics(groups, "group"),
    ...duplicateIdDiagnostics(nodes, "node"),
    ...duplicateIdDiagnostics(edges, "edge"),
  );
  if (nodes.length === 0) {
    diagnostics.push({
      code: "NO_MERMAID_NODES",
      message: "No Mermaid flowchart node groups were found in the SVG.",
      severity: "warning",
    });
  }

  const diagramType = mermaidDiagramType(root);
  let diagram: DiagramIR = {
    edges,
    ...(groups.length > 0 ? { groups } : {}),
    height: viewBox.height,
    nodes,
    schemaVersion: "1.0",
    source: {
      kind: "mermaid",
      ...(diagramType ? { diagramType } : {}),
    },
    width: viewBox.width,
  };

  if (options.semantics) {
    const merged = mergeMermaidSemantics(diagram, options.semantics);
    diagram = merged.data;
    diagnostics.push(...merged.diagnostics);
  }

  return {
    data: diagram,
    diagnostics,
    summary: {
      editableObjects: editableObjectCount(nodes, edges) + groups.length,
      edges: edges.length,
      fallbackObjects: new Set(
        diagnostics
          .filter(({ severity, elementId }) => severity === "warning" && elementId)
          .map(({ elementId }) => elementId!),
      ).size,
      nodes: nodes.length,
    },
  };
}

function duplicateIdDiagnostics(
  values: readonly { id: string }[],
  kind: "node" | "edge" | "group",
): ConversionDiagnostic[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const { id } of values) {
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  return [...duplicates].map((id) => ({
    code: `DUPLICATE_${kind.toUpperCase()}_ID`,
    elementId: id,
    message: `Mermaid SVG contains more than one ${kind} with id '${id}'.`,
    severity: "error" as const,
  }));
}

function mermaidDiagramType(root: Element): string | undefined {
  const role = root.getAttribute("aria-roledescription")?.trim();
  if (role) return role === "flowchart-v2" ? "flowchart" : role;
  const known = (root.getAttribute("class") ?? "")
    .split(/\s+/)
    .find((token) => token === "flowchart" || token.endsWith("Diagram"));
  return known || undefined;
}

const GROUP_IDS = new WeakMap<Element, string>();

function parseGroups(
  root: SvgElementLike,
  viewBox: ViewBox,
  diagnostics: ConversionDiagnostic[],
): DiagramGroup[] {
  const elements = Array.from(root.getElementsByTagName("g"))
    .filter((group) => hasClass(group, "cluster"));
  elements.forEach((group, index) => {
    GROUP_IDS.set(group, group.getAttribute("id") || group.getAttribute("data-id") || `group-${index + 1}`);
  });

  const groups: DiagramGroup[] = [];
  for (const element of elements) {
    const id = GROUP_IDS.get(element)!;
    const shape = firstClusterShape(element);
    if (!shape) {
      diagnostics.push({
        code: "GROUP_SHAPE_UNSUPPORTED",
        elementId: id,
        message: "A Mermaid subgraph had no supported container outline.",
        severity: "warning",
      });
      continue;
    }
    const transform = accumulatedTransform(shape);
    const geometry = shapeGeometry(shape, transform, viewBox);
    if (!geometry) {
      diagnostics.push({
        code: "GROUP_GEOMETRY_INVALID",
        elementId: id,
        message: "A Mermaid subgraph container had invalid dimensions.",
        severity: "warning",
      });
      continue;
    }
    const style = readShapeStyle(shape);
    const parentId = nearestClusterId(element.parentNode);
    const semanticId = element.getAttribute("data-id") || undefined;
    const text = readClusterText(element, geometry.bounds, viewBox);
    groups.push({
      bounds: geometry.bounds,
      id,
      ...(parentId ? { parentId } : {}),
      ...(semanticId ? { semanticId, sourceKey: semanticId } : { sourceKey: id }),
      sourceRef: { elementId: id, kind: "group" },
      ...(style.fill ? { fill: style.fill } : {}),
      ...(style.stroke ? { stroke: style.stroke } : {}),
      ...(style.strokeWidth !== undefined ? { strokeWidth: style.strokeWidth } : {}),
      ...(text ? { text } : {}),
    });
  }
  return groups;
}

function firstClusterShape(group: Element): Element | undefined {
  return Array.from(group.childNodes)
    .filter((node): node is Element => node.nodeType === 1)
    .find((element) => isSupportedShape(element) && hasPositiveGeometry(element));
}

function nearestClusterId(node: Node | null): string | undefined {
  let current = node;
  while (current?.nodeType === 1) {
    const element = current as Element;
    if (hasClass(element, "cluster")) return GROUP_IDS.get(element);
    current = current.parentNode;
  }
  return undefined;
}

function readClusterText(
  group: Element,
  fallbackBounds: Bounds,
  viewBox: ViewBox,
): DiagramText | undefined {
  const label = Array.from(group.getElementsByTagName("g"))
    .find((candidate) => hasClass(candidate, "cluster-label")
      && nearestClusterId(candidate.parentNode) === GROUP_IDS.get(group));
  if (!label) return undefined;
  const source = label.getElementsByTagName("foreignObject")[0]
    ?? label.getElementsByTagName("text")[0];
  if (!source) return undefined;
  return readTextElement(source, textElementBounds(source, viewBox) ?? fallbackBounds);
}

function assignGroupParents(
  groups: DiagramGroup[],
  diagnostics: ConversionDiagnostic[],
): void {
  for (const group of groups) {
    if (group.parentId) continue;
    const candidates = groups
      .filter((candidate) => candidate.id !== group.id
        && boundsContain(candidate.bounds, group.bounds))
      .sort((left, right) => boundsArea(left.bounds) - boundsArea(right.bounds));
    assignContainingParent(group, candidates, "GROUP_PARENT_AMBIGUOUS", diagnostics);
  }
}

function assignNodeGroups(
  nodes: DiagramNode[],
  groups: readonly DiagramGroup[],
  diagnostics: ConversionDiagnostic[],
): void {
  for (const node of nodes) {
    if (node.parentId) continue;
    const candidates = groups
      .filter((group) => boundsContain(group.bounds, node.bounds))
      .sort((left, right) => boundsArea(left.bounds) - boundsArea(right.bounds));
    assignContainingParent(node, candidates, "NODE_GROUP_AMBIGUOUS", diagnostics);
  }
}

function assignContainingParent(
  child: DiagramNode | DiagramGroup,
  candidates: readonly DiagramGroup[],
  diagnosticCode: string,
  diagnostics: ConversionDiagnostic[],
): void {
  const best = candidates[0];
  if (!best) return;
  const next = candidates[1];
  if (next && Math.abs(boundsArea(best.bounds) - boundsArea(next.bounds)) < 0.0001) {
    diagnostics.push({
      code: diagnosticCode,
      elementId: child.id,
      message: "More than one subgraph equally contains this element; parent ownership was left unset.",
      severity: "warning",
    });
    return;
  }
  child.parentId = best.semanticId ?? best.sourceKey ?? best.id;
}

function boundsContain(outer: Bounds, inner: Bounds): boolean {
  const epsilon = 0.001;
  return inner.x >= outer.x - epsilon
    && inner.y >= outer.y - epsilon
    && inner.x + inner.width <= outer.x + outer.width + epsilon
    && inner.y + inner.height <= outer.y + outer.height + epsilon;
}

function boundsArea(bounds: Bounds): number {
  return bounds.width * bounds.height;
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

    if (shape.tagName.toLowerCase() === "path"
      && !semanticNodeKind(shape)
      && !hasSelfOrAncestorClass(shape, "outer-path", group)) {
      const elementId = group.getAttribute("id") || undefined;
      diagnostics.push({
        code: "NODE_PATH_SHAPE_UNSUPPORTED",
        message: "A path-based Mermaid node had no recognized shape semantics and was omitted.",
        severity: "warning",
        ...(elementId ? { elementId } : {}),
      });
      continue;
    }

    // Start at the selected outline so Mermaid v11 shape- and wrapper-level
    // transforms are composed together with the ancestor node transform.
    const transform = accumulatedTransform(shape);
    if (!isAxisAlignedTransform(transform)) {
      const elementId = group.getAttribute("id") || undefined;
      diagnostics.push({
        code: "NODE_TRANSFORM_DOWNGRADED",
        message: "A rotated or skewed node outline was reduced to an axis-aligned bounding box.",
        severity: "warning",
        ...(elementId ? { elementId } : {}),
      });
    }
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
    const id = group.getAttribute("id") || `node-${nodes.length + 1}`;
    const semanticId = group.getAttribute("data-id") || semanticNodeId(id);
    const parentId = nearestClusterId(group.parentNode);
    nodes.push({
      bounds: geometry.bounds,
      id,
      kind: geometry.kind,
      ...(parentId ? { parentId } : {}),
      ...(semanticId ? { semanticId, sourceKey: semanticId } : { sourceKey: id }),
      sourceRef: { elementId: id, kind: "node" },
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
  nodes: readonly DiagramNode[],
  diagnostics: ConversionDiagnostic[],
): DiagramEdge[] {
  const paths = Array.from(root.getElementsByTagName("path"));
  const edges: DiagramEdge[] = [];

  for (const path of paths) {
    if (!hasClass(path, "flowchart-link") && !hasClass(path, "edge-thickness-normal")) {
      continue;
    }

    const pathData = path.getAttribute("d");
    let canonicalPath;
    try {
      const transform = accumulatedTransform(path);
      const sourcePath = parseSvgPathData(pathData ?? "");
      if (sourcePath.segments.some(({ kind }) => kind === "arc") && hasShear(transform)) {
        const elementId = path.getAttribute("id");
        diagnostics.push({
          code: "EDGE_ARC_TRANSFORM_APPROXIMATED",
          message: "An SVG arc uses a skewed transform; its canonical radii are approximated.",
          severity: "warning",
          ...(elementId ? { elementId } : {}),
        });
      }
      canonicalPath = transformDiagramPath(sourcePath, {
        ...transform,
        e: transform.e - viewBox.minX,
        f: transform.f - viewBox.minY,
      });
    } catch {
      const elementId = path.getAttribute("id");
      diagnostics.push({
        code: "EDGE_PATH_UNSUPPORTED",
        message: "An edge path could not be normalized into canonical geometry.",
        severity: "warning",
        ...(elementId ? { elementId } : {}),
      });
      continue;
    }

    const points = dedupePoints(diagramPathPoints(canonicalPath));
    if (points.length < 2) {
      continue;
    }

    const id = path.getAttribute("id") || `edge-${edges.length + 1}`;
    const style = readShapeStyle(path);
    const dash = edgeDash(path);
    const startArrow = markerArrow(path, "start", id, diagnostics);
    const endArrow = markerArrow(path, "end", id, diagnostics);
    const stroke = edgeStrokeStyle(path, style);
    const start = points[0];
    const end = points.at(-1);
    if (!start || !end) {
      continue;
    }
    const endpoints = semanticEndpoints(path, nodes, start, end);
    edges.push({
      color: style.stroke ?? "333333",
      end,
      id,
      path: canonicalPath,
      points,
      sourceKey: path.getAttribute("data-id") || id,
      sourceRef: { elementId: id, kind: "edge" },
      start,
      stroke,
      ...(endpoints.sourceId ? { sourceId: endpoints.sourceId } : {}),
      ...(endpoints.targetId ? { targetId: endpoints.targetId } : {}),
      ...(dash !== "solid" ? { dash } : {}),
      ...(startArrow !== "none" ? { startArrow } : {}),
      ...(endArrow !== "none" ? { endArrow } : {}),
      ...(style.strokeWidth !== undefined ? { strokeWidth: style.strokeWidth } : {}),
    });
  }

  attachEdgeLabels(root, edges, viewBox);
  return edges;
}

function hasShear(transform: AffineMatrix): boolean {
  const scale = Math.max(
    Math.hypot(transform.a, transform.b) * Math.hypot(transform.c, transform.d),
    1,
  );
  return Math.abs(transform.a * transform.c + transform.b * transform.d) > scale * 0.000001;
}

function isAxisAlignedTransform(transform: AffineMatrix): boolean {
  const scale = Math.max(Math.abs(transform.a), Math.abs(transform.d), 1);
  return Math.abs(transform.b) <= scale * 0.000001
    && Math.abs(transform.c) <= scale * 0.000001;
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

const STYLE_NAMES = new Set([
  "color",
  "fill",
  "filter",
  "font-family",
  "font-size",
  "marker-end",
  "marker-start",
  "opacity",
  "stroke",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-opacity",
  "stroke-width",
  "text-anchor",
]);

const INHERITED_STYLE_NAMES = [
  "color",
  "fill",
  "font-family",
  "font-size",
  "stroke",
  "stroke-width",
] as const;

function buildCssContext(
  root: SvgElementLike,
  diagnostics: ConversionDiagnostic[],
): CssContext {
  const rules: CssRule[] = [];
  let sourceOrder = 0;
  for (const [styleIndex, element] of Array.from(root.getElementsByTagName("style")).entries()) {
    const css = (element.textContent ?? "").replace(/\/\*[\s\S]*?\*\//g, "");
    const rulePattern = /([^{}]+)\{([^{}]*)\}/g;
    let consumed = "";
    for (const match of css.matchAll(rulePattern)) {
      consumed += match[0];
      const declarationText = match[2] ?? "";
      const declarations: CssDeclaration[] = [];
      for (const raw of declarationText.split(";")) {
        if (!raw.trim()) continue;
        const separator = raw.indexOf(":");
        if (separator <= 0) {
          diagnostics.push(cssDiagnostic(
            "SVG_CSS_RULE_UNSUPPORTED",
            element,
            styleIndex,
            `CSS declaration '${raw.trim()}' could not be parsed and was ignored.`,
          ));
          continue;
        }
        const name = raw.slice(0, separator).trim().toLowerCase();
        const value = stripCssPriority(raw.slice(separator + 1).trim());
        if (!STYLE_NAMES.has(name)) continue;
        if (/var\s*\(/i.test(value)) {
          diagnostics.push(cssDiagnostic(
            "SVG_CSS_VARIABLE_UNSUPPORTED",
            element,
            styleIndex,
            `CSS variable value '${value}' could not be resolved deterministically and was ignored.`,
          ));
          continue;
        }
        declarations.push({ name, value });
      }
      for (const rawSelector of (match[1] ?? "").split(",")) {
        const selector = parseCssSelector(rawSelector.trim());
        if (!selector) {
          diagnostics.push(cssDiagnostic(
            "SVG_CSS_SELECTOR_UNSUPPORTED",
            element,
            styleIndex,
            `CSS selector '${rawSelector.trim()}' is outside the supported tag/class/id descendant subset.`,
          ));
          continue;
        }
        rules.push({ declarations, selector, sourceOrder });
        sourceOrder += 1;
      }
    }
    const remainder = css.replace(rulePattern, "").trim();
    if (remainder || (css.trim() && !consumed)) {
      diagnostics.push(cssDiagnostic(
        "SVG_CSS_RULE_UNSUPPORTED",
        element,
        styleIndex,
        "A CSS rule could not be parsed and was ignored.",
      ));
    }
  }
  return { rules };
}

function cssDiagnostic(
  code: string,
  element: Element,
  index: number,
  message: string,
): ConversionDiagnostic {
  return {
    code,
    elementId: element.getAttribute("id") || `style-${index + 1}`,
    message,
    severity: "warning",
  };
}

function parseCssSelector(value: string): CssSelector | undefined {
  if (!value || /[>+~:\[\]*]/.test(value)) return undefined;
  const tokens = value.split(/\s+/);
  const parts: CssSelectorPart[] = [];
  let specificity = 0;
  for (const token of tokens) {
    if (!/^(?:[A-Za-z][\w-]*)?(?:[.#][\w-]+)*$/.test(token)) return undefined;
    const tag = /^[A-Za-z][\w-]*/.exec(token)?.[0]?.toLowerCase();
    const classes = [...token.matchAll(/\.([\w-]+)/g)].map((match) => match[1]!);
    const ids = [...token.matchAll(/#([\w-]+)/g)].map((match) => match[1]!);
    if (ids.length > 1) return undefined;
    specificity += ids.length * 100 + classes.length * 10 + (tag ? 1 : 0);
    parts.push({ classes, ...(ids[0] ? { id: ids[0] } : {}), ...(tag ? { tag } : {}) });
  }
  return parts.length > 0 ? { parts, specificity } : undefined;
}

function selectorMatches(element: Element, selector: CssSelector): boolean {
  let current: Element | undefined = element;
  for (let index = selector.parts.length - 1; index >= 0; index -= 1) {
    const part = selector.parts[index]!;
    if (index === selector.parts.length - 1) {
      if (!compoundSelectorMatches(current!, part)) return false;
      current = parentElement(current!);
      continue;
    }
    while (current && !compoundSelectorMatches(current, part)) {
      current = parentElement(current);
    }
    if (!current) return false;
    current = parentElement(current);
  }
  return true;
}

function compoundSelectorMatches(element: Element, part: CssSelectorPart): boolean {
  if (part.tag && element.tagName.toLowerCase() !== part.tag) return false;
  if (part.id && element.getAttribute("id") !== part.id) return false;
  return part.classes.every((token) => hasClass(element, token));
}

function parentElement(element: Element): Element | undefined {
  return element.parentNode?.nodeType === 1 ? element.parentNode as Element : undefined;
}

function ownStyle(element: Element): Map<string, string> {
  const style = new Map<string, string>();
  for (const name of STYLE_NAMES) {
    const value = element.getAttribute(name);
    if (value) {
      style.set(name, stripCssPriority(value));
    }
  }
  const context = element.ownerDocument ? CSS_CONTEXTS.get(element.ownerDocument) : undefined;
  const matching = context?.rules
    .filter(({ selector }) => selectorMatches(element, selector))
    .sort((left, right) => left.selector.specificity - right.selector.specificity
      || left.sourceOrder - right.sourceOrder) ?? [];
  for (const rule of matching) {
    for (const { name, value } of rule.declarations) style.set(name, value);
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
  return style;
}

function readStyle(element: Element): Map<string, string> {
  const style = ownStyle(element);
  let ancestor = parentElement(element);
  while (ancestor) {
    const inherited = ownStyle(ancestor);
    for (const name of INHERITED_STYLE_NAMES) {
      if (!style.has(name) && inherited.has(name)) style.set(name, inherited.get(name)!);
    }
    ancestor = parentElement(ancestor);
  }
  return style;
}

function reportUnsupportedSvgFeatures(
  root: SvgElementLike,
  diagnostics: ConversionDiagnostic[],
): void {
  Array.from(root.getElementsByTagName("use")).forEach((element, index) => {
    diagnostics.push({
      code: "SVG_USE_UNSUPPORTED",
      elementId: svgElementIdentity(element, "use", index),
      message: "SVG <use> references are not expanded; this element was omitted from editable geometry.",
      severity: "warning",
    });
  });
  Array.from(root.getElementsByTagName("*"))
    .filter((element) => /var\s*\(/i.test(element.getAttribute("style") ?? ""))
    .forEach((element, index) => {
      diagnostics.push({
        code: "SVG_CSS_VARIABLE_UNSUPPORTED",
        elementId: svgElementIdentity(element, element.tagName.toLowerCase(), index),
        message: "An inline CSS variable could not be resolved deterministically and was ignored.",
        severity: "warning",
      });
    });
  Array.from(root.getElementsByTagName("*"))
    .filter((element) => {
      const filter = readStyle(element).get("filter");
      return Boolean(filter && filter !== "none");
    })
    .forEach((element, index) => {
      diagnostics.push({
        code: "SVG_FILTER_UNSUPPORTED",
        elementId: svgElementIdentity(element, element.tagName.toLowerCase(), index),
        message: "SVG filter effects have no deterministic editable mapping and were omitted.",
        severity: "warning",
      });
    });
}

function svgElementIdentity(element: Element, prefix: string, index: number): string {
  let current: Element | undefined = element;
  while (current) {
    const identity = current.getAttribute("id") || current.getAttribute("data-id");
    if (identity) return identity;
    current = parentElement(current);
  }
  return `${prefix}-${index + 1}`;
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

function edgeStrokeStyle(
  element: Element,
  shapeStyle: ReturnType<typeof readShapeStyle>,
): DiagramStrokeStyle {
  const style = readStyle(element);
  const dashArray = numericValues(style.get("stroke-dasharray") ?? "")
    .filter((value) => Number.isFinite(value) && value >= 0);
  const dashOffset = parseCssNumber(style.get("stroke-dashoffset"));
  const lineCap = style.get("stroke-linecap");
  const lineJoin = style.get("stroke-linejoin");
  const opacity = parseCssNumber(style.get("stroke-opacity") ?? style.get("opacity"));
  return {
    ...(shapeStyle.stroke ? { color: shapeStyle.stroke } : {}),
    ...(shapeStyle.strokeWidth !== undefined ? { width: shapeStyle.strokeWidth } : {}),
    ...(dashArray.length > 0 ? { dashArray } : {}),
    ...(dashOffset !== undefined ? { dashOffset } : {}),
    ...(lineCap === "butt" || lineCap === "round" || lineCap === "square" ? { lineCap } : {}),
    ...(lineJoin === "bevel" || lineJoin === "miter" || lineJoin === "round"
      ? { lineJoin }
      : {}),
    ...(opacity !== undefined ? { opacity: Math.min(1, Math.max(0, opacity)) } : {}),
  };
}

function explicitSemanticEndpoint(element: Element, end: "source" | "target"): string | undefined {
  const value = element.getAttribute(`data-${end}`)
    || element.getAttribute(end === "source" ? "data-from" : "data-to");
  return value?.trim() || undefined;
}

function semanticEndpoints(
  element: Element,
  nodes: readonly DiagramNode[],
  start: Point,
  end: Point,
): { sourceId?: string; targetId?: string } {
  const sourceId = explicitSemanticEndpoint(element, "source");
  const targetId = explicitSemanticEndpoint(element, "target");
  if (sourceId || targetId) {
    const inferredSource = sourceId ?? nearestNodeKey(start, nodes);
    const inferredTarget = targetId ?? nearestNodeKey(end, nodes);
    return {
      ...(inferredSource ? { sourceId: inferredSource } : {}),
      ...(inferredTarget ? { targetId: inferredTarget } : {}),
    };
  }

  // Mermaid 11 flowchart paths expose stable data-id values such as
  // L_source_target_0, but commonly omit data-source/data-target attributes.
  // Match the body against known semantic node IDs instead of splitting on
  // underscores, which are valid inside Mermaid IDs.
  const edgeId = element.getAttribute("data-id") ?? "";
  const match = /^L_(.*)_\d+$/.exec(edgeId);
  if (match?.[1]) {
    const body = match[1];
    const candidates = nodes.flatMap((source) => nodes.flatMap((target) => {
      if (!source.semanticId || !target.semanticId
        || `${source.semanticId}_${target.semanticId}` !== body) return [];
      return [{
        score: distanceToBounds(start, source.bounds) + distanceToBounds(end, target.bounds),
        sourceId: source.semanticId,
        targetId: target.semanticId,
      }];
    })).sort((left, right) => left.score - right.score);
    const candidate = candidates[0];
    if (candidate) return { sourceId: candidate.sourceId, targetId: candidate.targetId };
  }

  const inferredSource = nearestNodeKey(start, nodes);
  const inferredTarget = nearestNodeKey(end, nodes);
  return {
    ...(inferredSource ? { sourceId: inferredSource } : {}),
    ...(inferredTarget ? { targetId: inferredTarget } : {}),
  };
}

function nearestNodeKey(point: Point, nodes: readonly DiagramNode[], tolerance = 8): string | undefined {
  const nearest = nodes
    .map((node) => ({
      distance: distanceToBounds(point, node.bounds),
      key: node.semanticId ?? node.sourceKey ?? node.id,
    }))
    .filter(({ distance }) => distance <= tolerance)
    .sort((left, right) => left.distance - right.distance)[0];
  return nearest?.key;
}

function distanceToBounds(point: Point, bounds: Bounds): number {
  const dx = Math.max(bounds.x - point.x, 0, point.x - (bounds.x + bounds.width));
  const dy = Math.max(bounds.y - point.y, 0, point.y - (bounds.y + bounds.height));
  return Math.hypot(dx, dy);
}

function semanticNodeId(rendererId: string): string | undefined {
  return /(?:^|.*-)flowchart-(.+)-\d+$/.exec(rendererId)?.[1];
}

function markerArrow(
  element: Element,
  end: "start" | "end",
  edgeId: string,
  diagnostics: ConversionDiagnostic[],
): DiagramArrowKind {
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
  if (marker.includes("point") || marker.includes("triangle")) {
    return "triangle";
  }
  diagnostics.push({
    code: "EDGE_MARKER_UNSUPPORTED",
    elementId: edgeId,
    message: `The ${end} marker '${marker}' has no safe editable mapping and was omitted.`,
    severity: "warning",
  });
  return "none";
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
  return nodes.length + edges.length + edges.filter(({ label }) => Boolean(label)).length;
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
