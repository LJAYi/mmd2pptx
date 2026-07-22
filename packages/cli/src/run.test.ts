import { access, link, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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

  it("passes the selected PPTX conversion mode to core", async () => {
    await withTemporaryDirectory(async (directory) => {
      const inputPath = join(directory, "diagram.svg");
      const outputPath = join(directory, "diagram.pptx");
      await writeFile(inputPath, SVG, "utf8");
      let selectedMode: string | undefined;
      const dependencies: CliDependencies = {
        async convertSvg(_svg, options) {
          selectedMode = options?.mode;
          return successfulResult();
        },
        async renderMermaid() {
          throw new Error("SVG input must not launch Mermaid");
        },
      };

      expect(await runCli(
        [inputPath, "--mode", "exact", "--output", outputPath],
        recordingIo().io,
        dependencies,
      )).toBe(0);
      expect(selectedMode).toBe("exact");
    });
  });

  it.each([
    { extension: ".svg", format: "svg" as const },
    { extension: ".drawio", format: "drawio" as const },
    { extension: ".canvas", format: "json-canvas" as const },
  ])("exports Mermaid-derived IR as $format", async ({ extension, format }) => {
    await withTemporaryDirectory(async (directory) => {
      const inputPath = join(directory, "diagram.mmd");
      const outputPath = join(directory, `diagram${extension}`);
      await writeFile(inputPath, MMD, "utf8");
      let selectedFormat = "";
      const dependencies: CliDependencies = {
        async convertForward(svg, requestedFormat) {
          expect(svg).toBe(SVG);
          selectedFormat = requestedFormat;
          return successfulTextResult(`forward:${requestedFormat}`);
        },
        async convertSvg() {
          throw new Error("PPTX converter must not run for a forward text format");
        },
        async renderMermaid() {
          return SVG;
        },
      };

      const result = await runCli(
        [inputPath, "--format", format, "--output", outputPath],
        recordingIo().io,
        dependencies,
      );

      expect(result).toBe(0);
      expect(selectedFormat).toBe(format);
      expect(await readFile(outputPath, "utf8")).toBe(`forward:${format}`);
    });
  });

  it("uses a non-destructive default name when normalizing SVG", async () => {
    await withTemporaryDirectory(async (directory) => {
      const inputPath = join(directory, "diagram.svg");
      const outputPath = join(directory, "diagram.normalized.svg");
      await writeFile(inputPath, SVG, "utf8");
      const dependencies: CliDependencies = {
        async convertForward() {
          return successfulTextResult("normalized");
        },
        async convertSvg() {
          throw new Error("PPTX converter must not run");
        },
        async renderMermaid() {
          throw new Error("SVG input must not launch Mermaid");
        },
      };

      expect(await runCli(
        [inputPath, "--format", "svg"],
        recordingIo().io,
        dependencies,
      )).toBe(0);
      expect(await readFile(inputPath, "utf8")).toBe(SVG);
      expect(await readFile(outputPath, "utf8")).toBe("normalized");
    });
  });

  it("rejects an explicitly normalized path that aliases the input", async () => {
    await withTemporaryDirectory(async (directory) => {
      const inputPath = join(directory, "diagram.svg");
      await writeFile(inputPath, SVG, "utf8");
      const output = recordingIo();

      expect(await runCli(
        [inputPath, "--format", "svg", "--output", join(directory, ".", "diagram.svg")],
        output.io,
      )).toBe(2);
      expect(output.errors.join("\n")).toContain("must not overwrite the input");
      expect(await readFile(inputPath, "utf8")).toBe(SVG);
    });
  });

  it("does not overwrite input through an output symlink", async () => {
    await withTemporaryDirectory(async (directory) => {
      const inputPath = join(directory, "diagram.svg");
      const outputPath = join(directory, "diagram.pptx");
      await writeFile(inputPath, SVG, "utf8");
      await symlink(inputPath, outputPath);
      const output = recordingIo();

      expect(await runCli([inputPath, "--output", outputPath], output.io)).toBe(2);
      expect(output.errors.join("\n")).toContain("must not overwrite the input");
      expect(await readFile(inputPath, "utf8")).toBe(SVG);
    });
  });

  it("does not overwrite input through an output hard link", async () => {
    await withTemporaryDirectory(async (directory) => {
      const inputPath = join(directory, "diagram.svg");
      const outputPath = join(directory, "diagram.pptx");
      await writeFile(inputPath, SVG, "utf8");
      await link(inputPath, outputPath);
      const output = recordingIo();

      expect(await runCli([inputPath, "--output", outputPath], output.io)).toBe(2);
      expect(output.errors.join("\n")).toContain("must not overwrite the input");
      expect(await readFile(inputPath, "utf8")).toBe(SVG);
    });
  });

  it("rejects an extension that does not match the selected format", async () => {
    await withTemporaryDirectory(async (directory) => {
      const inputPath = join(directory, "diagram.mmd");
      await writeFile(inputPath, MMD, "utf8");
      const output = recordingIo();

      expect(await runCli(
        [inputPath, "--format", "drawio", "--output", join(directory, "wrong.svg")],
        output.io,
      )).toBe(2);
      expect(output.errors.join("\n")).toContain("must end in .drawio");
    });
  });

  it("rejects PPTX mode for non-PPTX output", async () => {
    await withTemporaryDirectory(async (directory) => {
      const inputPath = join(directory, "diagram.mmd");
      await writeFile(inputPath, MMD, "utf8");
      const output = recordingIo();

      expect(await runCli(
        [inputPath, "--format", "svg", "--mode", "exact"],
        output.io,
      )).toBe(2);
      expect(output.errors.join("\n")).toContain("--mode applies only to PPTX");
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

function successfulTextResult(data: string): ConversionResult<string> {
  return { data, diagnostics: [], summary: emptySummary() };
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
