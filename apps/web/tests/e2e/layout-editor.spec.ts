import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";

const execFileAsync = promisify(execFile);

test("moves a node without changing Mermaid source and persists a layout sidecar", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await expect(page.locator("#render-state b")).toHaveText("Rendered");

  const sourceBefore = await page.locator("#source").inputValue();
  const node = page.locator("#preview g.node").first();
  const edge = page.locator("#preview g.edgePaths path").first();
  await node.scrollIntoViewIfNeeded();
  const nodeBox = await node.boundingBox();
  expect(nodeBox).not.toBeNull();

  await page.locator("#layout-toggle").click();
  await expect(page.locator("#layout-toggle")).toHaveAttribute("aria-pressed", "true");
  await page.mouse.move(nodeBox!.x + nodeBox!.width / 2, nodeBox!.y + nodeBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    nodeBox!.x + nodeBox!.width / 2 - 35,
    nodeBox!.y + nodeBox!.height / 2 + 20,
    { steps: 4 },
  );
  await page.mouse.up();

  await expect(node).toHaveClass(/layout-node-manual/);
  await expect(page.locator("#layout-undo")).toBeEnabled();
  await expect(edge).toHaveAttribute("d", /^M.+ L.+/);
  expect(await page.locator("#source").inputValue()).toBe(sourceBefore);

  await page.locator("#layout-toggle").click();
  await expect(page.locator("#layout-status")).toContainText("Custom layout");

  const downloadPromise = page.waitForEvent("download");
  await page.locator("#layout-export").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("mmd2pptx-diagram.layout.json");
  const path = testInfo.outputPath(download.suggestedFilename());
  await download.saveAs(path);
  const saved = JSON.parse(await readFile(path, "utf8")) as {
    nodes: Array<{ identity: { kind: string }; mode: string }>;
    schema: string;
    version: number;
  };
  expect(saved).toMatchObject({ schema: "mmd2pptx-layout", version: 1 });
  expect(saved.nodes.some(({ mode }) => mode === "manual")).toBe(true);
  expect(saved.nodes.every(({ identity }) => identity.kind !== "id")).toBe(true);

  await page.locator("#layout-reset").click();
  await expect(node).not.toHaveClass(/layout-node-manual/);
  await page.locator("#layout-file").setInputFiles(path);
  await expect(node).toHaveClass(/layout-node-manual/);
});

test("supports layout undo, redo, reset, and preservation after a Mermaid rerender", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("#render-state b")).toHaveText("Rendered");
  const node = page.locator("#preview g.node").first();
  await node.scrollIntoViewIfNeeded();
  const nodeBox = await node.boundingBox();
  expect(nodeBox).not.toBeNull();

  await page.locator("#layout-toggle").click();
  await page.mouse.move(nodeBox!.x + 10, nodeBox!.y + 10);
  await page.mouse.down();
  await page.mouse.move(nodeBox!.x + 50, nodeBox!.y + 25, { steps: 3 });
  await page.mouse.up();
  await expect(node).toHaveClass(/layout-node-manual/);

  await page.locator("#layout-undo").click();
  await expect(node).not.toHaveClass(/layout-node-manual/);
  await page.locator("#layout-redo").click();
  await expect(node).toHaveClass(/layout-node-manual/);

  await page.locator("#theme").selectOption("forest");
  await expect(page.locator("#render-state b")).toHaveText("Rendered");
  await expect(page.locator("#preview g.node").first()).toHaveClass(/layout-node-manual/);

  await page.locator("#layout-reset").click();
  await expect(page.locator("#preview g.node").first()).not.toHaveClass(/layout-node-manual/);
  await page.locator("#layout-toggle").click();
  await expect(page.locator("#layout-status")).toContainText("automatic layout");
});

