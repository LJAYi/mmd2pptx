import { readFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";

// mmd2pptx synthetic fixture: all sources below describe fictional workflows.

test("renders the synthetic default and downloads a non-empty PowerPoint ZIP", async ({
  page,
}, testInfo) => {
  await page.goto("/");

  await expect(page.locator("#render-state b")).toHaveText("Rendered");
  await expect(page.locator("#diagnostic-badge")).toContainText("notes");
  await expect(page.locator("#metric-nodes")).toHaveText("9");
  await expect(page.locator("#metric-edges")).toHaveText("10");
  await expect(page.locator("#metric-editable")).toHaveText("28");
  await expect(page.locator("#metric-fallback")).not.toHaveText("0");
  await expect(page.locator("#preview svg")).toBeVisible();

  const downloadPromise = page.waitForEvent("download");
  await page.locator("#export").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("mmd2pptx-diagram.pptx");

  const downloadPath = testInfo.outputPath(download.suggestedFilename());
  await download.saveAs(downloadPath);
  const file = await readFile(downloadPath);

  expect(file.byteLength).toBeGreaterThan(1_000);
  expect([...file.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
  await expect(page.locator("#export span")).toHaveText("Downloaded");
});

test("offers quick links to related diagram editors", async ({ page }) => {
  await page.goto("/");

  const links = [
    { href: "https://mermaid.live/", name: "Mermaid Live" },
    { href: "https://editsvgcode.com/", name: "SVG Code Editor" },
    { href: "https://app.diagrams.net/", name: "diagrams.net" },
  ];

  for (const link of links) {
    const element = page.getByRole("link", { name: new RegExp(link.name, "i") });
    await expect(element).toHaveAttribute("href", link.href);
    await expect(element).toHaveAttribute("target", "_blank");
    await expect(element).toHaveAttribute("rel", "noopener noreferrer");
  }
});

test("blocks export when the Mermaid source is invalid", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#render-state b")).toHaveText("Rendered");

  await page.locator("#source").fill("flowchart LR\n    START[Open --> FINISH[Close]");

  await expect(page.locator("#render-state b")).toHaveText("Syntax error");
  await expect(page.locator("#diagnostic-badge")).toHaveText("Export blocked");
  await expect(page.locator("#diagnostic-list code")).toHaveText("MERMAID_SYNTAX");
  await expect(page.locator("#export")).toBeDisabled();
  await expect(page.locator("#preview svg")).toHaveCount(0);
});

test("preflights formats and exports a non-flowchart only through exact live SVG", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await expect(page.locator("#render-state b")).toHaveText("Rendered");
  await page.locator("#source").fill([
    "sequenceDiagram",
    "  participant A as Client",
    "  participant B as Service",
    "  A->>B: Request",
    "  B-->>A: Response",
  ].join("\n"));
  await expect(page.locator("#render-state b")).toHaveText("Rendered");
  await expect(page.locator("#diagnostic-list code").filter({
    hasText: "PPTX_MODE_UNSUPPORTED_FOR_DIAGRAM_TYPE",
  })).toHaveCount(1);
  await expect(page.locator("#export")).toBeDisabled();

  await page.locator("#pptx-mode").selectOption("exact");
  await expect(page.locator("#metric-editable")).toHaveText("0");
  await expect(page.locator("#diagnostic-title")).toHaveText("Appearance preserved as one SVG");
  await expect(page.locator("#diagnostic-list code").filter({
    hasText: "PPTX_EXACT_SVG_EMBEDDED",
  })).toHaveCount(1);
  await expect(page.locator("#export")).toBeEnabled();
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#export").click();
  const download = await downloadPromise;
  const path = testInfo.outputPath("sequence-exact.pptx");
  await download.saveAs(path);
  expect((await readFile(path)).byteLength).toBeGreaterThan(1_000);

  await page.locator("#export-format").selectOption("svg");
  await expect(page.locator("#diagnostic-list code").filter({
    hasText: "SVG_DIAGRAM_TYPE_UNSUPPORTED",
  })).toHaveCount(1);
  await expect(page.locator("#export")).toBeDisabled();
});

test("disables stale export during source debounce and keeps the latest format preflight", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("#render-state b")).toHaveText("Rendered");
  await page.locator("#source").fill("flowchart LR\n  New[New source] --> Done[Done]");
  await expect(page.locator("#export")).toBeDisabled();
  await expect(page.locator("#render-state b")).toHaveText("Rendered");
  await expect(page.locator("#export")).toBeEnabled();

  await page.locator("#export-format").selectOption("svg");
  await page.locator("#export-format").selectOption("json-canvas");
  await expect(page.locator("#file-suffix")).toHaveText(".canvas");
  await expect(page.locator("#diagnostic-list code").filter({
    hasText: "JSON_CANVAS_BACKGROUND_DOWNGRADED",
  })).toHaveCount(1);
  await expect(page.locator("#diagnostic-list code").filter({
    hasText: "SVG_EDGE_CONNECTIVITY_DOWNGRADED",
  })).toHaveCount(0);
});

