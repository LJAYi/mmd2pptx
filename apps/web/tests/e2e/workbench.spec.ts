import { readFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";

// mmd2pptx synthetic fixture: all sources below describe fictional workflows.

test("renders the synthetic default and downloads a non-empty PowerPoint ZIP", async ({
  page,
}, testInfo) => {
  await page.goto("/");

  await expect(page.locator("#render-state b")).toHaveText("Rendered");
  await expect(page.locator("#diagnostic-badge")).toHaveText("Ready");
  await expect(page.locator("#metric-nodes")).toHaveText("9");
  await expect(page.locator("#metric-edges")).toHaveText("10");
  await expect(page.locator("#metric-editable")).toHaveText("39");
  await expect(page.locator("#metric-fallback")).toHaveText("0");
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

test("rerenders after changing the theme and retains the selected slide layout", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("#render-state b")).toHaveText("Rendered");

  await page.locator("#theme").selectOption("forest");
  await expect(page.locator("#theme")).toHaveValue("forest");
  await expect(page.locator("#render-state b")).toHaveText("Rendered");
  await expect(page.locator("#diagnostic-badge")).toHaveText("Ready");
  await expect(page.locator("#preview svg")).toBeVisible();

  await page.locator("#layout").selectOption("standard");
  await expect(page.locator("#layout")).toHaveValue("standard");
  await expect(page.locator("#export")).toBeEnabled();
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

  await page.locator('[data-viewer-action="zoom-in"]').click();
  await expect(page.locator("#viewer-zoom")).toHaveText("120%");
  await expect(canvas).toHaveAttribute("data-scale", "1.2");

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
  await expect(page.locator("#diagnostic-badge")).toHaveText("Ready");
  await expect(page.locator("#export")).toBeEnabled();

  await page.setViewportSize({ height: 844, width: 390 });
  const mobileStageBox = await page.locator("#preview-stage").boundingBox();
  const mobileToolbarBox = await page.locator(".preview-toolbar").boundingBox();
  expect(mobileStageBox).not.toBeNull();
  expect(mobileToolbarBox).not.toBeNull();
  expect(mobileToolbarBox!.width).toBeLessThanOrEqual(mobileStageBox!.width - 16);
});