test("exports the adjusted live diagram to SVG, draw.io, and JSON Canvas", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await expect(page.locator("#render-state b")).toHaveText("Rendered");
  const node = page.locator("#preview g.node").first();
  await node.scrollIntoViewIfNeeded();
  const box = await node.boundingBox();
  expect(box).not.toBeNull();
  await page.locator("#layout-toggle").click();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2 + 70, box!.y + box!.height / 2 + 35);
  await page.mouse.up();

  for (const target of [
    {
      diagnostic: "SVG_EDGE_CONNECTIVITY_DOWNGRADED",
      extension: ".svg",
      marker: "<svg",
      value: "svg",
    },
    {
      diagnostic: "DRAWIO_BACKGROUND_DOWNGRADED",
      extension: ".drawio",
      marker: "<mxfile",
      value: "drawio",
    },
    {
      diagnostic: "JSON_CANVAS_BACKGROUND_DOWNGRADED",
      extension: ".canvas",
      marker: '"nodes"',
      value: "json-canvas",
    },
  ]) {
    await page.locator("#export-format").selectOption(target.value);
    await expect(page.locator("#file-suffix")).toHaveText(target.extension);
    await expect(page.locator("#pptx-mode")).toBeDisabled();
    const downloadPromise = page.waitForEvent("download");
    await page.locator("#export").click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(`mmd2pptx-diagram${target.extension}`);
    const path = testInfo.outputPath(`${target.value}${target.extension}`);
    await download.saveAs(path);
    expect(await readFile(path, "utf8")).toContain(target.marker);
    await expect(page.locator("#diagnostic-list code")).toContainText([
      target.diagnostic,
    ]);
  }

  await page.locator("#export-format").selectOption("pptx");
  await expect(page.locator("#pptx-mode")).toBeEnabled();
  await page.locator("#pptx-mode").selectOption("exact");
  const pptxDownloadPromise = page.waitForEvent("download");
  await page.locator("#export").click();
  const pptxDownload = await pptxDownloadPromise;
  expect(pptxDownload.suggestedFilename()).toBe("mmd2pptx-diagram.pptx");
  const pptxPath = testInfo.outputPath("adjusted-exact.pptx");
  await pptxDownload.saveAs(pptxPath);
  expect([...((await readFile(pptxPath)).subarray(0, 4))]).toEqual([
    0x50, 0x4b, 0x03, 0x04,
  ]);
  const exactSvg = await embeddedSvg(pptxPath);
  expect(exactSvg).not.toContain("layout-overlay");
  expect(exactSvg).not.toContain("data-layout-handle");
});

async function embeddedSvg(path: string): Promise<string> {
  const { stdout: entries } = await execFileAsync("unzip", ["-Z1", path]);
  const svgEntry = entries.split("\n").find((entry) => entry.endsWith(".svg"));
  expect(svgEntry).toBeDefined();
  return (await execFileAsync("unzip", ["-p", path, svgEntry!])).stdout;
}

