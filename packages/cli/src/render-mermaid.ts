import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface MermaidRenderRuntime {
  render(inputPath: string, outputPath: string): Promise<void>;
}

export const defaultMermaidRenderRuntime: MermaidRenderRuntime = {
  async render(inputPath, outputPath) {
    // Keep the browser renderer off the startup path for SVG-only users.
    const { run } = await import("@mermaid-js/mermaid-cli");
    const executablePath = findSystemBrowser();
    await run(inputPath, outputPath as `${string}.svg`, {
      outputFormat: "svg",
      parseMMDOptions: { backgroundColor: "transparent" },
      quiet: true,
      ...(executablePath === undefined
        ? {}
        : { puppeteerConfig: { executablePath, headless: true } }),
    });
  },
};

export async function renderMermaidSourceToSvg(
  source: string,
  runtime: MermaidRenderRuntime = defaultMermaidRenderRuntime,
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "mmd2pptx-"));
  const inputPath = join(directory, "diagram.mmd");
  const outputPath = join(directory, "diagram.svg");

  try {
    await writeFile(inputPath, source, "utf8");
    await runtime.render(inputPath, outputPath);
    return await readFile(outputPath, "utf8");
  } catch (error) {
    throw new Error(`Mermaid rendering failed: ${errorMessage(error)}`, {
      cause: error,
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

function findSystemBrowser(): string | undefined {
  const configured = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (configured) {
    return configured;
  }

  return systemBrowserCandidates().find((candidate) => existsSync(candidate));
}

function systemBrowserCandidates(): string[] {
  if (process.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
  }

  if (process.platform === "win32") {
    const roots = [
      process.env.PROGRAMFILES,
      process.env["PROGRAMFILES(X86)"],
      process.env.LOCALAPPDATA,
    ].filter((root): root is string => Boolean(root));
    return roots.flatMap((root) => [
      join(root, "Google", "Chrome", "Application", "chrome.exe"),
      join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
    ]);
  }

  return [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
  ];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
