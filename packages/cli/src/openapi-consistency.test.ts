import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { HELP_TEXT, parseCliArguments } from "./arguments.js";

const OPENAPI = readFileSync(
  new URL("../../../docs/openapi.yaml", import.meta.url),
  "utf8",
);

describe("CLI and OpenAPI draft consistency", () => {
  it("keeps the same forward formats, PPTX modes, and defaults", () => {
    const formats = inlineEnum("format");
    const modes = inlineEnum("mode");

    expect(formats).toEqual(["pptx", "svg", "drawio", "json-canvas"]);
    expect(modes).toEqual(["smart", "faithful", "exact"]);
    for (const format of formats) {
      expect(parseCliArguments(["diagram.mmd", "--format", format]).format).toBe(format);
      expect(HELP_TEXT).toContain(format);
    }
    for (const mode of modes) {
      expect(parseCliArguments(["diagram.mmd", "--mode", mode]).mode).toBe(mode);
      expect(HELP_TEXT).toContain(mode);
    }
    expect(parseCliArguments(["diagram.mmd"])).toMatchObject({
      format: "pptx",
      layout: "wide",
    });
  });

  it("keeps security and forward-only constraints explicit in the draft", () => {
    expect(OPENAPI).toContain("openapi: 3.1.0");
    expect(OPENAPI).toContain("forward-only");
    expect(OPENAPI).toContain("additionalProperties: false");
    expect(OPENAPI).toContain("maxLength: 200000");
    expect(OPENAPI).toContain('pattern: "^#[0-9A-Fa-f]{6}$"');
    expect(OPENAPI).toContain("Applies only when format is pptx.");
    expect(OPENAPI).toContain("application/problem+json");
    expect(OPENAPI).not.toMatch(/\t/);
  });
});

function inlineEnum(property: string): string[] {
  const match = OPENAPI.match(new RegExp(
    `\\n        ${property}:\\n(?:          [^\\n]*\\n){0,4}?          enum: \\[([^\\]]+)\\]`,
  ));
  if (!match?.[1]) throw new Error(`Missing inline enum for ${property}.`);
  return match[1].split(",").map((value) => value.trim());
}