test("moves edge labels, expands the viewBox, and warns about overlaps", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#render-state b")).toHaveText("Rendered");
  await page.locator("#mini-example").click();
  await expect(page.locator("#render-state b")).toHaveText("Rendered");

  const review = page.locator('#preview g.node[id*="flowchart-Review-"]');
  const draft = page.locator('#preview g.node[id*="flowchart-Draft-"]');
  await review.scrollIntoViewIfNeeded();
  const reviewBox = await review.boundingBox();
  const draftBox = await draft.boundingBox();
  expect(reviewBox).not.toBeNull();
  expect(draftBox).not.toBeNull();
  const labels = page.locator("#preview g.edgeLabels > g.edgeLabel");
  const labelTransformsBefore = await labels.evaluateAll((items) =>
    items.map((item) => item.getAttribute("transform")),
  );
  const viewBoxBefore = await page.locator("#preview svg").getAttribute("viewBox");

  await page.locator("#layout-toggle").click();
  await page.mouse.move(
    reviewBox!.x + reviewBox!.width / 2,
    reviewBox!.y + reviewBox!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    reviewBox!.x + reviewBox!.width / 2 + 420,
    reviewBox!.y + reviewBox!.height / 2,
    { steps: 5 },
  );
  await page.mouse.up();

  const labelTransformsAfter = await labels.evaluateAll((items) =>
    items.map((item) => item.getAttribute("transform")),
  );
  expect(labelTransformsAfter).not.toEqual(labelTransformsBefore);
  const viewBoxAfter = await page.locator("#preview svg").getAttribute("viewBox");
  expect(viewBoxAfter).not.toBe(viewBoxBefore);

  await page.locator("#layout-reset").click();
  const movedReviewBox = await review.boundingBox();
  const currentDraftBox = await draft.boundingBox();
  expect(movedReviewBox).not.toBeNull();
  expect(currentDraftBox).not.toBeNull();
  await page.mouse.move(
    movedReviewBox!.x + movedReviewBox!.width / 2,
    movedReviewBox!.y + movedReviewBox!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    currentDraftBox!.x + currentDraftBox!.width / 2,
    currentDraftBox!.y + currentDraftBox!.height / 2,
    { steps: 5 },
  );
  await page.mouse.up();

  await expect(page.locator("#preview g.node.layout-node-collision")).toHaveCount(2);
  await expect(page.locator("#layout-status")).toContainText("overlapping nodes");
});

test("resizes and keyboard-nudges a node with undoable sidecar geometry", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await expect(page.locator("#render-state b")).toHaveText("Rendered");
  await page.locator("#layout-toggle").click();
  const node = page.locator("#preview g.node").first();
  await node.click({ force: true });
  const handle = page.locator(".layout-resize-handle");
  await expect(handle).toBeVisible();
  const box = await handle.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2 + 30, box!.y + box!.height / 2 + 20);
  await page.mouse.up();

  const downloadPromise = page.waitForEvent("download");
  await page.locator("#layout-export").click();
  const download = await downloadPromise;
  const path = testInfo.outputPath("resized.layout.json");
  await download.saveAs(path);
  const sidecar = JSON.parse(await readFile(path, "utf8")) as {
    nodes: Array<{ bounds: { height: number; width: number; x: number }; mode: string }>;
  };
  const resized = sidecar.nodes.find(({ mode }) => mode === "manual");
  expect(resized).toBeDefined();

  await page.locator("#preview-viewport").focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Shift+ArrowDown");
  const transformAfterNudge = await node.getAttribute("transform");
  await page.locator("#layout-undo").click();
  const transformAfterUndo = await node.getAttribute("transform");
  expect(transformAfterUndo).not.toBe(transformAfterNudge);
  await page.locator("#layout-redo").click();
  await expect(node).toHaveAttribute("transform", transformAfterNudge!);
});

