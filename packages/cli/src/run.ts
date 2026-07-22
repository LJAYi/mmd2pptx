import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";

import {
  drawioExporter,
  jsonCanvasExporter,
  parseMermaidSvg,
  svgExporter,
  svgStringToPptxBuffer,
} from "@mmd2pptx/core";
import type {
  ConversionOptions,
  ConversionResult,
} from "@mmd2pptx/core";

import {
  HELP_TEXT,
  parseCliArguments,
  type CliOutputFormat,
} from "./arguments.js";
import { renderMermaidSourceToSvg } from "./render-mermaid.js";

export interface CliIo {
  error(message: string): void;
  log(message: string): void;
}

export interface CliDependencies {
  convertForward?(
    svg: string,
    format: ForwardCliOutputFormat,
    options?: ConversionOptions,
  ): Promise<ConversionResult<string>>;
  convertSvg(
    svg: string,
    options?: ConversionOptions,
  ): Promise<ConversionResult<Uint8Array>>;
  renderMermaid(source: string): Promise<string>;
}

const defaultIo: CliIo = {
  error: (message) => console.error(message),
  log: (message) => console.log(message),
};

const defaultDependencies: CliDependencies = {
  convertForward: convertForwardSvg,
  convertSvg: svgStringToPptxBuffer,
  renderMermaid: renderMermaidSourceToSvg,
};

type ForwardCliOutputFormat = Exclude<CliOutputFormat, "pptx">;

export async function runCli(
  argv: string[],
  io: CliIo = defaultIo,
  dependencies: CliDependencies = defaultDependencies,
): Promise<number> {
  let options;
  try {
    options = parseCliArguments(argv);
  } catch (error) {
    io.error(`mmd2pptx: ${errorMessage(error)}\n\n${HELP_TEXT}`);
    return 2;
  }

  if (options.help) {
    io.log(HELP_TEXT);
    return 0;
  }

  // parseCliArguments guarantees this when help is false.
  const inputPath = options.inputPath;
  if (inputPath === undefined) {
    io.error("mmd2pptx: Missing input file (.mmd or .svg).");
    return 2;
  }

  const inputExtension = extname(inputPath).toLowerCase();
  if (inputExtension !== ".mmd" && inputExtension !== ".svg") {
    io.error(
      `mmd2pptx: Unsupported input "${basename(inputPath)}". Expected a .mmd or .svg file.`,
    );
    return 2;
  }

  const outputPath = options.outputPath ?? defaultOutputPath(inputPath, options.format);
  const expectedExtension = outputExtension(options.format);
  if (extname(outputPath).toLowerCase() !== expectedExtension) {
    io.error(`mmd2pptx: The ${options.format} output path must end in ${expectedExtension}.`);
    return 2;
  }
  if (resolve(outputPath) === resolve(inputPath)
    || await pathsReferToSameFile(inputPath, outputPath)) {
    io.error("mmd2pptx: The output path must not overwrite the input file.");
    return 2;
  }
  if (options.format !== "pptx" && options.mode !== undefined) {
    io.error("mmd2pptx: --mode applies only to PPTX output.");
    return 2;
  }

  try {
    const source = await readFile(inputPath, "utf8");
    const svg = inputExtension === ".mmd"
      ? await dependencies.renderMermaid(source)
      : source;
    const conversionOptions: ConversionOptions = {
      ...(options.backgroundColor === undefined
        ? {}
        : { backgroundColor: options.backgroundColor }),
      layout: options.layout,
      ...(options.mode ? { mode: options.mode } : {}),
    };
    const result = options.format === "pptx"
      ? await dependencies.convertSvg(svg, conversionOptions)
      : await (dependencies.convertForward ?? convertForwardSvg)(
        svg,
        options.format,
        conversionOptions,
      );

    for (const diagnostic of result.diagnostics) {
      const location = diagnostic.elementId ? ` (${diagnostic.elementId})` : "";
      const formatted = `[${diagnostic.severity}] ${diagnostic.code}: ${diagnostic.message}${location}`;
      if (diagnostic.severity === "error") {
        io.error(formatted);
      } else {
        io.log(formatted);
      }
    }

    if (result.diagnostics.some(({ severity }) => severity === "error")) {
      io.error("mmd2pptx: Conversion failed; no output file was written.");
      return 1;
    }

    await writeFile(outputPath, result.data);
    io.log(
      `Wrote ${outputPath} (${result.summary.editableObjects} editable objects, ${result.summary.fallbackObjects} fallbacks).`,
    );
    return 0;
  } catch (error) {
    io.error(`mmd2pptx: ${errorMessage(error)}`);
    return 1;
  }
}

async function pathsReferToSameFile(left: string, right: string): Promise<boolean> {
  try {
    const [realLeft, realRight, leftStat, rightStat] = await Promise.all([
      realpath(left),
      realpath(right),
      stat(left),
      stat(right),
    ]);
    return realLeft === realRight
      || (leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino);
  } catch {
    // A new output path normally does not exist yet.
    return false;
  }
}

function defaultOutputPath(inputPath: string, format: CliOutputFormat): string {
  const inputExtension = extname(inputPath);
  const extension = outputExtension(format);
  const suffix = inputExtension.toLowerCase() === extension ? ".normalized" : "";
  return join(
    dirname(inputPath),
    `${basename(inputPath, inputExtension)}${suffix}${extension}`,
  );
}

function outputExtension(format: CliOutputFormat): string {
  switch (format) {
    case "pptx": return ".pptx";
    case "svg": return ".svg";
    case "drawio": return ".drawio";
    case "json-canvas": return ".canvas";
  }
}

async function convertForwardSvg(
  svg: string,
  format: ForwardCliOutputFormat,
  options: ConversionOptions = {},
): Promise<ConversionResult<string>> {
  const parsed = parseMermaidSvg(svg);
  if (parsed.diagnostics.some(({ severity }) => severity === "error")) {
    return { data: "", diagnostics: parsed.diagnostics, summary: parsed.summary };
  }
  const diagram = options.backgroundColor === undefined
    ? parsed.data
    : { ...parsed.data, backgroundColor: options.backgroundColor };
  const exporter = format === "svg"
    ? svgExporter
    : format === "drawio"
      ? drawioExporter
      : jsonCanvasExporter;
  const exported = await exporter.export(diagram, options);
  return {
    ...exported,
    diagnostics: [...parsed.diagnostics, ...exported.diagnostics],
    summary: {
      ...exported.summary,
      fallbackObjects: parsed.summary.fallbackObjects + exported.summary.fallbackObjects,
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
