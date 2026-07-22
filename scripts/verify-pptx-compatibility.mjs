import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { diagramToPptxBuffer } from "../packages/core/dist/index.js";

const diagram = {
  width: 520,
  height: 260,
  nodes: [
    { id: "input", kind: "roundRect", bounds: { x: 20, y: 30, width: 120, height: 60 }, text: { text: "Input", bounds: { x: 20, y: 30, width: 120, height: 60 } } },
    { id: "process", kind: "rect", bounds: { x: 200, y: 30, width: 120, height: 60 }, text: { text: "Process", bounds: { x: 200, y: 30, width: 120, height: 60 } } },
    { id: "output", kind: "ellipse", bounds: { x: 380, y: 160, width: 120, height: 60 }, text: { text: "Output", bounds: { x: 380, y: 160, width: 120, height: 60 } } },
  ],
  edges: [
    {
      id: "straight",
      sourceId: "input",
      targetId: "process",
      start: { x: 140, y: 60 },
      end: { x: 200, y: 60 },
      path: { segments: [{ kind: "move", to: { x: 140, y: 60 } }, { kind: "line", to: { x: 200, y: 60 } }] },
      dash: "dash",
      endArrow: "triangle",
    },
    {
      id: "orthogonal",
      sourceId: "process",
      targetId: "output",
      start: { x: 260, y: 90 },
      end: { x: 380, y: 190 },
      path: { segments: [
        { kind: "move", to: { x: 260, y: 90 } },
        { kind: "line", to: { x: 260, y: 190 } },
        { kind: "line", to: { x: 380, y: 190 } },
      ] },
      endArrow: "arrow",
    },
    {
      id: "bezier",
      start: { x: 80, y: 90 },
      end: { x: 380, y: 200 },
      path: { segments: [
        { kind: "move", to: { x: 80, y: 90 } },
        { kind: "cubic", control1: { x: 100, y: 230 }, control2: { x: 300, y: 100 }, to: { x: 380, y: 200 } },
        { kind: "arc", radiusX: 40, radiusY: 25, rotation: 0, largeArc: false, sweep: true, to: { x: 460, y: 200 } },
      ] },
      dash: "dot",
      endArrow: "diamond",
    },
  ],
};

const soffice = process.env.SOFFICE ?? "soffice";
const version = spawnSync(soffice, ["--version"], { encoding: "utf8" });
if (version.status !== 0) {
  console.error("LibreOffice/soffice is unavailable; PPTX import verification was not run.");
  process.exit(2);
}

const directory = await mkdtemp(join(tmpdir(), "mmd2pptx-compat-"));
const outputDirectory = join(directory, "pdf");
const profileDirectory = join(directory, "lo-profile");
await mkdir(outputDirectory);
await mkdir(profileDirectory);

try {
  const results = [];
  for (const mode of ["smart", "faithful", "exact"]) {
    const result = await diagramToPptxBuffer(diagram, { mode, title: `Synthetic ${mode}` });
    const errors = result.diagnostics.filter(({ severity }) => severity === "error");
    if (errors.length > 0) throw new Error(`${mode} generation failed: ${JSON.stringify(errors)}`);
    const pptxPath = join(directory, `${mode}.pptx`);
    await writeFile(pptxPath, result.data);
    const conversion = spawnSync(soffice, [
      "--headless",
      `-env:UserInstallation=${pathToFileURL(profileDirectory).href}`,
      "--convert-to",
      "pdf:impress_pdf_Export",
      "--outdir",
      outputDirectory,
      pptxPath,
    ], { encoding: "utf8", timeout: 60_000 });
    const log = `${conversion.stdout ?? ""}\n${conversion.stderr ?? ""}`.trim();
    if (conversion.status !== 0) throw new Error(`${mode} LibreOffice import failed (${conversion.status}): ${log}`);
    if (/repair|corrupt|damaged|fatal error/i.test(log)) {
      throw new Error(`${mode} LibreOffice reported a repair/import problem: ${log}`);
    }
    const pdfPath = join(outputDirectory, `${mode}.pdf`);
    const pdf = await readFile(pdfPath);
    const pdfSize = (await stat(pdfPath)).size;
    if (pdfSize < 1_000 || pdf.subarray(0, 5).toString("ascii") !== "%PDF-") {
      throw new Error(`${mode} produced an empty or invalid PDF (${pdfSize} bytes).`);
    }
    const pdfInfo = spawnSync("pdfinfo", [pdfPath], { encoding: "utf8" });
    const pageMatch = pdfInfo.status === 0 ? /^Pages:\s+(\d+)$/m.exec(pdfInfo.stdout) : undefined;
    const pdfPages = pageMatch ? Number(pageMatch[1]) : undefined;
    if (pdfPages !== undefined && pdfPages < 1) {
      throw new Error(`${mode} produced a PDF with no pages.`);
    }
    results.push({
      diagnostics: result.diagnostics.map(({ code, severity }) => ({ code, severity })),
      mode,
      pdfBytes: pdfSize,
      ...(pdfPages === undefined ? {} : { pdfPages }),
      pptxBytes: result.data.byteLength,
    });
  }
  console.log(JSON.stringify({ libreOffice: version.stdout.trim(), results }, null, 2));
} finally {
  await rm(directory, { force: true, recursive: true });
}