test("edits edge ports, obstacle route, waypoint, and label offset", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page.locator("#render-state b")).toHaveText("Rendered");
  await page.locator("#mini-example").click();
  await expect(page.locator("#render-state b")).toHaveText("Rendered");
  await page.locator("#layout-toggle").click();
  const edge = page.locator("#preview g.edgePaths path").first();
  await edge.click({ force: true });
  await expect(page.locator(".layout-port-handle")).toHaveCount(8);
  await page.locator('[data-layout-handle="edge-port"][data-edge-end="source"][data-port-side="right"]').click({ force: true });
  await expect(page.locator("#layout-route-edge")).toBeEnabled();
  await page.locator("#layout-route-edge").click();

  const waypoint = page.locator(".layout-waypoint-handle");
  const waypointBox = await waypoint.boundingBox();
  expect(waypointBox).not.toBeNull();
  await page.mouse.move(waypointBox!.x + 3, waypointBox!.y + 3);
  await page.mouse.down();
  await page.mouse.move(waypointBox!.x + 28, waypointBox!.y + 23);
  await page.mouse.up();

  const label = page.locator("#preview g.edgeLabels > g.edgeLabel").first();
  const labelBox = await label.boundingBox();
  expect(labelBox).not.toBeNull();
  const labelStart = {
    x: labelBox!.x + labelBox!.width / 2,
    y: labelBox!.y + labelBox!.height / 2,
  };
  await label.dispatchEvent("pointerdown", {
    bubbles: true,
    button: 0,
    buttons: 1,
    clientX: labelStart.x,
    clientY: labelStart.y,
    pointerId: 91,
  });
  await page.locator("#preview-viewport").dispatchEvent("pointermove", {
    bubbles: true,
    buttons: 1,
    clientX: labelStart.x + 24,
    clientY: labelStart.y - 18,
    pointerId: 91,
  });
  await page.locator("#preview-viewport").dispatchEvent("pointerup", {
    bubbles: true,
    button: 0,
    clientX: labelStart.x + 24,
    clientY: labelStart.y - 18,
    pointerId: 91,
  });

  const downloadPromise = page.waitForEvent("download");
  await page.locator("#layout-export").click();
  const download = await downloadPromise;
  const path = testInfo.outputPath("edge-edits.layout.json");
  await download.saveAs(path);
  const sidecar = JSON.parse(await readFile(path, "utf8")) as {
    edges: Array<{ labelOffset?: { x: number; y: number }; points: unknown[]; sourcePort?: string }>;
  };
  expect(sidecar.edges[0]).toMatchObject({ sourcePort: "right" });
  expect(sidecar.edges[0]!.points.length).toBeGreaterThanOrEqual(3);
  expect(sidecar.edges.some(({ labelOffset }) =>
    Math.abs(labelOffset?.x ?? 0) > 0 || Math.abs(labelOffset?.y ?? 0) > 0)).toBe(true);
});

test("auto-recovers a source-specific layout and can clear it", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#render-state b")).toHaveText("Rendered");
  const node = page.locator("#preview g.node").first();
  await page.locator("#layout-toggle").click();
  await node.click({ force: true });
  await page.locator("#preview-viewport").focus();
  await page.keyboard.press("ArrowRight");
  await expect(node).toHaveClass(/layout-node-manual/);
  await expect(page.locator("#layout-clear-saved")).toBeEnabled();

  await page.reload();
  await expect(page.locator("#render-state b")).toHaveText("Rendered");
  await expect(page.locator("#preview g.node").first()).toHaveClass(/layout-node-manual/);
  await page.locator("#mini-example").click();
  await expect(page.locator("#render-state b")).toHaveText("Rendered");
  await expect(page.locator("#preview g.node.layout-node-manual")).toHaveCount(0);

  await page.reload();
  await expect(page.locator("#render-state b")).toHaveText("Rendered");
  await page.locator("#layout-clear-saved").click();
  await expect(page.locator("#preview g.node.layout-node-manual")).toHaveCount(0);
  await expect(page.locator("#layout-clear-saved")).toBeDisabled();
});

