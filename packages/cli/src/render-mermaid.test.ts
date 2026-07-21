import { access, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { describe, expect, it } from "vitest";

import {
  renderMermaidSourceToSvg,
  type MermaidRenderRuntime,
} from "./render-mermaid.js";

const SOURCE = `%% mmd2pptx synthetic fixture
flowchart LR
  A[Start] --> B[Finish]
`;

const SVG = `<!-- mmd2pptx synthetic fixture -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>`;

describe("renderMermaidSourceToSvg", () => {
  it("returns rendered SVG and removes temporary files after success", async () => {
    let temporaryDirectory: string | undefined;
    const runtime: MermaidRenderRuntime = {
      async render(inputPath, outputPath) {
        temporaryDirectory = dirname(inputPath);
        expect(await readFile(inputPath, "utf8")).toBe(SOURCE);
        await writeFile(outputPath, SVG, "utf8");
      },
    };

    await expect(renderMermaidSourceToSvg(SOURCE, runtime)).resolves.toBe(SVG);
    expect(temporaryDirectory).toBeDefined();
    await expect(access(temporaryDirectory!)).rejects.toThrow();
  });

  it("removes temporary files when rendering fails", async () => {
    let temporaryDirectory: string | undefined;
    const runtime: MermaidRenderRuntime = {
      async render(inputPath) {
        temporaryDirectory = dirname(inputPath);
        throw new Error("synthetic parse error");
      },
    };

    await expect(renderMermaidSourceToSvg(SOURCE, runtime)).rejects.toThrow(
      "Mermaid rendering failed: synthetic parse error",
    );
    expect(temporaryDirectory).toBeDefined();
    await expect(access(temporaryDirectory!)).rejects.toThrow();
  });
});