test("rerenders after changing the theme and retains the selected slide layout", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("#render-state b")).toHaveText("Rendered");

  await page.locator("#theme").selectOption("forest");
  await expect(page.locator("#theme")).toHaveValue("forest");
  await expect(page.locator("#render-state b")).toHaveText("Rendered");
  await expect(page.locator("#diagnostic-badge")).toContainText("notes");
  await expect(page.locator("#preview svg")).toBeVisible();

  await page.locator("#layout").selectOption("standard");
  await expect(page.locator("#layout")).toHaveValue("standard");
  await expect(page.locator("#export")).toBeEnabled();
});

test("uses Mermaid's default flowchart curve unless the source overrides it", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#render-state b")).toHaveText("Rendered");

  await page.locator("#source").fill([
    "flowchart LR",
    "  A[Alpha] --> B[Beta]",
  ].join("\n"));
  await expect(page.locator("#render-state b")).toHaveText("Rendered");
  await expect(page.locator("#preview g.edgePaths path").first()).toHaveAttribute("d", /C/);

  await page.locator("#source").fill([
    '%%{init: {"flowchart": {"curve": "linear"}}}%%',
    "flowchart LR",
    "  A[Alpha] --> B[Beta]",
  ].join("\n"));
  await expect(page.locator("#render-state b")).toHaveText("Rendered");
  await expect(page.locator("#preview g.edgePaths path").first()).toHaveAttribute("d", /^M[^C]+$/);
});