test("reconciles manual layout across source edits and cleans removed identities", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await expect(page.locator("#render-state b")).toHaveText("Rendered");
  await page.locator("#source").fill("flowchart LR\n  A[A] --> B[B]");
  await expect(page.locator("#render-state b")).toHaveText("Rendered");
  await page.locator("#layout-toggle").click();
  const nodeA = page.locator('#preview g.node[id*="flowchart-A-"]');
  await nodeA.click({ force: true });
  await page.locator("#preview-viewport").focus();
  await page.keyboard.press("Shift+ArrowRight");
  await expect(nodeA).toHaveClass(/layout-node-manual/);

  await page.locator("#source").fill("flowchart LR\n  A[A] --> B[B]\n  B --> C[C]");
  await expect(page.locator("#render-state b")).toHaveText("Rendered");
  await expect(page.locator('#preview g.node[id*="flowchart-A-"]')).toHaveClass(/layout-node-manual/);
  await expect(page.locator('#preview g.node[id*="flowchart-C-"]')).not.toHaveClass(/layout-node-manual/);

  await page.locator("#source").fill("flowchart LR\n  A[A] --> C[C]");
  await expect(page.locator("#render-state b")).toHaveText("Rendered");
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#layout-export").click();
  const download = await downloadPromise;
  const path = testInfo.outputPath("reconciled.layout.json");
  await download.saveAs(path);
  const sidecar = JSON.parse(await readFile(path, "utf8")) as {
    nodes: Array<{ identity: { value: string }; mode: string }>;
  };
  expect(sidecar.nodes.find(({ identity }) => identity.value === "A")?.mode).toBe("manual");
  expect(sidecar.nodes.some(({ identity }) => identity.value === "B")).toBe(false);
  expect(sidecar.nodes.some(({ identity }) => identity.value === "C")).toBe(true);
});

test("opens Mermaid text files locally", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#render-state b")).toHaveText("Rendered");
  await page.locator("#source-file").setInputFiles({
    buffer: Buffer.from("flowchart TD\n  Upload[Uploaded] --> Ready[Ready]"),
    mimeType: "text/plain",
    name: "upload-demo.mmd",
  });
  await expect(page.locator("#source")).toHaveValue(/Upload\[Uploaded\]/);
  await expect(page.locator("#file-name")).toHaveValue("upload-demo");
  await expect(page.locator("#render-state b")).toHaveText("Rendered");
  await expect(page.locator('#preview g.node[id*="flowchart-Upload-"]')).toBeVisible();
});

test("multi-selects, batch-drags, aligns, distributes, and persists node layers", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await expect(page.locator("#render-state b")).toHaveText("Rendered");
  await page.locator("#mini-example").click();
  await expect(page.locator("#render-state b")).toHaveText("Rendered");
  await page.locator("#layout-toggle").click();
  const idea = page.locator('#preview g.node[id*="flowchart-Idea-"]');
  const draft = page.locator('#preview g.node[id*="flowchart-Draft-"]');
  const review = page.locator('#preview g.node[id*="flowchart-Review-"]');
  await idea.click({ force: true });
  await draft.click({ force: true, modifiers: ["Shift"] });
  await expect(page.locator("#layout-status")).toContainText("2 nodes selected");
  await expect(page.locator("#layout-arrange")).toBeEnabled();

  const ideaBefore = await idea.getAttribute("transform");
  const draftBefore = await draft.getAttribute("transform");
  const box = await idea.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2 + 35, box!.y + box!.height / 2 + 20);
  await page.mouse.up();
  expect(await idea.getAttribute("transform")).not.toBe(ideaBefore);
  expect(await draft.getAttribute("transform")).not.toBe(draftBefore);

  await page.locator("#layout-arrange").selectOption("top");
  await review.click({ force: true, modifiers: ["Shift"] });
  await page.locator("#layout-arrange").selectOption("horizontal");
  await page.locator("#layout-layer").selectOption("front");

  const downloadPromise = page.waitForEvent("download");
  await page.locator("#layout-export").click();
  const download = await downloadPromise;
  const path = testInfo.outputPath("multi-select.layout.json");
  await download.saveAs(path);
  const payload = JSON.parse(await readFile(path, "utf8")) as {
    nodes: Array<{ bounds: { y: number }; identity: { value: string }; zIndex?: number }>;
  };
  const selectedZ = payload.nodes.filter(({ identity }) =>
    identity.value === "Idea" || identity.value === "Draft" || identity.value === "Review")
    .map(({ zIndex }) => zIndex);
  expect(selectedZ).toEqual(expect.arrayContaining([1, 2, 3]));
  const aligned = payload.nodes.filter(({ identity }) =>
    identity.value === "Idea" || identity.value === "Draft");
  expect(new Set(aligned.map(({ bounds }) => bounds.y)).size).toBe(1);

  await page.locator("#layout-layer").selectOption("back");
  await page.locator("#layout-file").setInputFiles(path);
  const lastNodeIds = await page.locator("#preview g.nodes > g.node").evaluateAll((nodes) =>
    nodes.slice(-3).map((node) => node.id),
  );
  expect(lastNodeIds.join(" ")).toContain("flowchart-Idea-");
  expect(lastNodeIds.join(" ")).toContain("flowchart-Draft-");
  expect(lastNodeIds.join(" ")).toContain("flowchart-Review-");
});

