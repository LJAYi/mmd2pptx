import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";

import { svgStringToPptxBuffer } from "@mmd2pptx/core";

import { HELP_TEXT, parseCliArguments } from "./arguments.js";

export interface CliIo {
  error(message: string): void;
  log(message: string): void;
}

const defaultIo: CliIo = {
  error: (message) => console.error(message),
  log: (message) => console.log(message),
};

export async function runCli(
  argv: string[],
  io: CliIo = defaultIo,
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
    io.error("mmd2pptx: Missing input SVG file.");
    return 2;
  }

  if (extname(inputPath).toLowerCase() !== ".svg") {
    io.error(
      `mmd2pptx: Unsupported input "${basename(inputPath)}". The CLI MVP accepts Mermaid-generated .svg files.`,
    );
    return 2;
  }

  const outputPath = options.outputPath ?? defaultOutputPath(inputPath);
  if (extname(outputPath).toLowerCase() !== ".pptx") {
    io.error("mmd2pptx: The output path must end in .pptx.");
    return 2;
  }

  try {
    const source = await readFile(inputPath, "utf8");
    const result = await svgStringToPptxBuffer(source, {
      ...(options.backgroundColor === undefined
        ? {}
        : { backgroundColor: options.backgroundColor }),
      layout: options.layout,
    });

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

function defaultOutputPath(inputPath: string): string {
  const inputExtension = extname(inputPath);
  return join(
    dirname(inputPath),
    `${basename(inputPath, inputExtension)}.pptx`,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