test("supports pan, zoom, fit, expand, and copy without mutating the export SVG", async ({
  context,
  page,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  await expect(page.locator("#render-state b")).toHaveText("Rendered");

  const canvas = page.locator("#preview-canvas");
  const svg = page.locator("#preview svg");
  const viewport = page.locator("#preview-viewport");
  const svgStateBefore = await svg.evaluate((element) => ({
    style: element.getAttribute("style"),
    transform: element.getAttribute("transform"),
    viewBox: element.getAttribute("viewBox"),
  }));

  await page.locator('[data-viewer-action="reset"]').click();
  await expect(page.locator("#viewer-zoom")).toHaveText("100%");
  const canvasAt100 = await canvas.evaluate((element) => ({
    height: Number.parseFloat((element as HTMLElement).style.height),
    transform: (element as HTMLElement).style.transform,
    width: Number.parseFloat((element as HTMLElement).style.width),
    willChange: getComputedStyle(element).willChange,
  }));
  expect(canvasAt100.transform).toMatch(/^translate\(/);
  expect(canvasAt100.transform).not.toContain("scale");
  expect(canvasAt100.willChange).toBe("auto");

  await page.locator('[data-viewer-action="zoom-in"]').click();
  await expect(page.locator("#viewer-zoom")).toHaveText("120%");
  await expect(canvas).toHaveAttribute("data-scale", "1.2");
  const canvasAt120 = await canvas.evaluate((element) => ({
    height: Number.parseFloat((element as HTMLElement).style.height),
    transform: (element as HTMLElement).style.transform,
    width: Number.parseFloat((element as HTMLElement).style.width),
  }));
  // Browsers serialize CSS pixel lengths to a finite decimal precision.
  expect(Math.abs(canvasAt120.width - canvasAt100.width * 1.2)).toBeLessThan(0.02);
  expect(Math.abs(canvasAt120.height - canvasAt100.height * 1.2)).toBeLessThan(0.02);
  expect(canvasAt120.transform).not.toContain("scale");

  await viewport.dispatchEvent("wheel", { clientX: 100, clientY: 100, deltaY: -100 });
  await expect.poll(async () => Number(await canvas.getAttribute("data-scale"))).toBeGreaterThan(1.2);
  await page.locator('[data-viewer-action="reset"]').click();

  const xBeforePan = Number(await canvas.getAttribute("data-x"));
  await viewport.click({ position: { x: 30, y: 30 } });
  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => Number(await canvas.getAttribute("data-x"))).toBe(xBeforePan - 40);

  const viewportBox = await viewport.boundingBox();
  expect(viewportBox).not.toBeNull();
  await page.mouse.move(viewportBox!.x + 80, viewportBox!.y + 80);
  await page.mouse.down();
  await page.mouse.move(viewportBox!.x + 115, viewportBox!.y + 105, { steps: 3 });
  await page.mouse.up();
  await expect.poll(async () => Number(await canvas.getAttribute("data-x"))).toBe(xBeforePan - 5);

  const xBeforeMultiPointer = Number(await canvas.getAttribute("data-x"));
  await viewport.evaluate((element) => {
    const target = element as HTMLElement;
    target.setPointerCapture = () => undefined;
    target.hasPointerCapture = () => true;
    target.releasePointerCapture = () => undefined;

    target.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true,
      button: 0,
      buttons: 1,
      clientX: 100,
      clientY: 100,
      pointerId: 41,
      pointerType: "touch",
    }));
    target.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true,
      button: 0,
      buttons: 1,
      clientX: 300,
      clientY: 300,
      pointerId: 42,
      pointerType: "touch",
    }));
    target.dispatchEvent(new PointerEvent("pointermove", {
      bubbles: true,
      buttons: 1,
      clientX: 120,
      clientY: 100,
      pointerId: 41,
      pointerType: "touch",
    }));
    target.dispatchEvent(new PointerEvent("pointerup", {
      bubbles: true,
      button: 0,
      clientX: 120,
      clientY: 100,
      pointerId: 41,
      pointerType: "touch",
    }));
  });
  await expect.poll(async () => Number(await canvas.getAttribute("data-x")))
    .toBe(xBeforeMultiPointer + 20);

  await page.locator('[data-viewer-action="zoom-in"]').click();
  await page.locator('[data-viewer-action="fit"]').click();
  await expect(page.locator("#viewer-zoom")).not.toHaveText("120%");
  await page.locator('[data-viewer-action="fit-width"]').click();
  await expect(canvas).toHaveAttribute("data-scale", /.+/);

  await page.locator('[data-viewer-action="expand"]').click();
  await expect(page.locator("#preview-stage")).toHaveClass(/is-expanded/);
  await expect(page.locator('[data-viewer-action="expand"]')).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".shell")).toHaveAttribute("inert", "");
  await page.keyboard.press("Escape");
  await expect(page.locator("#preview-stage")).not.toHaveClass(/is-expanded/);
  await expect(page.locator(".shell")).not.toHaveAttribute("inert", "");

  await page.locator('[data-viewer-action="copy-source"]').click();
  await expect(page.locator("#viewer-feedback")).toHaveText("Mermaid source copied");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("flowchart LR");

  await page.locator('[data-viewer-action="copy-svg"]').click();
  await expect(page.locator("#viewer-feedback")).toHaveText("SVG copied");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("<svg");

  const svgStateAfter = await svg.evaluate((element) => ({
    style: element.getAttribute("style"),
    transform: element.getAttribute("transform"),
    viewBox: element.getAttribute("viewBox"),
  }));
  expect(svgStateAfter).toEqual(svgStateBefore);
  await expect(page.locator("#diagnostic-badge")).toContainText("notes");
  await expect(page.locator("#export")).toBeEnabled();

  await page.setViewportSize({ height: 844, width: 390 });
  const mobileStageBox = await page.locator("#preview-stage").boundingBox();
  const mobileToolbarBox = await page.locator(".preview-toolbar").boundingBox();
  expect(mobileStageBox).not.toBeNull();
  expect(mobileToolbarBox).not.toBeNull();
  expect(mobileToolbarBox!.width).toBeLessThanOrEqual(mobileStageBox!.width - 16);
});