test("edits cubic controls without degrading the canonical path", async ({ page }, testInfo) => {
  await page.goto("/");
  await page.locator("#source").fill([
    '%%{init: {"flowchart": {"curve": "basis"}}}%%',
    "flowchart LR",
    "  A[Alpha] --> B[Beta]",
  ].join("\n"));
  await expect(page.locator("#render-state b")).toHaveText("Rendered");
  await page.locator("#layout-toggle").click();
  const edge = page.locator("#preview g.edgePaths path").first();
  await edge.click({ force: true });
  const control = page.locator('[data-layout-handle="edge-control"]').first();
  await expect(control).toBeVisible();
  const before = await edge.getAttribute("d");
  const box = await control.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2 + 45, box!.y + box!.height / 2 + 30);
  await page.mouse.up();
  await expect.poll(() => edge.getAttribute("d")).not.toBe(before);

  const downloadPromise = page.waitForEvent("download");
  await page.locator("#layout-export").click();
  const download = await downloadPromise;
  const path = testInfo.outputPath("curve.layout.json");
  await download.saveAs(path);
  const sidecar = JSON.parse(await readFile(path, "utf8")) as {
    edges: Array<{ path?: { segments: Array<{ kind: string }> } }>;
  };
  expect(sidecar.edges[0]?.path?.segments.some(({ kind }) => kind === "cubic")).toBe(true);
  await page.locator("#export-format").selectOption("svg");
  const svgDownload = page.waitForEvent("download");
  await page.locator("#export").click();
  const exportedSvg = await svgDownload;
  const svgPath = testInfo.outputPath("curve.svg");
  await exportedSvg.saveAs(svgPath);
  expect(await readFile(svgPath, "utf8")).toMatch(/d="[^"]*C/);
  await page.locator("#layout-undo").click();
  await expect.poll(() => edge.getAttribute("d")).toBe(before);
});

test("groups nodes, round-trips the sidecar, exports a container, and ungroups", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await page.locator("#source").fill("flowchart LR\n  A[Alpha] --> B[Beta]\n  B --> C[Gamma]");
  await expect(page.locator("#render-state b")).toHaveText("Rendered");
  await page.locator("#layout-toggle").click();
  const nodes = page.locator("#preview g.node");
  await nodes.nth(0).click();
  await nodes.nth(1).click({ modifiers: ["Shift"] });
  await expect(page.locator("#layout-group")).toBeEnabled();
  await page.locator("#layout-group").click();
  await expect(page.locator("#preview g.layout-custom-group")).toHaveCount(1);

  const sidecarDownload = page.waitForEvent("download");
  await page.locator("#layout-export").click();
  const saved = await sidecarDownload;
  const savedPath = testInfo.outputPath("group.layout.json");
  await saved.saveAs(savedPath);
  const sidecarText = await readFile(savedPath, "utf8");
  const sidecar = JSON.parse(sidecarText) as { groups: Array<{ children: unknown[]; id: string }> };
  expect(sidecar.groups).toMatchObject([{ id: "layout-group-1" }]);
  expect(sidecar.groups[0]?.children).toHaveLength(2);

  await page.locator("#layout-ungroup").click();
  await expect(page.locator("#preview g.layout-custom-group")).toHaveCount(0);
  await page.locator("#layout-file").setInputFiles({
    buffer: Buffer.from(sidecarText),
    mimeType: "application/json",
    name: "group.layout.json",
  });
  await expect(page.locator("#preview g.layout-custom-group")).toHaveCount(1);

  await page.locator("#export-format").selectOption("drawio");
  const drawioDownload = page.waitForEvent("download");
  await page.locator("#export").click();
  const drawio = await drawioDownload;
  const drawioPath = testInfo.outputPath("group.drawio");
  await drawio.saveAs(drawioPath);
  expect(await readFile(drawioPath, "utf8")).toContain("layout-group-1");

  await page.locator("#source").fill("flowchart LR\n  A[Alpha] --> C[Gamma]");
  await expect(page.locator("#render-state b")).toHaveText("Rendered");
  await expect(page.locator("#preview g.layout-custom-group")).toHaveCount(0);
});

