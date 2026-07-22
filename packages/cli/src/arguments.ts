import { resolve } from "node:path";

export type SlideLayout = "standard" | "wide";
export type CliOutputFormat = "pptx" | "svg" | "drawio" | "json-canvas";
export type PptxMode = "smart" | "faithful" | "exact";

export interface CliOptions {
  backgroundColor?: string;
  format: CliOutputFormat;
  help: boolean;
  inputPath?: string;
  layout: SlideLayout;
  mode?: PptxMode;
  outputPath?: string;
}

export const HELP_TEXT = `mmd2pptx — export Mermaid to PPTX, SVG, draw.io, or JSON Canvas

Usage:
  mmd2pptx <diagram.mmd|diagram.svg> [options]

Options:
  -f, --format <format>     pptx, svg, drawio, or json-canvas (default: pptx)
  -o, --output <file>       Output path (default: beside the input)
      --layout <layout>     Slide layout: wide or standard (default: wide)
      --mode <mode>         PPTX mode: smart, faithful, or exact (default: smart)
      --background <color>  Six-digit hex background, for example #ffffff
  -h, --help                Show this help

Mermaid source (.mmd) is rendered in headless Chrome. Mermaid-generated SVG
(.svg) uses the direct conversion path and does not launch a browser. Default
extensions are .pptx, .svg, .drawio, and .canvas respectively.
`;

export function parseCliArguments(argv: string[], cwd = process.cwd()): CliOptions {
  const options: CliOptions = { format: "pptx", help: false, layout: "wide" };
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) {
      continue;
    }

    if (argument === "-h" || argument === "--help") {
      options.help = true;
      continue;
    }

    if (argument === "-o" || argument === "--output") {
      options.outputPath = resolve(cwd, requireValue(argv, ++index, argument));
      continue;
    }

    if (argument === "-f" || argument === "--format") {
      const value = requireValue(argv, ++index, argument);
      if (!isOutputFormat(value)) {
        throw new Error(
          `Invalid format "${value}". Expected "pptx", "svg", "drawio", or "json-canvas".`,
        );
      }
      options.format = value;
      continue;
    }

    if (argument === "--layout") {
      const value = requireValue(argv, ++index, argument);
      if (value !== "wide" && value !== "standard") {
        throw new Error(`Invalid layout "${value}". Expected "wide" or "standard".`);
      }
      options.layout = value;
      continue;
    }

    if (argument === "--mode") {
      const value = requireValue(argv, ++index, argument);
      if (value !== "smart" && value !== "faithful" && value !== "exact") {
        throw new Error(`Invalid mode "${value}". Expected "smart", "faithful", or "exact".`);
      }
      options.mode = value;
      continue;
    }

    if (argument === "--background") {
      const value = requireValue(argv, ++index, argument);
      if (!/^#[0-9A-Fa-f]{6}$/.test(value)) {
        throw new Error(`Invalid background color "${value}". Expected #RRGGBB.`);
      }
      options.backgroundColor = value;
      continue;
    }

    if (argument.startsWith("-")) {
      throw new Error(`Unknown option: ${argument}`);
    }

    positionals.push(argument);
  }

  if (!options.help) {
    if (positionals.length === 0) {
      throw new Error("Missing input file (.mmd or .svg).");
    }
    if (positionals.length > 1) {
      throw new Error("Only one input file can be converted at a time.");
    }
  }

  const input = positionals[0];
  if (input !== undefined) {
    options.inputPath = resolve(cwd, input);
  }

  return options;
}

function isOutputFormat(value: string): value is CliOutputFormat {
  return value === "pptx" || value === "svg"
    || value === "drawio" || value === "json-canvas";
}

function requireValue(argv: string[], index: number, option: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith("-")) {
    throw new Error(`Missing value for ${option}.`);
  }
  return value;
}
