import type {
  AffineTransform,
  DiagramPath,
  DiagramPathSegment,
  DiagramPoint,
} from "./types.js";

const TOKEN_PATTERN = /[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:e[-+]?\d+)?/gi;

export function parseSvgPathData(value: string): DiagramPath {
  const tokens = value.match(TOKEN_PATTERN) ?? [];
  const segments: DiagramPathSegment[] = [];
  let index = 0;
  let command = "";
  let current: DiagramPoint = { x: 0, y: 0 };
  let subpathStart: DiagramPoint = { x: 0, y: 0 };
  let previousCommand = "";
  let previousCubicControl: DiagramPoint | undefined;
  let previousQuadraticControl: DiagramPoint | undefined;

  const isCommand = (token: string | undefined): boolean =>
    Boolean(token && /^[a-zA-Z]$/.test(token));
  const hasNumbers = (count: number): boolean =>
    index + count <= tokens.length && !tokens.slice(index, index + count).some(isCommand);
  const readNumbers = (count: number): number[] => {
    if (!hasNumbers(count)) {
      throw new SyntaxError(`SVG path command ${command || "?"} is missing parameters.`);
    }
    const values = tokens.slice(index, index + count).map(Number);
    if (values.some((number) => !Number.isFinite(number))) {
      throw new SyntaxError(`SVG path command ${command || "?"} has invalid parameters.`);
    }
    index += count;
    return values;
  };
  const point = (x: number, y: number, relative: boolean): DiagramPoint => ({
    x: x + (relative ? current.x : 0),
    y: y + (relative ? current.y : 0),
  });

  while (index < tokens.length) {
    if (isCommand(tokens[index])) {
      command = tokens[index] ?? "";
      index += 1;
    } else if (!command) {
      throw new SyntaxError("SVG path data must begin with a command.");
    }

    const upper = command.toUpperCase();
    const relative = command === command.toLowerCase();
    if (upper === "Z") {
      segments.push({ kind: "close" });
      current = { ...subpathStart };
      previousCommand = upper;
      previousCubicControl = undefined;
      previousQuadraticControl = undefined;
      command = "";
      continue;
    }

    if (!"MLHVCSQTA".includes(upper)) {
      throw new SyntaxError(`Unsupported SVG path command: ${command}`);
    }

    let consumed = false;
    let firstParameterSet = true;
    while (index < tokens.length && !isCommand(tokens[index])) {
      consumed = true;
      if (upper === "M" || upper === "L" || upper === "T") {
        const [x = 0, y = 0] = readNumbers(2);
        const to = point(x, y, relative);
        if (upper === "M" && firstParameterSet) {
          segments.push({ kind: "move", to });
          subpathStart = { ...to };
          previousQuadraticControl = undefined;
        } else if (upper === "T") {
          const control = previousCommand === "Q" || previousCommand === "T"
            ? reflect(previousQuadraticControl ?? current, current)
            : { ...current };
          segments.push({ control, kind: "quadratic", to });
          previousQuadraticControl = control;
        } else {
          segments.push({ kind: "line", to });
          previousQuadraticControl = undefined;
        }
        current = to;
      } else if (upper === "H") {
        const [x = 0] = readNumbers(1);
        current = { x: x + (relative ? current.x : 0), y: current.y };
        segments.push({ kind: "line", to: { ...current } });
      } else if (upper === "V") {
        const [y = 0] = readNumbers(1);
        current = { x: current.x, y: y + (relative ? current.y : 0) };
        segments.push({ kind: "line", to: { ...current } });
      } else if (upper === "C") {
        const [x1 = 0, y1 = 0, x2 = 0, y2 = 0, x = 0, y = 0] = readNumbers(6);
        const control1 = point(x1, y1, relative);
        const control2 = point(x2, y2, relative);
        const to = point(x, y, relative);
        segments.push({ control1, control2, kind: "cubic", to });
        current = to;
        previousCubicControl = control2;
      } else if (upper === "S") {
        const [x2 = 0, y2 = 0, x = 0, y = 0] = readNumbers(4);
        const control1 = previousCommand === "C" || previousCommand === "S"
          ? reflect(previousCubicControl ?? current, current)
          : { ...current };
        const control2 = point(x2, y2, relative);
        const to = point(x, y, relative);
        segments.push({ control1, control2, kind: "cubic", to });
        current = to;
        previousCubicControl = control2;
      } else if (upper === "Q") {
        const [x1 = 0, y1 = 0, x = 0, y = 0] = readNumbers(4);
        const control = point(x1, y1, relative);
        const to = point(x, y, relative);
        segments.push({ control, kind: "quadratic", to });
        current = to;
        previousQuadraticControl = control;
      } else if (upper === "A") {
        const [radiusX = 0, radiusY = 0, rotation = 0, largeArc = 0, sweep = 0, x = 0, y = 0]
          = readNumbers(7);
        const to = point(x, y, relative);
        segments.push({
          kind: "arc",
          largeArc: largeArc !== 0,
          radiusX: Math.abs(radiusX),
          radiusY: Math.abs(radiusY),
          rotation,
          sweep: sweep !== 0,
          to,
        });
        current = to;
      }

      previousCommand = upper;
      firstParameterSet = false;
      if (upper !== "C" && upper !== "S") previousCubicControl = undefined;
      if (upper !== "Q" && upper !== "T") previousQuadraticControl = undefined;
      if (upper === "M") command = relative ? "l" : "L";
    }

    if (!consumed) {
      throw new SyntaxError(`SVG path command ${command} is missing parameters.`);
    }
  }

  if (segments.length === 0 || segments[0]?.kind !== "move") {
    throw new SyntaxError("SVG path data must contain an initial move command.");
  }
  return { segments };
}

export function transformDiagramPath(
  path: DiagramPath,
  transform: AffineTransform,
): DiagramPath {
  const scaleX = Math.hypot(transform.a, transform.b);
  const scaleY = Math.hypot(transform.c, transform.d);
  const rotation = Math.atan2(transform.b, transform.a) * 180 / Math.PI;
  const reflected = transform.a * transform.d - transform.b * transform.c < 0;
  return {
    segments: path.segments.map((segment): DiagramPathSegment => {
      if (segment.kind === "close") return segment;
      if (segment.kind === "cubic") {
        return {
          control1: apply(transform, segment.control1),
          control2: apply(transform, segment.control2),
          kind: "cubic",
          to: apply(transform, segment.to),
        };
      }
      if (segment.kind === "quadratic") {
        return {
          control: apply(transform, segment.control),
          kind: "quadratic",
          to: apply(transform, segment.to),
        };
      }
      if (segment.kind === "arc") {
        return {
          ...segment,
          radiusX: segment.radiusX * scaleX,
          radiusY: segment.radiusY * scaleY,
          rotation: segment.rotation + rotation,
          sweep: reflected ? !segment.sweep : segment.sweep,
          to: apply(transform, segment.to),
        };
      }
      return { kind: segment.kind, to: apply(transform, segment.to) };
    }),
  };
}

export function diagramPathPoints(path: DiagramPath): DiagramPoint[] {
  return path.segments.flatMap((segment) => segment.kind === "close" ? [] : [segment.to]);
}

function apply(transform: AffineTransform, point: DiagramPoint): DiagramPoint {
  return {
    x: transform.a * point.x + transform.c * point.y + transform.e,
    y: transform.b * point.x + transform.d * point.y + transform.f,
  };
}

function reflect(control: DiagramPoint, around: DiagramPoint): DiagramPoint {
  return { x: around.x * 2 - control.x, y: around.y * 2 - control.y };
}
