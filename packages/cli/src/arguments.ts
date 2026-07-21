import { resolve } from "node:path";

export type SlideLayout = "standard" | "wide";

export interface CliOptions {
  backgroundColor?: string;
  help: boolean;
  inputPath?: string;
  layout: SlideLayout;
  outputPath?: string;
}

export const HELP_TEXT = `mmd2pptx — convert Mermaid into an editable PowerPoint file

Usage:
  mmd2pptx <diagram.mmd|diagram.svg> [options]

Options:
  -o, --output <file>       Output .pptx path (default: beside the input)
      --layout <layout>     Slide layout: wide or standard (default: wide)
      --background <color>  Slide background color, for example #ffffff
  -h, --help                Show this help

Mermaid source (.mmd) is rendered in headless Chrome. Mermaid-generated SVG
(.svg) uses the direct conversion path and does not launch a browser.
`;

export function parseCliArguments(argv: string[], cwd = process.cwd()): CliOptions {
  const options: CliOptions = { help: false, layout: "wide" };
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

    if (argument === "--layout") {
      const value = requireValue(argv, ++index, argument);
      if (value !== "wide" && value !== "standard") {
        throw new Error(`Invalid layout "${value}". Expected "wide" or "standard".`);
      }
      options.layout = value;
      continue;
    }

    if (argument === "--background") {
      options.backgroundColor = requireValue(argv, ++index, argument);
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

function requireValue(argv: string[], index: number, option: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith("-")) {
    throw new Error(`Missing value for ${option}.`);
  }
  return value;
}