test("rejects oversized Mermaid files before reading them", async ({ page }) => {
  await page.goto("/");
  await page.locator("#source-file").setInputFiles({
    buffer: Buffer.alloc(1024 * 1024 + 1, 65),
    mimeType: "text/plain",
    name: "oversized.mmd",
  });
  await expect(page.locator("#render-state b")).toHaveText("File too large");
  await expect(page.locator("#diagnostic-list code")).toHaveText("MERMAID_FILE_TOO_LARGE");
});

test("uses Mermaid source semantics for subgraph membership", async ({ page }, testInfo) => {
  await page.goto("/");
  await page.locator("#source").fill([
    "flowchart LR",
    "  subgraph TEAM[Team]",
    "    A[Alpha] --> B[Beta]",
    "  end",
    "  B --> C[Gamma]",
  ].join("\n"));
  await expect(page.locator("#render-state b")).toHaveText("Rendered");
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#layout-export").click();
  const download = await downloadPromise;
  const path = testInfo.outputPath("subgraph.layout.json");
  await download.saveAs(path);
  const sidecar = JSON.parse(await readFile(path, "utf8")) as {
    groups: Array<{ bounds: { width: number }; children: Array<{ value: string }>; id: string }>;
  };
  const team = sidecar.groups.find(({ id }) => id === "TEAM");
  expect(team?.children.map(({ value }) => value).sort()).toEqual(["A", "B"]);
  await page.locator("#layout-toggle").click();
  await page.locator('[data-layout-handle="group-select"][data-group-id="TEAM"]')
    .click({ force: true });
  await expect(page.locator("#layout-ungroup")).toBeDisabled();
  const outline = page.locator('[data-layout-handle="group-select"][data-group-id="TEAM"]');
  const outlineBox = await outline.boundingBox();
  expect(outlineBox).not.toBeNull();
  await page.mouse.move(outlineBox!.x, outlineBox!.y + outlineBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(outlineBox!.x + 24, outlineBox!.y + outlineBox!.height / 2 + 16);
  await page.mouse.up();
  const resize = page.locator('[data-layout-handle="group-resize"][data-group-id="TEAM"]');
  const resizeBox = await resize.boundingBox();
  expect(resizeBox).not.toBeNull();
  await page.mouse.move(resizeBox!.x + 4, resizeBox!.y + 4);
  await page.mouse.down();
  await page.mouse.move(resizeBox!.x + 34, resizeBox!.y + 24);
  await page.mouse.up();
  const movedDownload = page.waitForEvent("download");
  await page.locator("#layout-export").click();
  const moved = await movedDownload;
  const movedPath = testInfo.outputPath("subgraph-moved.layout.json");
  await moved.saveAs(movedPath);
  const movedSidecar = JSON.parse(await readFile(movedPath, "utf8")) as typeof sidecar;
  const movedTeam = movedSidecar.groups.find(({ id }) => id === "TEAM");
  expect(movedTeam?.children).toHaveLength(2);
  expect(movedTeam?.bounds.width).toBeGreaterThan(team!.bounds.width);
});
