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
