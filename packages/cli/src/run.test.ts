import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ConversionResult } from "@mmd2pptx/core";
import { describe, expect, it } from "vitest";

import { runCli, type CliDependencies, type CliIo } from "./run.js";

const SVG = `<!-- mmd2pptx synthetic fixture -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>`;

const MMD = `%% mmd2pptx synthetic fixture
flowchart LR
  A --> B
`;

describe("runCli", () => {
  it("keeps the direct SVG conversion path compatible", async () => {
    await withTemporaryDirectory(async (directory) => {
      const inputPath = join(directory, "diagram.svg");
      const outputPath = join(directory, "diagram.pptx");
      await writeFile(inputPath, SVG, "utf8");
      let convertedSvg = "";
      const dependencies: CliDependencies = {
        async convertSvg(svg) {
          convertedSvg = svg;
          return successfulResult();
        },
        async renderMermaid() {
          throw new Error("SVG input must not launch Mermaid");
        },
      };

      const result = await runCli(
        [inputPath, "--output", outputPath],
        recordingIo().io,
        dependencies,
      );

      expect(result).toBe(0);
      expect(convertedSvg).toBe(SVG);
      expect([...await readFile(outputPath)]).toEqual([80, 80, 84, 88]);
    });
  });

  it("renders MMD before converting the resulting SVG", async () => {
    await withTemporaryDirectory(async (directory) => {
      const inputPath = join(directory, "diagram.mmd");
      const outputPath = join(directory, "diagram.pptx");
      await writeFile(inputPath, MMD, "utf8");
      let renderedSource = "";
      let convertedSvg = "";
      const dependencies: CliDependencies = {
        async convertSvg(svg) {
          convertedSvg = svg;
          return successfulResult();
        },
        async renderMermaid(source) {
          renderedSource = source;
          return SVG;
        },
      };

      const result = await runCli(
        [inputPath, "--output", outputPath],
        recordingIo().io,
        dependencies,
      );

      expect(result).toBe(0);
      expect(renderedSource).toBe(MMD);
      expect(convertedSvg).toBe(SVG);
      await expect(access(outputPath)).resolves.toBeUndefined();
    });
  });

  it("reports Mermaid rendering errors without writing output", async () => {
    await withTemporaryDirectory(async (directory) => {
      const inputPath = join(directory, "invalid.mmd");
      const outputPath = join(directory, "invalid.pptx");
      await writeFile(inputPath, MMD, "utf8");
      let conversionCalled = false;
      const dependencies: CliDependencies = {
        async convertSvg() {
          conversionCalled = true;
          return successfulResult();
        },
        async renderMermaid() {
          throw new Error("synthetic Mermaid parse failure");
        },
      };
      const output = recordingIo();

      const result = await runCli(
        [inputPath, "--output", outputPath],
        output.io,
        dependencies,
      );

      expect(result).toBe(1);
      expect(conversionCalled).toBe(false);
      expect(output.errors.join("\n")).toContain("synthetic Mermaid parse failure");
      await expect(access(outputPath)).rejects.toThrow();
    });
  });

  it("does not write output when core reports an error diagnostic", async () => {
    await withTemporaryDirectory(async (directory) => {
      const inputPath = join(directory, "diagram.svg");
      const outputPath = join(directory, "diagram.pptx");
      await writeFile(inputPath, SVG, "utf8");
      const dependencies: CliDependencies = {
        async convertSvg() {
          return {
            data: new Uint8Array(),
            diagnostics: [{
              code: "SYNTHETIC_ERROR",
              message: "synthetic conversion failure",
              severity: "error",
            }],
            summary: emptySummary(),
          };
        },
        async renderMermaid() {
          return SVG;
        },
      };
      const output = recordingIo();

      const result = await runCli(
        [inputPath, "--output", outputPath],
        output.io,
        dependencies,
      );

      expect(result).toBe(1);
      expect(output.errors.join("\n")).toContain("SYNTHETIC_ERROR");
      await expect(access(outputPath)).rejects.toThrow();
    });
  });
});

function successfulResult(): ConversionResult<Uint8Array> {
  return {
    data: Uint8Array.from([80, 80, 84, 88]),
    diagnostics: [],
    summary: emptySummary(),
  };
}

function emptySummary() {
  return {
    editableObjects: 0,
    edges: 0,
    fallbackObjects: 0,
    nodes: 0,
  };
}

function recordingIo(): { errors: string[]; io: CliIo; logs: string[] } {
  const errors: string[] = [];
  const logs: string[] = [];
  return {
    errors,
    io: {
      error: (message) => errors.push(message),
      log: (message) => logs.push(message),
    },
    logs,
  };
}

async function withTemporaryDirectory(
  callback: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "mmd2pptx-cli-test-"));
  try {
    await callback(directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}
